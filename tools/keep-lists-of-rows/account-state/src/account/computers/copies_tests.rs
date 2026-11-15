//! What travels between the copies of one account besides each record's current version, at three computers in one
//! process with a link that calls the other computer's `Copies::answer` directly (the forwarder is left out; the
//! full path through it is `tests/placement_copies.rs`):
//! - a row of the account's own rows (`account/rows`) changed at the writer is changed at every computer that may answer
//!   once the writer says the change is done, and stays so through the writer's death;
//! - a computer that only holds a copy gets the records and the vault's sealed secrets, never one of the account's own
//!   rows or the secrets key, and never takes the writer turn; a computer that may answer gets the root sealed to its own key;
//! - a deleted or erased record is gone at every copy (an erased value stays in no copy's history), the versions in
//!   between travel, and a retry after a takeover is answered with its first answer;
//! - a copy that kept a write no writer acknowledged, and was out of reach while another computer took over, rolls it
//!   back when it rejoins;
//! - a vote from a computer whose clock is off by more than the margin is refused;
//! - a computer that only holds a copy keeps every record value and kept reply sealed (no plain value in its store files),
//!   keeps no erased value even sealed, refuses a plain value, and a sealed value moved to another record or opened
//!   with another root does not open; named may-answer later and given the root, it opens and serves what it held.

use super::{
    classify_booted,
    copies::{ComputerStore, Copies, CopiesConfig, Link, StoreOpener, WriteRefused},
    messages::{Answer, Message},
    settings,
    rows_copy::CopiedRows,
    AccountKey, ComputersRow,
};
use crate::{
    account::rows::store::{Family, Row, Store},
    secrets::secrets_key::{self, ComputerKey},
    records::Mutation,
    storage::{record_store::settings::Limits, Storage},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
};

const OWNER: &str = "0bb0000000000000000000000000000000000000000000000000000000000002";
const ACCOUNT: &str = "person";
const RESOURCE: &str = "own-records";
/// The policy database of each computer's account stores, in its folder.
const POLICY: &str = "policy.sqlite";
/// The vault's file in a state folder (src/storage/record_store_resources.json).
const VAULT_FILE: &str = "held-values.sqlite";

/// The computers, by id, and which links are down. A message from or to a down computer is lost; `lose_answer_from` drops
/// the answer of one computer (it took the message, the sender never hears).
#[derive(Default)]
struct Net {
    computers: Mutex<HashMap<String, Arc<Copies>>>,
    down: Mutex<HashSet<String>>,
    /// As an older computer's receiver rejects an unknown readiness message before it runs; stamps and feeds work.
    unsupported_ready: Mutex<HashSet<String>>,
    lose_answer_from: Mutex<Option<String>>,
    /// The next answer from this computer is lost (once), after it took the message.
    lose_next_answer_from: Mutex<Option<String>>,
    /// A complete domain commit was durable, but its one answer was lost.
    lose_next_group_answer_from: Mutex<Option<String>>,
    last_group: Mutex<Option<Message>>,
    lose_finalize_answers: AtomicBool,
    group_bootstraps: std::sync::atomic::AtomicUsize,
    sent: Mutex<Vec<(String, String, &'static str)>>,
    /// The largest message or answer carried, in bytes as it is posted.
    largest: Mutex<usize>,
    /// The computer that goes down once it took part in this many more history messages (it dies in the middle).
    kill_after_history: Mutex<Option<(String, usize)>>,
    /// Run before each push is delivered (while the writer's transaction is still open).
    on_push: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// Computers that hang: a message to one is lost only after `message_wait_ms` (a copy that is dead but not refused).
    hang: Mutex<HashSet<String>>,
    /// Each send to a hanging computer, as `enter` when its wait begins and `leave` when the wait ends: the order of
    /// these events shows what waited at once, with no clock.
    hung_log: Mutex<Vec<(String, &'static str)>>,
    /// A controlled network pause before a stamps answer; votes, pages and other peers still run normally.
    on_stamps: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
    /// Pause an accepted vote's answer after the real voter durably took it, without holding the voter's locks.
    on_vote_answer: Mutex<Option<Arc<dyn Fn(&str, &str) + Send + Sync>>>,
}

struct NetLink {
    me: String,
    net: Arc<Net>,
}

fn kind(message: &Message) -> &'static str {
    match message {
        Message::SettleCommand { .. } => "settle_command",
        Message::SettleCommandPart { .. } => "settle_command_part",
        Message::SettleCommandAnswerPart { .. } => "settle_command_answer_part",
        Message::Group { .. } => "group",
        Message::Vote { .. } => "vote",
        Message::Push { .. } => "push",
        Message::Pull { .. } => "pull",
        Message::History { .. } => "history",
        Message::PushHistory { .. } => "push_history",
        Message::Stamps => "stamps",
        Message::Ready => "ready",
        Message::Vouch { .. } => "vouch",
        Message::CaughtUp { .. } => "caught_up",
        Message::SignIn { .. } => "sign_in",
        Message::SignInPull { .. } => "sign_in_pull",
        Message::Row { .. } => "row",
        Message::Part { .. } => "part",
        Message::AnswerPart { .. } => "answer_part",
        Message::SignInMark { .. } => "sign_in_mark",
        Message::Release { .. } => "release",
        Message::Settle { .. } => "settle",
        Message::Holding { .. } => "holding",
        Message::Tools { .. } => "tools",
        Message::OutsideChanges { .. } => "outside_changes",
    }
}

impl Link for NetLink {
    fn send(&self, to: &str, message: &Message) -> Option<Answer> {
        if matches!(message, Message::Ready) && self.net.unsupported_ready.lock().unwrap().contains(to) {
            return None;
        }
        if self.net.hang.lock().unwrap().contains(to) {
            self.net.hung_log.lock().unwrap().push((to.to_string(), "enter"));
            std::thread::sleep(std::time::Duration::from_millis(settings().message_wait_ms));
            self.net.hung_log.lock().unwrap().push((to.to_string(), "leave"));
            return None;
        }
        {
            let down = self.net.down.lock().unwrap();
            if down.contains(&self.me) || down.contains(to) {
                return None;
            }
        }
        self.net.sent.lock().unwrap().push((self.me.clone(), to.to_string(), kind(message)));
        if matches!(message, Message::Stamps) {
            let hook = self.net.on_stamps.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook(to);
            }
        }
        if matches!(message, Message::Push { .. }) {
            let hook = self.net.on_push.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        let computer = self.net.computers.lock().unwrap().get(to).cloned()?;
        if matches!(message, Message::Group { request: super::messages::GroupRequest::Push { .. } | super::messages::GroupRequest::Prepare {..} }) {
            *self.net.last_group.lock().unwrap() = Some(message.clone());
        }
        if matches!(message, Message::Group { request: super::messages::GroupRequest::Bootstrap { .. } }) {
            self.net.group_bootstraps.fetch_add(1, Ordering::AcqRel);
        }
        let answer = computer.answer(&self.me, message.clone());
        if matches!(message, Message::Group { request: super::messages::GroupRequest::Push { .. } | super::messages::GroupRequest::Prepare {..} }) {
            let mut once = self.net.lose_next_group_answer_from.lock().unwrap();
            if once.as_deref() == Some(to) { *once = None; return None; }
        }
        if matches!(message, Message::Group {request:super::messages::GroupRequest::Finalize {..}}) && self.net.lose_finalize_answers.load(Ordering::Acquire) {return None;}
        if matches!(message, Message::Vote { .. }) && matches!(&answer, Answer::Vote { vote, .. } if vote.accepted) {
            let hook = self.net.on_vote_answer.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook(&self.me, to);
            }
        }
        {
            let posted = serde_json::to_vec(&super::messages::Post { message: message.clone() }).unwrap().len();
            let answered = serde_json::to_vec(&answer).unwrap().len();
            let mut largest = self.net.largest.lock().unwrap();
            *largest = (*largest).max(posted).max(answered);
        }
        if matches!(kind(message), "history" | "push_history") {
            let mut kill = self.net.kill_after_history.lock().unwrap();
            if let Some((victim, left)) = kill.as_mut() {
                if *victim == self.me || victim == to {
                    *left = left.saturating_sub(1);
                    if *left == 0 {
                        self.net.down.lock().unwrap().insert(victim.clone());
                        *kill = None;
                    }
                }
            }
        }
        {
            let mut once = self.net.lose_next_answer_from.lock().unwrap();
            if once.as_deref() == Some(to) {
                *once = None;
                return None;
            }
        }
        if self.net.lose_answer_from.lock().unwrap().as_deref() == Some(to) {
            return None;
        }
        Some(answer)
    }
}

struct Computer {
    id: String,
    key: Arc<ComputerKey>,
    copies: Arc<Copies>,
    view: Arc<CopiedRows>,
    raw: Arc<dyn Storage + Send + Sync>,
    state: PathBuf,
}

impl Computer {
    fn store(&self) -> Store<'_> {
        Store::new(&*self.view)
    }

    fn write(&self, id: &str, value: Value) -> Result<i64, WriteRefused> {
        self.mutate(Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false, value })
            .map(|(sequence, _)| sequence)
    }

    fn mutate(&self, mutation: Mutation) -> Result<(i64, i64), WriteRefused> {
        self.copies.write(|store| write_record!(store, OWNER, RESOURCE, mutation))
            .map(|change| (change.sequence, change.version))
    }

    fn record(&self, id: &str) -> Option<(i64, Value)> {
        self.copies.read(RESOURCE, id).unwrap().record.map(|record| (record.version, record.value))
    }

    /// How many rows of `family` this computer's own rows storage holds.
    fn rows(&self, family: &str) -> usize {
        self.raw.scan(family, &crate::storage::Range::all(), &[crate::storage::Read::whole("id")]).unwrap().len()
    }
}

struct World {
    net: Arc<Net>,
    computers: Vec<Computer>,
    clock: Arc<AtomicI64>,
    root: crate::secrets::SecretsKey,
    account: AccountKey,
    ids: Vec<String>,
    _dir: tempfile::TempDir,
}

/// Three computers A, B, C: all hold a copy and vote; `may_answer` names which of them may answer (by index). A holds the
/// secrets key.
/// The own-records body of `value_text` for `id` (native::body of its stored form, as own_records.rs:1008 writes it).
fn own_body(id: &str, value_text: &str) -> Value {
    use crate::legacy_records::StoredRecord;
    crate::storage::record_store::native::body(&StoredRecord {
        id: id.into(),
        record_type: "note".into(),
        sequence: "2026-11-13T00:00:00Z".into(),
        value_json: value_text.into(),
        meta_json: Some(r#"{"at":"01a1d4c6b0b93320000"}"#.into()),
        protected_key_present: false,
    })
}

fn world(may_answer: &[usize]) -> World {
    world_keeping(may_answer, 1 << 20)
}

/// `world`, whose stores keep a record value up to `record_bytes`.
fn world_keeping(may_answer: &[usize], record_bytes: usize) -> World {
    world_keeping_with_stores(may_answer, record_bytes, None)
}

fn world_keeping_with_stores(may_answer: &[usize], record_bytes: usize, stores: Option<Arc<dyn StoreOpener>>) -> World {
    world_keeping_with_joining(may_answer, record_bytes, stores, None)
}

fn world_keeping_with_joining(may_answer: &[usize], record_bytes: usize, stores: Option<Arc<dyn StoreOpener>>, joining: Option<usize>) -> World {
    world_with_voters(may_answer, &[0, 1, 2], record_bytes, stores, joining)
}

/// `world_keeping_with_joining`, whose account row names the computers at `voters` (by position) as its voters.
fn world_with_voters(may_answer: &[usize], voters: &[usize], record_bytes: usize, stores: Option<Arc<dyn StoreOpener>>, joining: Option<usize>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let account = AccountKey::generate().unwrap();
    let address = account.address();
    let keys: Vec<Arc<ComputerKey>> = (0..3).map(|at| Arc::new(ComputerKey::from_bytes(vec![90 + at as u8; 32]).unwrap())).collect();
    let ids: Vec<String> = keys.iter().map(|key| super::ComputerSigner::of(key).unwrap().computer_id()).collect();
    let answer_ids: Vec<String> = may_answer.iter().map(|at| ids[*at].clone()).collect();
    let voter_ids: Vec<String> = voters.iter().map(|at| ids[*at].clone()).collect();
    let row = ComputersRow::sign_with_voters(&address, 1, &ids, &answer_ids, &voter_ids, &account).unwrap();
    let net = Arc::new(Net::default());
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let root = secrets_key::generate().unwrap();
    let mut computers = Vec::new();
    for at in 0..3 {
        let folder = base.join(["a", "b", "c"][at]);
        std::fs::create_dir_all(&folder).unwrap();
        let raw = crate::account::rows::open(&folder).unwrap();
        classify_booted(&crate::account::rows::store::Store::new(&*raw), ACCOUNT, &ids.iter().map(String::as_str).collect::<Vec<_>>());
        let view = CopiedRows::new(raw.clone());
        let term_clock = clock.clone();
        let copies = Copies::new(
            CopiesConfig { user: "person".into(), stores: stores.clone(),
                address: address.clone(),
                owner: OWNER.to_owned(),
                computer: ids[at].clone(),
                row: row.clone(),
                records: folder.join("records.sqlite"),
                limits: Some(Limits::fixed(record_bytes, 1 << 30)),
                sign_in: raw.clone(),
            },
            Arc::new(NetLink { me: ids[at].clone(), net: net.clone() }),
            Arc::new(move || term_clock.load(Ordering::Acquire)),
        )
        .unwrap()
        .with_vault(folder.join(VAULT_FILE))
        .with_state(folder.clone())
        .with_account_stores(folder.clone(), PathBuf::from(POLICY));
        let held = (at == 0).then(|| secrets_key::open_sent_key(&secrets_key::seal_to_computer(root.as_bytes(), &ids[0]).unwrap(), &keys[0], &settings().computer_id_context).unwrap());
        let copies = copies.with_secrets_key(keys[at].clone(), folder.clone(), held);
        let copies = Arc::new(if joining == Some(at) { copies.joining() } else { copies });
        view.attach(&copies);
        net.computers.lock().unwrap().insert(ids[at].clone(), copies.clone());
        computers.push(Computer { id: ids[at].clone(), key: keys[at].clone(), copies, view, raw, state: folder });
    }
    World { net, computers, clock, root, account, ids, _dir: dir }
}

impl World {
    fn at(&self, name: &str) -> &Computer {
        &self.computers[match name { "A" => 0, "B" => 1, _ => 2 }]
    }

    fn tick(&self, names: &[&str]) {
        for name in names {
            self.at(name).copies.tick();
        }
    }

    fn run(&self, steps: usize, names: &[&str]) {
        for _ in 0..steps {
            self.clock.fetch_add(settings().renew_every_ms, Ordering::AcqRel);
            self.tick(names);
        }
    }

    fn term_runs_out(&self) -> usize {
        ((settings().term_ms + 2 * settings().clock_margin_ms) / settings().renew_every_ms) as usize + 4
    }

    fn set_down(&self, name: &str, down: bool) {
        let id = self.at(name).id.clone();
        let mut set = self.net.down.lock().unwrap();
        if down {
            set.insert(id);
        } else {
            set.remove(&id);
        }
    }

    fn writers(&self) -> Vec<&'static str> {
        ["A", "B", "C"].into_iter().filter(|name| self.at(name).copies.holding().is_some()).collect()
    }

    /// A takes the writer turn and the others follow it (and so catch up with its rows).
    fn start_with_a(&self) {
        self.tick(&["A"]);
        assert_eq!(self.writers(), vec!["A"]);
        self.tick(&["B", "C"]);
    }
}

/// The test's payload: one row of the account's lists, the kind of row each change below copies.
fn list_row(id: &str, text: &str) -> Row<Value> {
    super::rows_copy::test_list_row(ACCOUNT, id, text)
}

/// Whether `computer`'s own rows hold the list row `id`.
fn holds_row(computer: &Computer, id: &str) -> bool {
    super::rows_copy::holds_list_row(&*computer.raw, id)
}

#[test]
fn a_row_removed_at_the_writer_is_gone_at_every_computer_that_may_answer_once_acknowledged() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.at("A").store().insert(Family::Lists, &list_row("test-row", "one")).unwrap();
    for name in ["A", "B", "C"] {
        assert!(holds_row(world.at(name), "test-row"), "the new row is at {name}");
    }
    assert!(world.at("A").store().remove(Family::Lists, "test-row").unwrap(), "the writer acknowledges the change");
    for name in ["A", "B", "C"] {
        assert!(!holds_row(world.at(name), "test-row"), "the removed row is gone at {name} as soon as it is done");
    }
    // A computer that is not the writer cannot make a change of its own.
    assert!(world.at("B").store().insert(Family::Lists, &list_row("at-b", "b")).is_err());
}

#[test]
fn a_computer_that_only_holds_a_copy_gets_no_root_and_no_account_row_and_never_takes_the_writer_role() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.at("A").store().insert(Family::Lists, &list_row("test-row", "one")).unwrap();
    world.at("A").write("r1", json!({"kind": "note", "text": "one"})).unwrap();
    world.at("A").copies.write_vault(|store| {
        write_record!(store, OWNER, crate::secrets::resource().unwrap(), Mutation {
            id: "sealed-value".into(), expected_version: 0, request_key: "v1".into(), deleted: false,
            value: json!({"sealed": "AAAA"}),
        })
    }).unwrap();
    world.run(2, &["A", "B", "C"]);

    // B may answer: it has the account's rows and the root, sealed to its own key in its state folder.
    let b = world.at("B");
    assert!(holds_row(b, "test-row"));
    assert!(b.copies.holds_secrets_key());
    let sealed = std::fs::read(secrets_key::sealed_file(&b.state).unwrap()).unwrap();
    assert_eq!(secrets_key::key_identity(&secrets_key::open(&sealed, &b.key).unwrap()).unwrap(), secrets_key::key_identity(&world.root).unwrap());

    // C only holds a copy: records and sealed secrets, none of the account's rows and nothing to open them with.
    let c = world.at("C");
    assert!(c.record("r1").is_some(), "C holds the records");
    assert!(c.copies.read(crate::secrets::resource().unwrap(), "sealed-value").unwrap().record.is_some(), "C holds the sealed secret");
    assert!(!c.copies.holds_secrets_key(), "C never gets the root");
    assert!(!secrets_key::sealed_file(&c.state).unwrap().exists());
    assert!(!holds_row(c, "test-row"), "C holds no row of the account's");
    assert!(!c.copies.may_admit(), "C admits nothing");
    let to_c: Vec<_> = world.net.sent.lock().unwrap().iter()
        .filter(|(_, to, kind)| *to == c.id && (*kind == "sign_in" || *kind == "sign_in_pull")).cloned().collect();
    assert!(to_c.is_empty(), "no rows message ever went to C: {to_c:?}");
    assert!(matches!(c.copies.answer(&world.at("A").id, Message::SignIn { term: 9, base: 0, after: 0, changes: Vec::new() }),
        Answer::Refused { code, .. } if code == "not_answering"));

    // With A gone, B takes the writer turn; C never does, even when it is the only one ticking.
    world.set_down("A", true);
    world.run(world.term_runs_out(), &["C"]);
    assert!(world.writers().is_empty(), "C never claims");
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_eq!(world.writers(), vec!["B"]);
}

#[test]
fn a_deleted_or_erased_record_is_gone_at_every_copy_and_versions_in_between_travel() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    let first = a.write("gone", json!({"kind": "note", "text": "secret v1"})).unwrap();
    a.mutate(Mutation { id: "gone".into(), expected_version: 1, request_key: "gone-2".into(), deleted: false, value: json!({"kind": "note", "text": "secret v2"}) }).unwrap();
    a.write("deleted", json!({"kind": "note", "text": "to delete"})).unwrap();
    a.mutate(Mutation { id: "deleted".into(), expected_version: 1, request_key: "deleted-2".into(), deleted: true, value: Value::Null }).unwrap();
    // B misses every push (they reach C first), and catches up from the feed: it gets the versions in between too.
    world.set_down("B", true);
    let mut stamps = Vec::new();
    for version in 0..3 {
        let (stamp, _) = a.mutate(Mutation {
            id: "edited".into(), expected_version: version, request_key: format!("edited-{version}"), deleted: false,
            value: json!({"kind": "note", "text": format!("edit {version}")}),
        }).unwrap();
        stamps.push(stamp);
    }
    world.set_down("B", false);
    world.run(1, &["A", "B", "C"]);
    for (at, stamp) in stamps.iter().enumerate() {
        let at_a = a.copies.read_as_of(RESOURCE, "edited", *stamp).unwrap().record.map(|record| record.value);
        let at_b = world.at("B").copies.read_as_of(RESOURCE, "edited", *stamp).unwrap().record.map(|record| record.value);
        assert_eq!(at_b, at_a, "version {at} in between reads the same at B");
        assert!(at_b.is_some());
    }

    a.copies.write(|store| store.erase(OWNER, RESOURCE, "gone")).unwrap();
    world.run(1, &["A", "B", "C"]);
    for name in ["A", "B", "C"] {
        let computer = world.at(name);
        assert_eq!(computer.record("deleted"), None, "the deleted record is gone at {name}");
        assert_eq!(computer.record("gone"), None, "the erased record is gone at {name}");
        assert!(computer.copies.read_as_of(RESOURCE, "gone", first).unwrap().record.is_none(), "no erased value stays in {name}'s history");
    }
}

#[test]
fn a_retry_after_a_takeover_is_answered_with_its_first_answer() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let mutation = Mutation { id: "once".into(), expected_version: 0, request_key: "request-once".into(), deleted: false, value: json!({"kind": "note", "text": "once"}) };
    let first = world.at("A").mutate(mutation.clone()).unwrap();
    world.run(1, &["A", "B", "C"]);
    world.set_down("A", true);
    world.run(world.term_runs_out(), &["B", "C"]);
    let writers = world.writers();
    assert_eq!(writers.len(), 1);
    let again = world.at(writers[0]).mutate(mutation).expect("the retry is answered, not refused as a conflict");
    assert_eq!(again, first, "the same stamp and version as the first answer");
    assert_eq!(world.at(writers[0]).record("once").map(|(version, _)| version), Some(1), "never applied twice");
}

#[test]
fn a_copy_that_kept_a_write_nobody_acknowledged_rolls_it_back_when_it_rejoins() {
    // A keeps its claim back for its whole jitter range below the boundary, so B takes the writer turn: a takeover by A
    // (jitter above about 4000 ms, measured) is the other test below.
    crate::account::computers::JITTER_FOR_TEST.with(|jitter| jitter.set(Some(0)));
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.at("A").write("acked", json!({"kind": "note", "text": "acked"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    // A's next write reaches C, but C's answer is lost and B is out of reach: nobody acknowledges it.
    world.set_down("B", true);
    *world.net.lose_answer_from.lock().unwrap() = Some(world.at("C").id.clone());
    assert_eq!(world.at("A").write("orphan", json!({"kind": "note", "text": "never acknowledged"})), Err(crate::cause!(WriteRefused::NotAcknowledged)));
    *world.net.lose_answer_from.lock().unwrap() = None;
    assert!(world.at("C").record("orphan").is_some(), "C kept the write");
    assert!(world.at("A").record("orphan").is_none());
    // C is out of reach while A and B move on: B takes over and writes.
    world.set_down("C", true);
    world.set_down("B", false);
    world.run(world.term_runs_out(), &["A", "B"]);
    // A's own claim is held back by `claim_backoff_ms` plus a random jitter (`hold_claims`), so once its term has run out A
    // may take the writer turn again before B claims it. Either of the two may take it; C must not.
    let takeover = world.writers();
    assert!(takeover == vec!["A"] || takeover == vec!["B"], "one of A and B takes the writer turn: {takeover:?}");
    let writer = takeover[0];
    world.at(writer).write("after", json!({"kind": "note", "text": "after"})).unwrap();
    // C rejoins: it hears the writer's term, finds it holds more than the writer held when it took over, and rolls back.
    world.set_down("C", false);
    world.run(2, &["B", "A", "C"]);
    for name in ["A", "B", "C"] {
        assert_eq!(world.at(name).record("orphan"), None, "the write nobody acknowledged is gone at {name}");
        assert!(world.at(name).record("acked").is_some() && world.at(name).record("after").is_some(), "{name} holds every acknowledged write");
    }
    assert_eq!(world.at("C").copies.stamp(RESOURCE), world.at(writer).copies.stamp(RESOURCE));
}

#[test]
fn a_copy_that_kept_an_unacknowledged_write_and_a_win_by_the_writer_leaves_it_everywhere_or_nowhere() {
    // A's claim is held back for the longest jitter `hold_claims` can draw: A takes the writer turn again before B does
    // (jitter above about 4000 ms, measured by sweeping it), and A is the writer that rejoins C.
    crate::account::computers::JITTER_FOR_TEST.with(|jitter| jitter.set(Some(u64::MAX)));
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.at("A").write("acked", json!({"kind": "note", "text": "acked"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    world.set_down("B", true);
    *world.net.lose_answer_from.lock().unwrap() = Some(world.at("C").id.clone());
    assert_eq!(world.at("A").write("orphan", json!({"kind": "note", "text": "never acknowledged"})), Err(crate::cause!(WriteRefused::NotAcknowledged)));
    *world.net.lose_answer_from.lock().unwrap() = None;
    assert!(world.at("C").record("orphan").is_some(), "C kept the write");
    world.set_down("C", true);
    world.set_down("B", false);
    world.run(world.term_runs_out(), &["A", "B"]);
    assert_eq!(world.writers(), vec!["A"], "A takes the writer turn again");
    world.at("A").write("after", json!({"kind": "note", "text": "after"})).unwrap();
    world.set_down("C", false);
    world.run(2, &["A", "B", "C"]);
    // The unacknowledged write is either on every copy or on none: C's copy alone is never kept.
    let kept: Vec<bool> = ["A", "B", "C"].iter().map(|name| world.at(name).record("orphan").is_some()).collect();
    assert!(kept.iter().all(|k| *k) || kept.iter().all(|k| !*k), "the unacknowledged write is on {kept:?}");
    for name in ["A", "B", "C"] {
        assert!(world.at(name).record("acked").is_some() && world.at(name).record("after").is_some(), "{name} holds every acknowledged write");
    }
}

#[test]
fn a_vote_from_a_computer_whose_clock_is_off_is_refused() {
    let world = world(&[0, 1, 2]);
    let ask = super::writer_row::Ask { id: format!("{}{}", settings().writer_row_prefix, super::Subject::Account(world.at("A").copies.address().to_string()).row_id()), prior: 0, term: 1, expires_at_ms: 2_000_000 };
    let vote = Message::Vote { ask, stamps: Vec::new() };
    let skew = settings().clock_margin_ms + 1;
    assert_peer_refusal(world.at("B").copies.answer_at(&world.at("C").id, vote.clone(), skew), "clock_skew");
    assert!(matches!(world.at("B").copies.answer_at(&world.at("C").id, vote, 0), Answer::Vote { .. }));
}

/// Every byte of every file in `folder` (the store files and their journals).
fn folder_bytes(folder: &std::path::Path) -> Vec<u8> {
    let mut bytes = Vec::new();
    for entry in std::fs::read_dir(folder).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            bytes.extend(std::fs::read(&path).unwrap());
        }
    }
    bytes
}

fn holds(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// The sealed value a computer keeps as record `id`'s current value.
fn kept_value(computer: &Computer, id: &str) -> Value {
    computer.copies.read(RESOURCE, id).unwrap().record.unwrap().value
}

const MARKER: &str = "plain-marker-7f3a";
const REQUEST_MARKER: &str = "request-marker-91c2";

#[test]
fn a_computer_that_only_holds_a_copy_keeps_no_plain_record_value_in_its_files() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    a.mutate(Mutation { id: "r1".into(), expected_version: 0, request_key: REQUEST_MARKER.into(), deleted: false, value: json!({"kind": "note", "text": format!("{MARKER} v1")}) }).unwrap();
    a.mutate(Mutation { id: "r1".into(), expected_version: 1, request_key: "r1-2".into(), deleted: false, value: json!({"kind": "note", "text": format!("{MARKER} v2")}) }).unwrap();
    a.write("deleted", json!({"kind": "note", "text": format!("{MARKER} deleted")})).unwrap();
    a.mutate(Mutation { id: "deleted".into(), expected_version: 1, request_key: "deleted-2".into(), deleted: true, value: Value::Null }).unwrap();
    a.copies.write_vault(|store| {
        store.mutate_local_with_check(OWNER, crate::secrets::resource().unwrap(), Mutation {
            id: "vault-row".into(), expected_version: 0, request_key: "v1".into(), deleted: false, value: json!({"held": MARKER}),
        }, || Ok(()))
    }).unwrap();
    // C misses the pushes of the next versions and catches up from the feed: the versions in between come sealed too.
    world.set_down("C", true);
    for version in 2..5 {
        a.mutate(Mutation { id: "r1".into(), expected_version: version, request_key: format!("r1-{}", version + 1), deleted: false, value: json!({"kind": "note", "text": format!("{MARKER} v{}", version + 1)}) }).unwrap();
    }
    world.set_down("C", false);
    world.run(2, &["A", "B", "C"]);

    let (b, c) = (world.at("B"), world.at("C"));
    assert_eq!(c.copies.stamp(RESOURCE), a.copies.stamp(RESOURCE), "C is caught up");
    assert_eq!(c.record("r1").map(|(version, _)| version), Some(5), "C holds every version");
    assert!(super::sealed::is_sealed(&kept_value(c, "r1")), "C keeps the value sealed");
    assert_eq!(c.record("deleted"), None, "the deletion is at C");
    let at_c = folder_bytes(&c.state);
    assert!(!holds(&at_c, MARKER), "no plain record or secret in C's files");
    assert!(!holds(&at_c, REQUEST_MARKER), "no plain request key (receipts are sealed) in C's files");
    // B may answer: it keeps them plain, as A does (the scan itself finds a plain value where there is one).
    assert!(holds(&folder_bytes(&b.state), MARKER));
    assert_eq!(b.record("r1"), a.record("r1"));
    // A sealed value names the root it was sealed under.
    assert_eq!(kept_value(c, "r1")["key"], json!(secrets_key::key_identity(&world.root).unwrap()));
}

#[test]
fn an_erased_record_leaves_no_value_sealed_or_plain_at_a_computer_that_only_holds_a_copy() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let first = a.write("gone", json!({"kind": "note", "text": format!("{MARKER} gone v1")})).unwrap();
    a.mutate(Mutation { id: "gone".into(), expected_version: 1, request_key: "gone-2".into(), deleted: false, value: json!({"kind": "note", "text": format!("{MARKER} gone v2")}) }).unwrap();
    world.run(1, &["A", "B", "C"]);
    let c = world.at("C");
    let sealed = kept_value(c, "gone");
    let sealed_bytes = sealed["data"].as_str().unwrap().to_owned();
    let sealed_history = c.copies.read_as_of(RESOURCE, "gone", first).unwrap().record.unwrap().value["data"].as_str().unwrap().to_owned();
    assert!(holds(&folder_bytes(&c.state), &sealed_bytes), "C holds the sealed value before the erase");
    a.copies.write(|store| store.erase(OWNER, RESOURCE, "gone")).unwrap();
    world.run(2, &["A", "B", "C"]);
    assert_eq!(c.record("gone"), None);
    assert!(c.copies.read_as_of(RESOURCE, "gone", first).unwrap().record.is_none(), "no erased version in C's history");
    let at_c = folder_bytes(&c.state);
    assert!(!holds(&at_c, &sealed_bytes) && !holds(&at_c, &sealed_history), "no erased value, not even sealed, in C's files");
    assert!(!holds(&at_c, MARKER));
}

#[test]
fn a_sealed_value_opens_only_as_its_own_record_with_the_accounts_root() {
    use super::sealed::{open_value, At, Part, Refused, SecretsKeys};
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let (r1, _) = a.mutate(Mutation { id: "r1".into(), expected_version: 0, request_key: "r1".into(), deleted: false, value: json!({"kind": "note", "text": "one"}) }).unwrap();
    let r2 = a.write("r2", json!({"kind": "note", "text": "two"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    let (b, c) = (world.at("B"), world.at("C"));
    let sealed_r1 = kept_value(c, "r1");
    let at_r1 = At { owner: OWNER, resource: RESOURCE, id: "r1", version: 1, from: r1, part: Part::Value };
    let roots = SecretsKeys::of(&world.root).unwrap();
    assert_eq!(open_value(&roots, &at_r1, &sealed_r1).unwrap(), json!({"kind": "note", "text": "one"}));
    assert_eq!(open_value(&SecretsKeys::of(&secrets_key::generate().unwrap()).unwrap(), &at_r1, &sealed_r1), Err(crate::cause!(Refused::UnknownSecretsKey)), "a wrong root does not open it");
    let at_r2 = At { id: "r2", from: r2, ..at_r1 };
    assert_eq!(open_value(&roots, &at_r2, &sealed_r1), Err(crate::cause!(Refused::NotOpened)), "moved to another record it does not open");

    // A page that puts r1's sealed value under another record is refused by a computer that may answer, and nothing lands.
    let term = a.copies.holding().unwrap();
    let stamp = b.copies.stamp(RESOURCE);
    let swapped = crate::storage::record_store::follow::Carried {
        change: crate::records::Change { sequence: stamp + 1, id: "r3".into(), version: 1, deleted: false, value: Some(sealed_r1.clone()) },
        receipts: None, erased: false, history: Vec::new(), kept: 0, sealed: false, restored: None,
    };
    let push = |changes| Message::Push { term, resource: RESOURCE.into(), after: stamp, changes, base: 0 };
    assert_peer_refusal(b.copies.answer(&a.id, push(vec![swapped.clone()])), "sealed_value_refused");
    assert_eq!(b.record("r3"), None);
    // A computer that only holds a copy takes no plain value.
    let plain = crate::storage::record_store::follow::Carried {
        change: crate::records::Change { value: Some(json!({"kind": "note", "text": MARKER})), ..swapped.change.clone() },
        ..swapped
    };
    assert_peer_refusal(c.copies.answer(&a.id, push(vec![plain])), "plain_value_refused");
    assert!(!holds(&folder_bytes(&c.state), MARKER));
}

#[test]
fn a_computer_named_to_answer_later_opens_and_serves_what_it_held_sealed() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    a.mutate(Mutation { id: "kept".into(), expected_version: 0, request_key: REQUEST_MARKER.into(), deleted: false, value: json!({"kind": "note", "text": "kept v1"}) }).unwrap();
    let (second, _) = a.mutate(Mutation { id: "kept".into(), expected_version: 1, request_key: "kept-2".into(), deleted: false, value: json!({"kind": "note", "text": "kept v2"}) }).unwrap();
    a.mutate(Mutation { id: "kept".into(), expected_version: 2, request_key: "kept-3".into(), deleted: false, value: json!({"kind": "note", "text": "kept v3"}) }).unwrap();
    a.write("gone", json!({"kind": "note", "text": "gone"})).unwrap();
    a.copies.write(|store| store.erase(OWNER, RESOURCE, "gone")).unwrap();
    world.run(2, &["A", "B", "C"]);
    let c = world.at("C");
    assert!(super::sealed::is_sealed(&kept_value(c, "kept")));

    // The account's row now names C may-answer; C starts again on the same store files with the root sent to it.
    let row = ComputersRow::sign_with_voters(world.at("A").copies.address(), 2, &world.ids, &world.ids, &world.ids, &world.account).unwrap();
    let promoted = Copies::new(
        CopiesConfig { user: "person".into(), stores: None,
            address: row.account.clone(),
            owner: OWNER.to_owned(),
            computer: c.id.clone(),
            row,
            records: c.state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: c.raw.clone(),
        },
        Arc::new(NetLink { me: c.id.clone(), net: world.net.clone() }),
        Arc::new(|| 0),
    )
    .unwrap()
    .with_vault(c.state.join(VAULT_FILE));
    let root = secrets_key::open_sent_key(&secrets_key::seal_to_computer(world.root.as_bytes(), &c.id).unwrap(), &c.key, &settings().computer_id_context).unwrap();
    let promoted = promoted.with_secrets_key(c.key.clone(), c.state.clone(), Some(root));

    // It reads plain what it held: every version, the versions in between, and no erased value.
    let read = |id: &str| promoted.read(RESOURCE, id).unwrap().record.map(|record| (record.version, record.value));
    assert_eq!(read("kept"), a.record("kept"));
    assert_eq!(promoted.read_as_of(RESOURCE, "kept", second).unwrap().record.map(|record| record.value), Some(json!({"kind": "note", "text": "kept v2"})));
    assert_eq!(read("gone"), None);
    assert_eq!(promoted.open_held().unwrap(), 0, "nothing is left sealed");
    // It serves them plain to a computer that may answer (a catch-up before a claim pulls from any computer that holds more).
    match promoted.answer(&world.at("B").id, Message::Pull { writer: false, resource: RESOURCE.into(), after: 0, limit: 32 }) {
        Answer::Page { changes, .. } => {
            assert!(!changes.is_empty());
            for carried in &changes {
                assert!(carried.change.value.as_ref().is_none_or(|value| !super::sealed::is_sealed(value)), "served plain");
                assert!(carried.receipts.as_deref().is_none_or(|text| !super::sealed::is_sealed_text(text)), "receipts served plain");
            }
            let kept = changes.iter().find(|carried| carried.change.id == "kept").unwrap();
            assert!(kept.receipts.as_deref().is_some_and(|text| text.contains("kept-3")), "its receipts opened");
        }
        other => panic!("no page: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Many more versions in between than one change carries.

/// Version `expected + 1` of `id` at the writer: a delete when `delete`, else a note of about 3 KB (sixteen of them do
/// not fit one message, so the versions in between go page by page). Answers its stamp and version.
fn version(computer: &Computer, id: &str, expected: i64, delete: bool) -> (i64, i64) {
    let value = if delete { Value::Null } else { json!({"kind": "note", "text": format!("{MARKER} {id} v{} {}", expected + 1, "x".repeat(3000))}) };
    computer.mutate(Mutation { id: id.into(), expected_version: expected, request_key: format!("{id}-{expected}"), deleted: delete, value }).unwrap()
}

/// The record `id` as of each stamp, at `copies`.
fn as_of_each(copies: &Copies, id: &str, stamps: &[(i64, i64)]) -> Vec<Option<Value>> {
    stamps.iter().map(|(stamp, _)| copies.read_as_of(RESOURCE, id, *stamp).unwrap().record.map(|record| record.value)).collect()
}

#[test]
fn many_more_versions_than_a_change_carries_read_the_same_as_of_at_every_copy() {
    // A and B may answer; C only holds a copy (sealed) and is promoted at the end.
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let mut stamps = Vec::new();
    // B is away for the first thirty versions of x and C for the last thirty: each catches up a long history.
    world.set_down("B", true);
    for expected in 0..60 {
        if expected == 30 {
            world.set_down("B", false);
            world.run(1, &["A", "B", "C"]);
            world.set_down("C", true);
        }
        stamps.push(version(a, "x", expected, expected % 7 == 6));
        if expected % 9 == 0 {
            version(a, "y", expected / 9, false);
        }
    }
    // A record with versions in between, then erased: no value of it stays anywhere.
    let gone: Vec<(i64, i64)> = (0..20).map(|expected| version(a, "gone", expected, false)).collect();
    a.copies.write(|store| store.erase(OWNER, RESOURCE, "gone")).unwrap();
    world.set_down("C", false);
    world.run(2, &["A", "B", "C"]);

    let at_a = as_of_each(&a.copies, "x", &stamps);
    assert_eq!(at_a.iter().filter(|value| value.is_none()).count(), 8, "the deletes read as none");
    assert_eq!(as_of_each(&world.at("B").copies, "x", &stamps), at_a, "every version of x reads the same at B");
    assert!(as_of_each(&world.at("B").copies, "gone", &gone).iter().all(Option::is_none), "no erased version at B");
    let sent = world.net.sent.lock().unwrap().iter().filter(|(_, _, kind)| matches!(*kind, "history" | "push_history")).count();
    assert!(sent > 0, "the versions in between went in history pages");
    let largest = *world.net.largest.lock().unwrap();
    assert!(largest <= settings().message_body_bytes, "every message fits the page bound: {largest}");

    // C kept every version sealed: no plain value in its files.
    let c = world.at("C");
    assert!(!holds(&folder_bytes(&c.state), MARKER), "C's files hold no plain value");
    assert_eq!(c.copies.stamp(RESOURCE), a.copies.stamp(RESOURCE), "C is caught up");
    // Promoted, C opens and reads every version as A does, and no erased one.
    let row = ComputersRow::sign_with_voters(world.at("A").copies.address(), 2, &world.ids, &world.ids, &world.ids, &world.account).unwrap();
    let promoted = Copies::new(
        CopiesConfig { user: "person".into(), stores: None,
            address: row.account.clone(),
            owner: OWNER.to_owned(),
            computer: c.id.clone(),
            row,
            records: c.state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: c.raw.clone(),
        },
        Arc::new(NetLink { me: c.id.clone(), net: world.net.clone() }),
        Arc::new(|| 0),
    )
    .unwrap()
    .with_vault(c.state.join(VAULT_FILE));
    let root = secrets_key::open_sent_key(&secrets_key::seal_to_computer(world.root.as_bytes(), &c.id).unwrap(), &c.key, &settings().computer_id_context).unwrap();
    let promoted = promoted.with_secrets_key(c.key.clone(), c.state.clone(), Some(root));
    assert_eq!(as_of_each(&promoted, "x", &stamps), at_a, "every version of x reads the same at C, promoted");
    assert!(as_of_each(&promoted, "gone", &gone).iter().all(Option::is_none), "no erased version at C");
}

#[test]
fn a_writer_killed_in_the_middle_of_a_history_leaves_no_copy_claiming_it_caught_up() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    world.set_down("B", true);
    let stamps: Vec<(i64, i64)> = (0..40).map(|expected| version(a, "x", expected, expected % 7 == 6)).collect();
    let top = stamps.last().unwrap().0;
    // B comes back and pulls; A dies after the second history page it answers.
    world.set_down("B", false);
    *world.net.kill_after_history.lock().unwrap() = Some((a.id.clone(), 2));
    world.tick(&["B"]);
    assert!(world.net.down.lock().unwrap().contains(&a.id), "A died in the middle of B's history");
    let b = world.at("B");
    assert!(b.copies.stamp(RESOURCE) < top, "B's stamp stays below the change it does not hold whole");
    // What B holds of x is a version A had (a state A passed through), never a mix.
    let held = b.copies.read(RESOURCE, "x").unwrap().record.map(|record| (record.version, record.value));
    let version = held.as_ref().map_or(0, |(version, _)| *version);
    assert!(version > 0 && version < 40, "B holds part of the history: version {version}");
    let made = stamps[usize::try_from(version - 1).unwrap()].0;
    assert_eq!(held.map(|(_, value)| value), a.copies.read_as_of(RESOURCE, "x", made).unwrap().record.map(|record| record.value));
    // B cannot take the writer turn with less than C holds; C (or B, once it caught up from C) does, and the history is whole.
    for step in 0..(2 * world.term_runs_out()) {
        world.run(1, &["B", "C"]);
        let writers = world.writers();
        assert!(writers.len() <= 1, "step {step}: {writers:?}");
        if writers == vec!["B"] {
            assert!(b.copies.stamp(RESOURCE) >= top, "B holds the writer role only once it holds everything");
        }
    }
    assert_eq!(world.writers().len(), 1);
    world.run(1, &["B", "C"]);
    let at_a = as_of_each(&a.copies, "x", &stamps);
    assert_eq!(as_of_each(&b.copies, "x", &stamps), at_a, "every version reads the same at B");
    assert_eq!(as_of_each(&world.at("C").copies, "x", &stamps), at_a, "every version reads the same at C");
}

// ---------------------------------------------------------------------------------------------------------------
// Admitting while no writer is known.

impl World {
    /// Run `ms` of time in steps of `step` ms. Each named computer runs its step when its timer says one is due
    /// (`Copies::next_step_ms`), as a computer's timer thread does. `check` runs after every step with the time run.
    fn run_fine(&self, ms: i64, step: i64, names: &[&str], mut check: impl FnMut(i64)) {
        let mut run = 0;
        while run < ms {
            self.clock.fetch_add(step, Ordering::AcqRel);
            run += step;
            for name in names {
                if self.at(name).copies.next_step_ms() <= 0 {
                    self.at(name).copies.tick();
                }
            }
            check(run);
        }
    }
}

#[test]
fn a_row_removed_stays_removed_at_every_computer_through_a_writer_death_and_takeover() {
    const STEP: i64 = 100;
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    a.store().insert(Family::Lists, &list_row("removed", "removed")).unwrap();
    a.store().insert(Family::Lists, &list_row("kept", "kept")).unwrap();
    assert!(a.store().remove(Family::Lists, "removed").unwrap(), "acknowledged");
    // Every computer's timer runs for a while, then A dies.
    world.run_fine(10_000, STEP, &["A", "B", "C"], |_| {});
    world.set_down("A", true);
    let mut takeover = None;
    world.run_fine(30_000, STEP, &["B", "C"], |now| {
        for name in ["B", "C"] {
            assert!(!holds_row(world.at(name), "removed"), "the removed row stays gone at {name} at {now} ms");
            assert!(holds_row(world.at(name), "kept"), "the kept row stays at {name} at {now} ms");
        }
        if takeover.is_none() && ["B", "C"].iter().any(|name| world.at(name).copies.holding().is_some()) {
            takeover = Some(now);
        }
    });
    let takeover = takeover.expect("B or C took the writer role");
    let s = settings();
    assert!(takeover <= s.term_ms + s.clock_margin_ms + 2 * STEP, "the first computer that may claim claims as the term runs out: {takeover}");
    // The new writer's change reaches the other computer that may answer.
    let writer = world.writers()[0];
    world.at(writer).store().insert(Family::Lists, &list_row("after", "after")).unwrap();
    for name in ["B", "C"] {
        assert!(holds_row(world.at(name), "after"), "the new writer's row is at {name}");
    }
}

#[test]
fn a_computer_cut_off_when_a_row_was_removed_takes_the_removal_through_a_writer_death() {
    const STEP: i64 = 100;
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    a.store().insert(Family::Lists, &list_row("removed", "removed")).unwrap();
    world.run_fine(6_000, STEP, &["A", "B", "C"], |_| {});
    // C is cut off; once it can no longer admit, A removes the row with B alone (a majority with A).
    world.set_down("C", true);
    world.run_fine(settings().admit_ms + 1_000, STEP, &["A", "B"], |_| {});
    assert!(!world.at("C").copies.may_admit());
    assert!(a.store().remove(Family::Lists, "removed").unwrap(), "acknowledged without C");
    assert!(holds_row(world.at("C"), "removed"), "C, cut off, still holds the row");
    // A dies; C comes back and takes the removal from B, the new writer.
    world.set_down("A", true);
    world.set_down("C", false);
    world.run_fine(30_000, STEP, &["B", "C"], |_| {});
    assert_eq!(world.writers(), vec!["B"], "B, which holds the change, takes the writer role");
    for name in ["B", "C"] {
        assert!(!holds_row(world.at(name), "removed"), "the removal is at {name}");
    }
    assert!(world.at("C").copies.may_admit(), "C admits again once it caught up with B");
}

#[test]
fn a_voter_vouches_only_while_no_term_is_live_and_names_it_in_its_votes() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let (b, c) = (world.at("B"), world.at("C"));
    let ask = |computer: &Computer| match computer.copies.answer(&world.at("C").id, Message::Vouch { term: u64::MAX, stamp: u64::MAX }) {
        Answer::Vouch { ms } => ms,
        other => panic!("{other:?}"),
    };
    assert_eq!(ask(b), 0, "B refuses while A's term is live in its row");
    world.set_down("A", true);
    world.clock.fetch_add(settings().term_ms + 2 * settings().clock_margin_ms, Ordering::AcqRel);
    assert_eq!(ask(b), settings().vouch_ms, "the term ran out: B vouches for C");
    // A vote B answers afterwards names C and the time B gave it, so whoever wins with it waits for C.
    let id = super::writer_row::writer_row_id(&super::Subject::Account(b.copies.address().to_string()));
    let prior = b.copies.writer_row().map_or(0, |(_, term, _)| term);
    let now = world.clock.load(Ordering::Acquire);
    let vote = Message::Vote { ask: super::writer_row::Ask { id, prior, term: prior + 1, expires_at_ms: now + settings().term_ms }, stamps: Vec::new() };
    match b.copies.answer(&c.id, vote) {
        Answer::Vote { vouched, .. } => assert!(vouched.iter().any(|(computer, ms)| *computer == c.id && *ms > 0), "{vouched:?}"),
        other => panic!("{other:?}"),
    }
    // Once B took a new term, it vouches for no one until that term runs out too.
    world.at("B").copies.tick();
}

// ---------------------------------------------------------------------------------------------------------------
// The vault's writes are one unit with their acknowledgement, and a restore reaches every copy.

fn naming() -> crate::secrets::VaultIdentity {
    crate::secrets::VaultIdentity::new(crate::account_files::identity::word().unwrap()).unwrap()
}

fn vault_file(computer: &Computer) -> PathBuf {
    computer.state.join(VAULT_FILE)
}

/// The vault at `computer`, on the vault file its copies follow, opened with the secrets key.
fn vault_at(world: &World, computer: &Computer) -> crate::secrets::Secrets<crate::storage::sqlite::Supply<crate::storage::sqlite::Handle>> {
    crate::secrets::Secrets::open(crate::secrets::open_store(&vault_file(computer)).unwrap(), OWNER, &world.root, naming()).unwrap()
}

/// The vault's snapshot record in `computer`'s copy (its version), read from the file by a store of its own.
fn snapshot_version(computer: &Computer) -> Option<i64> {
    computer.copies.read(crate::secrets::resource().unwrap(), "snapshot").unwrap().record.map(|record| record.version)
}

fn secret(text: &str) -> zeroize::Zeroizing<String> {
    zeroize::Zeroizing::new(text.to_owned())
}

/// Every computer's vault file is written only through its copies (`copies::vault_gate`), as at a computer.
fn register_vaults(world: &World) {
    for computer in &world.computers {
        super::copies::register_vault(&computer.copies);
    }
}

#[test]
fn a_vault_write_at_the_writer_commits_only_once_a_majority_holds_it_and_rolls_back_when_none_answers() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");
    let vault = vault_at(&world, a);
    assert_eq!(snapshot_version(a), None, "opening the vault wrote nothing");

    // While the push is out, the write is not visible at the writer: its transaction is not committed.
    let seen = Arc::new(Mutex::new(Vec::new()));
    {
        let (seen, file) = (seen.clone(), vault_file(a));
        *world.net.on_push.lock().unwrap() = Some(Arc::new(move || {
            let store = crate::secrets::open_store(&file).unwrap();
            let held = crate::storage::record_store::RecordStore::held_record_with_version(&store, OWNER, crate::secrets::resource().unwrap(), "snapshot").unwrap().0;
            seen.lock().unwrap().push(held);
        }));
    }
    vault.put("service-token", secret("one")).unwrap();
    *world.net.on_push.lock().unwrap() = None;
    let seen = seen.lock().unwrap().clone();
    assert!(!seen.is_empty() && seen.iter().all(|version| *version == 0), "nothing was visible before the acknowledgement: {seen:?}");
    let written = snapshot_version(a).expect("committed once acknowledged");
    assert_eq!(snapshot_version(world.at("B")).or(snapshot_version(world.at("C"))), Some(written), "a second voter already holds it");
    assert_eq!(vault.plain("service-token").unwrap().as_str(), "one");

    // No voter answers: the write rolls back, nothing of it is visible, and the writer gives its writer turn up.
    world.set_down("B", true);
    world.set_down("C", true);
    assert!(vault.put("service-token", secret("two")).is_err(), "not acknowledged");
    assert!(a.copies.holding().is_none(), "the writer gave its writer role up");
    assert_eq!(snapshot_version(a), Some(written), "the write rolled back");
    assert_eq!(vault.plain("service-token").unwrap().as_str(), "one", "the open vault forgot the write too");
    assert_eq!(vault_at(&world, a).plain("service-token").unwrap().as_str(), "one");
    // A rotation written ahead is refused the same way, and leaves nothing.
    assert!(vault.write_ahead("rotation-one", vec![("service-token".into(), Some(secret("three")))]).is_err());
    assert!(a.copies.read(crate::secrets::resource().unwrap(), "rotation-one").unwrap().record.is_none());
}

#[test]
fn a_vault_write_at_a_computer_that_is_not_the_writer_queues_for_the_writer_and_a_read_there_writes_nothing() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");
    let at_a = vault_at(&world, a);
    at_a.put("service-token", secret("one")).unwrap();
    at_a.write_ahead("rotation-one", vec![("service-token".into(), Some(secret("two")))]).unwrap();
    world.run(1, &["A", "B", "C"]);
    let b = world.at("B");
    let resource = crate::secrets::resource().unwrap();
    let before = (b.copies.stamp(resource), snapshot_version(b));
    assert!(before.1.is_some(), "B follows the vault");

    let at_b = vault_at(&world, b);
    assert_eq!(at_b.plain("service-token").unwrap().as_str(), "one", "B reads its copy");
    assert!(at_b.holds("service-token").unwrap() && at_b.names_only().unwrap() == vec!["service-token".to_owned()]);
    assert!(at_b.put("service-token", secret("at b")).is_ok(), "a write at B is queued for the writer, not refused");
    assert_eq!(at_b.plain("service-token").unwrap().as_str(), "one", "B reads its own copy until the writer settles the queued write");
    assert!(b.copies.has_pending(), "the queued write waits in B's outbox");
    assert!(at_b.create_if_absent("other", secret("x")).is_err(), "a create at B is refused");
    assert!(at_b.remove("service-token").is_err(), "a removal at B is refused");
    assert!(at_b.rotate("rotation-two", vec![("service-token".into(), Some(secret("y")))]).is_err(), "a rotation at B is refused");
    assert!(at_b.settle("rotation-one").is_err(), "settling a pending rotation at B is refused");
    assert_eq!(at_b.settle("rotation-none").unwrap(), false, "nothing pending is answered without a write");
    // A vault opened with another root reads the snapshot as sealed under another key: at B it is not set aside.
    let other = crate::secrets::Secrets::open(crate::secrets::open_store(&vault_file(b)).unwrap(), OWNER, &secrets_key::generate().unwrap(), naming()).unwrap();
    assert!(other.plain("service-token").is_err());
    assert_eq!((b.copies.stamp(resource), snapshot_version(b)), before, "nothing at B was written: no bookkeeping, no rotation, nothing set aside");
    assert!(at_b.plain("service-token").unwrap().as_str() == "one");

    // A copy of the file that no copies follow here is still a copy (it took a writer's term): no write.
    let elsewhere = tempfile::tempdir().unwrap();
    let file = elsewhere.path().canonicalize().unwrap().join(VAULT_FILE);
    std::fs::copy(vault_file(b), &file).unwrap();
    let copied = crate::secrets::Secrets::open(crate::secrets::open_store(&file).unwrap(), OWNER, &world.root, naming()).unwrap();
    assert_eq!(copied.plain("service-token").unwrap().as_str(), "one");
    assert!(copied.put("service-token", secret("elsewhere")).is_err(), "a vault copy is written only through its copies");
    // A vault whose copies are awaited (a computer opens it before they start) is not written either.
    let awaited = tempfile::tempdir().unwrap();
    let file = awaited.path().canonicalize().unwrap().join(VAULT_FILE);
    super::copies::expect_vault(&file);
    let fresh = crate::secrets::Secrets::open(crate::secrets::open_store(&file).unwrap(), OWNER, &world.root, naming()).unwrap();
    assert!(fresh.put("service-token", secret("early")).is_err(), "no write before the copies run");

    // The writer settles the rotation; B follows it.
    assert!(at_a.settle("rotation-one").unwrap());
    world.run(1, &["A", "B", "C"]);
    assert_eq!(at_b.plain("service-token").unwrap().as_str(), "two");
}

#[test]
fn an_acknowledged_vault_write_survives_the_writer_dying_right_after() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");
    vault_at(&world, a).put("service-token", secret("before")).unwrap();
    world.run(1, &["A", "B", "C"]);
    // The last write is acknowledged, then A dies before any computer pulls.
    vault_at(&world, a).put("service-token", secret("after")).unwrap();
    world.set_down("A", true);
    world.run(world.term_runs_out(), &["B", "C"]);
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "{writers:?}");
    let writer = world.at(writers[0]);
    let vault = vault_at(&world, writer);
    assert_eq!(vault.plain("service-token").unwrap().as_str(), "after", "the new writer holds the acknowledged write");
    vault.put("service-token", secret("new writer")).unwrap();
    world.run(1, &["B", "C"]);
    for name in ["B", "C"] {
        assert_eq!(vault_at(&world, world.at(name)).plain("service-token").unwrap().as_str(), "new writer", "{name}");
    }
}

#[test]
fn a_held_value_is_its_own_record_and_reads_at_every_copy_once_settled() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");
    vault_at(&world, a).put("alpha", secret("one")).unwrap();
    vault_at(&world, a).put("beta", secret("two")).unwrap();
    world.run(1, &["A", "B", "C"]);
    for name in ["B", "C"] {
        let computer = world.at(name);
        let vault = vault_at(&world, computer);
        assert_eq!(vault.plain("alpha").unwrap().as_str(), "one", "{name}");
        assert_eq!(vault.plain("beta").unwrap().as_str(), "two", "{name}");
        // Each value is a record of its own in the copy the vault file follows, not one blob inside the snapshot.
        let resource = crate::secrets::resource().unwrap();
        assert!(computer.copies.read(resource, "value:alpha").unwrap().record.is_some(), "{name}: value:alpha is a row");
        assert!(computer.copies.read(resource, "value:beta").unwrap().record.is_some(), "{name}: value:beta is a row");
    }
}

#[test]
fn a_restore_at_the_writer_reads_the_same_at_every_copy_sealed_or_not_and_after_promotion() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let first = a.write("kept", json!({"kind": "note", "text": format!("{MARKER} v1")})).unwrap();
    a.mutate(Mutation { id: "kept".into(), expected_version: 1, request_key: "kept-2".into(), deleted: false, value: json!({"kind": "note", "text": format!("{MARKER} v2")}) }).unwrap();
    a.write("late", json!({"kind": "note", "text": "late v1"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    let erased = a.copies.write(|store| store.erase(OWNER, RESOURCE, "kept")).unwrap().unwrap();
    world.run(1, &["A", "B", "C"]);
    assert_eq!(world.at("B").record("kept"), None);
    // B misses the erase and the restore of "late" and catches up later; every computer holds the erase of "kept".
    world.set_down("B", true);
    let late = a.copies.write(|store| store.erase(OWNER, RESOURCE, "late")).unwrap().unwrap();
    assert!(a.copies.write(|store| store.restore(&late, OWNER, RESOURCE, "late")).unwrap(), "acknowledged by A and C");
    world.set_down("B", false);
    assert!(a.copies.write(|store| store.restore(&erased, OWNER, RESOURCE, "kept")).unwrap(), "the restore is acknowledged");
    world.run(2, &["A", "B", "C"]);

    let (b, c) = (world.at("B"), world.at("C"));
    let restored = a.record("kept").unwrap();
    assert_eq!(restored.1["text"], json!(format!("{MARKER} v2")));
    for id in ["kept", "late"] {
        assert_eq!(b.record(id), a.record(id), "{id} reads the same at B");
        assert_eq!(c.record(id).map(|(version, _)| version), a.record(id).map(|(version, _)| version), "{id}: C holds the restore");
    }
    let as_of = |computer: &Computer, at: i64| computer.copies.read_as_of(RESOURCE, "kept", at).unwrap().record.map(|record| record.value);
    assert_eq!(as_of(b, first), as_of(a, first), "the history came back at B");
    assert!(as_of(a, first).is_some());
    assert_eq!(as_of(b, erased.erased_at), None, "deleted between the erase and the restore, at B as at A");
    assert_eq!(as_of(a, erased.erased_at), None);
    // C keeps it sealed, the history too, and holds no plain value.
    assert!(super::sealed::is_sealed(&kept_value(c, "kept")));
    assert!(as_of(c, first).is_some_and(|value| super::sealed::is_sealed(&value)), "C holds the history back, sealed");
    assert!(!holds(&folder_bytes(&c.state), MARKER), "no plain value at C");

    // C named may-answer, given the root: it opens and reads the restore as A does.
    let row = ComputersRow::sign_with_voters(a.copies.address(), 2, &world.ids, &world.ids, &world.ids, &world.account).unwrap();
    let promoted = Copies::new(
        CopiesConfig { user: "person".into(), stores: None,
            address: row.account.clone(),
            owner: OWNER.to_owned(),
            computer: c.id.clone(),
            row,
            records: c.state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: c.raw.clone(),
        },
        Arc::new(NetLink { me: c.id.clone(), net: world.net.clone() }),
        Arc::new(|| 0),
    )
    .unwrap()
    .with_vault(c.state.join(VAULT_FILE));
    let root = secrets_key::open_sent_key(&secrets_key::seal_to_computer(world.root.as_bytes(), &c.id).unwrap(), &c.key, &settings().computer_id_context).unwrap();
    let promoted = promoted.with_secrets_key(c.key.clone(), c.state.clone(), Some(root));
    for id in ["kept", "late"] {
        let read = promoted.read(RESOURCE, id).unwrap().record.map(|record| (record.version, record.value));
        assert_eq!(read, a.record(id), "{id} reads the same at C, promoted");
    }
    let promoted_as_of = |at: i64| promoted.read_as_of(RESOURCE, "kept", at).unwrap().record.map(|record| record.value);
    assert_eq!(promoted_as_of(first), as_of(a, first));
    assert_eq!(promoted_as_of(erased.erased_at), None);
}

#[test]
fn an_erase_a_copy_kept_that_nobody_acknowledged_is_rolled_back_with_its_receipts() {
    // A keeps its claim back for its whole jitter range below the boundary, so B takes the writer turn: a takeover by A
    // (jitter above about 4000 ms, measured) is the other test below.
    crate::account::computers::JITTER_FOR_TEST.with(|jitter| jitter.set(Some(0)));
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    let first = a.write("victim", json!({"kind": "note", "text": "victim"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    // A's erase reaches C, but C's answer is lost and B is out of reach: nobody acknowledges it.
    world.set_down("B", true);
    *world.net.lose_answer_from.lock().unwrap() = Some(world.at("C").id.clone());
    assert_eq!(a.copies.write(|store| store.erase(OWNER, RESOURCE, "victim")).err(), Some(crate::cause!(WriteRefused::NotAcknowledged)));
    *world.net.lose_answer_from.lock().unwrap() = None;
    assert_eq!(world.at("C").record("victim"), None, "C took the erase");
    world.set_down("C", true);
    world.set_down("B", false);
    world.run(world.term_runs_out(), &["A", "B"]);
    // Either A or B takes the writer turn: A's claim is held back by `claim_backoff_ms` plus a random jitter (`hold_claims`).
    let takeover = world.writers();
    assert!(takeover == vec!["A"] || takeover == vec!["B"], "one of A and B takes the writer turn: {takeover:?}");
    let writer = takeover[0];
    world.at(writer).write("after", json!({"kind": "note", "text": "after"})).unwrap();
    world.set_down("C", false);
    world.run(2, &["B", "A", "C"]);
    let c = world.at("C");
    assert_eq!(c.record("victim"), world.at(writer).record("victim"), "the erase nobody acknowledged is undone at C");
    assert!(c.record("victim").is_some());
    assert_eq!(c.copies.read_as_of(RESOURCE, "victim", first).unwrap().record.map(|record| record.value), Some(json!({"kind": "note", "text": "victim"})));
    // The version made current again keeps its kept replies: C serves them as the writer does.
    match c.copies.answer(&world.at("B").id, Message::Pull { writer: false, resource: RESOURCE.into(), after: 0, limit: 32 }) {
        Answer::Page { changes, .. } => {
            let victim = changes.iter().find(|carried| carried.change.id == "victim").unwrap();
            assert!(victim.receipts.as_deref().is_some_and(|text| text.contains("write-victim")), "receipts kept: {:?}", victim.receipts);
        }
        other => panic!("no page: {other:?}"),
    }
}

#[test]
fn a_dead_copy_first_in_the_order_does_not_delay_the_writer() {
    // Every voter is sent the write at once, each on its own thread (old trillion src/copy-followers.mjs:38): the
    // write commits as soon as a majority holds it, whatever the order of the voters. A dead copy that may answer is
    // waited for once (every computer that may answer holds each acknowledged write it can be reached for,
    // tests/answering_computers_hold_acknowledged_writes.rs), never past `ack_wait_ms`; then no write waits for it until
    // it reports it caught up. A dead copy that may not answer is never waited for.
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    let a = world.at("A");
    let first = world.at("A").copies.row().voters.iter().find(|voter| **voter != a.id).cloned().unwrap();
    let other = world.computers.iter().find(|computer| computer.id != a.id && computer.id != first).unwrap();
    let waits_on_first = || world.net.hung_log.lock().unwrap().iter().filter(|(to, event)| *to == first && *event == "enter").count();
    world.net.hang.lock().unwrap().insert(first.clone());
    let (stamp, _) = version(a, "noticed", 0, false);
    assert!(other.copies.stamp(RESOURCE) >= stamp, "the live copy holds the write");
    // The write sent to the dead copy once; that wait runs on its own thread, so the count is the proof, not a clock.
    let waited = waits_on_first();
    assert_eq!(waited, 1, "the first write sent to the dead copy once");
    // Each later write sends to the dead copy once as well, and still commits on the live copy, whatever that copy does.
    let (stamp, _) = version(a, "fast", 0, false);
    assert!(other.copies.stamp(RESOURCE) >= stamp, "the live copy holds the write");
    assert_eq!(waits_on_first(), waited + 1, "the later write sent to the dead copy once");
    world.net.hang.lock().unwrap().clear();
}

#[test]
fn two_computers_that_may_answer_and_both_moved_settle_their_records_to_one_root_through_the_forwarder() {
    use crate::storage::record_store::record_sync::{Actor, SettleStore};
    let world = world(&[0, 1]);
    world.start_with_a();
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    let note = |text: &str| match json!({ "text": text }) { Value::Object(map) => Some(map), _ => None };
    for (computer, prefix) in [(a, "a"), (b, "b")] {
        let mut store = computer.copies.settle_store(RESOURCE).unwrap();
        for n in 0..20 {
            store.write(&[(&format!("{prefix}-{n}"), "note", note(prefix))], Actor::by("person")).unwrap();
        }
    }
    let settled = b.copies.settle(&a.id, RESOURCE).unwrap();
    assert!(settled.equal, "{settled:?}");
    let root = |computer: &Computer| computer.copies.settle_store(RESOURCE).unwrap().checksum().unwrap().root;
    assert_eq!(root(a), root(b));
    assert_eq!(a.copies.settle_store(RESOURCE).unwrap().read("b-19").unwrap(), note("b"));
    // Again: equal roots answer it in one request, and nothing is written.
    let again = b.copies.settle(&a.id, RESOURCE).unwrap();
    assert!(again.equal && again.requests == 1 && again.sent == 0 && again.took == 0, "{again:?}");
    // Every resource this computer follows settles on its own.
    assert!(b.copies.settle_all(&a.id).iter().all(|(_, settled)| settled.as_ref().is_ok_and(|settled| settled.equal)));
    // A computer that only holds a copy keeps its records sealed: no plain settle with it, either way.
    assert_eq!(c.copies.settle(&a.id, RESOURCE).unwrap_err().status, 403);
    assert_eq!(a.copies.settle(&c.id, RESOURCE).unwrap_err().status, 403);
}

/// The computers that write for the account now.
fn writers(world: &World) -> Vec<&'static str> {
    world.writers()
}

/// A write on an account with no writer turn is refused `NotWriter` and asks the timer for it (`claim_for_write`): the timer
/// step takes the turn at the computer that asked. A test that writes first takes the turn this way, as a live account does.
fn prime_writer(world: &World, name: &str) {
    assert!(world.at(name).write("prime-turn", json!({"kind": "note", "text": "asks for the turn"})).is_err(), "the first write is refused NotWriter");
    world.at(name).copies.tick();
    assert_eq!(writers(world).len(), 1, "the timer took the writer turn");
}

/// Step the clock by `renew_every_ms` up to `ms`, running each named computer's step as the computer's timer does
/// (`step_if_active`); answers how many renewal votes were sent meanwhile.
fn run_timer(world: &World, ms: i64, names: &[&str]) -> usize {
    let votes = || world.net.sent.lock().unwrap().iter().filter(|(_, _, kind)| *kind == "vote").count();
    let before = votes();
    let mut passed = 0;
    while passed < ms {
        world.clock.fetch_add(settings().renew_every_ms, Ordering::AcqRel);
        passed += settings().renew_every_ms;
        for name in names {
            world.at(name).copies.step_if_active();
        }
    }
    votes() - before
}

#[test]
fn a_write_during_the_first_claim_waits_for_the_timer_and_goes_through() {
    let world = world(&[0, 1, 2]);
    // The first write asks for the writer turn and waits; the timer (run here on another thread) takes it, and the write goes through.
    let copies = world.at("A").copies.clone();
    let timer = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        copies.tick();
    });
    world.at("A").write("during-claim", json!({"kind": "note", "text": "written while the claim ran"})).expect("the write waits for the claim");
    timer.join().unwrap();
    assert_eq!(writers(&world), vec!["A"]);
    assert!(world.at("A").record("during-claim").is_some());
}

#[test]
fn a_write_whose_claim_the_timer_does_not_take_in_time_is_not_started_and_writes_nothing() {
    let world = world(&[0, 1, 2]);
    let refused = world.at("A").write("never-claimed", json!({"kind": "note", "text": "no timer ran"}));
    assert!(matches!(refused, Err(WriteRefused::NotStarted(_))), "{refused:?}");
    assert!(world.at("A").record("never-claimed").is_none(), "nothing was written");
}

#[test]
fn an_idle_account_holds_no_term_and_its_next_write_claims_it_again() {
    let world = world(&[0, 1, 2]);
    // No step has run: the first write is refused and asks the timer for the writer turn, which one timer step takes.
    assert!(writers(&world).is_empty());
    prime_writer(&world, "A");
    world.at("A").write("r1", json!({"kind": "note", "text": "first"})).expect("the first write goes through once the timer took the turn");
    assert_eq!(writers(&world), vec!["A"]);
    // While requests come, the writer turn is renewed.
    let renewed = run_timer(&world, 30_000, &["A", "B", "C"]);
    assert!(renewed > 0, "an active account renews its term");
    assert_eq!(writers(&world), vec!["A"]);
    // No request for 61 s: the writer turn is given up, the term ran out at every voter, and from then on nothing renews it.
    run_timer(&world, settings().idle_release_ms + 1_000 - 30_000, &["A", "B", "C"]);
    assert!(writers(&world).is_empty(), "an idle account holds no term");
    let now = world.clock.load(Ordering::Acquire);
    for name in ["A", "B", "C"] {
        let (_, _, ends) = world.at(name).copies.writer_row().expect("the row stays");
        assert!(ends < now, "the term ran out at {name}");
        assert!(world.at(name).copies.idle());
    }
    assert_eq!(run_timer(&world, 30_000, &["A", "B", "C"]), 0, "an idle account sends no renewal");
    // The next write claims the writer turn again, at a computer that may answer.
    prime_writer(&world, "B");
    world.at("B").write("r2", json!({"kind": "note", "text": "after a pause"})).expect("the next write succeeds");
    assert_eq!(writers(&world), vec!["B"]);
    assert_eq!(world.at("B").record("r1").map(|(version, _)| version), Some(1), "the new writer holds every acknowledged write");
    // A read at a computer that is not the writer wakes it and it admits from its copy again (it catches up).
    world.at("C").copies.wake();
    assert!(world.at("C").copies.may_admit());
}

#[test]
fn after_an_idle_pause_a_write_with_one_voter_stopped_follows_the_majority_rules() {
    let world = world(&[0, 1, 2]);
    prime_writer(&world, "A");
    world.at("A").write("r1", json!({"kind": "note", "text": "first"})).unwrap();
    run_timer(&world, settings().idle_release_ms + 1_000, &["A", "B", "C"]);
    assert!(writers(&world).is_empty());
    // C is stopped: A and B are a majority of the three voters, so B's write claims and is acknowledged.
    world.set_down("C", true);
    prime_writer(&world, "B");
    world.at("B").write("r2", json!({"kind": "note", "text": "two of three"})).expect("a majority holds it");
    assert_eq!(writers(&world), vec!["B"]);
    run_timer(&world, settings().idle_release_ms + 1_000, &["A", "B"]);
    assert!(writers(&world).is_empty());
    // With A stopped too, B alone is no majority: its write is refused and nothing of it is kept.
    world.set_down("A", true);
    assert!(world.at("B").write("r3", json!({"kind": "note", "text": "alone"})).is_err(), "one voter of three never writes");
    assert!(writers(&world).is_empty());
    assert_eq!(world.at("B").record("r3"), None);
}

/// Stage 3 item 5: a change larger than one message between computers travels in parts. Before, a change had to fit one
/// message of 40,000 bytes: one record of 50,000 characters was refused (measured, step 14), while a store keeps a
/// record of up to 8 MiB, the person's account holds 7,567 rows over 36 KB (the largest
/// 4.26 MB), and its vault snapshot is about 0.98 MB. Old trillion carried a row up to 16 MiB as a page of its own
/// (src/resource-state-carry.mjs:11 `ROW_BYTES`). Here a 4.3 MB record and a 1 MB vault value are acknowledged with
/// copies running: each goes to the other computers in parts within one message's bound, both copies hold it whole, a computer
/// that only holds a copy gets it sealed, and a copy that pulls it later (a long page answer) takes it in parts too.
#[test]
fn a_record_of_4_3_mb_and_a_1_mb_vault_write_are_acknowledged_in_parts() {
    let world = world_keeping(&[0, 1], 8 << 20);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");

    let big: String = (0..4_300_000).map(|at| char::from(b'a' + (at % 26) as u8)).collect();
    let stamp = a.write("big-record", json!({"kind": "note", "text": big})).expect("the 4.3 MB record is acknowledged");
    assert!(a.copies.holding().is_some(), "the writer keeps writing");
    let held_by = ["B", "C"].into_iter().filter(|name| world.at(name).copies.stamp(RESOURCE) >= stamp).count();
    assert!(held_by >= 1, "a second voter holds it when the write returns");
    let bound = settings().message_body_bytes;
    let largest = *world.net.largest.lock().unwrap();
    assert!(largest <= bound, "every message and answer is within one message's bound: {largest}");
    let parts = world.net.sent.lock().unwrap().iter().filter(|(_, _, kind)| *kind == "part").count();
    assert!(parts >= 4_300_000 / bound, "it went in parts: {parts}");

    // The vault: one secret is at most 64 KiB, so a vault of about 1 MB holds many (the person's snapshot is about
    // 0.98 MB). Its snapshot is one record, written whole on each change: each write below sends all of it, the last
    // one over 1 MB, acknowledged the same way.
    let vault = vault_at(&world, a);
    let value = |n: usize| -> String { (0..50_000).map(|at| char::from(b'A' + ((at + n) % 26) as u8)).collect() };
    for n in 0..20 {
        vault.put(&format!("large-token-{n}"), secret(&value(n))).expect("each vault write is acknowledged");
    }
    let written = snapshot_version(a).expect("committed");
    assert!(std::fs::metadata(vault_file(a)).unwrap().len() > 1_000_000, "the vault is over 1 MB");
    assert!(snapshot_version(world.at("B")) == Some(written) || snapshot_version(world.at("C")) == Some(written));

    // Every computer catches up: B (it may answer) reads both whole; C (a copy only) holds the record sealed, never plain.
    world.run(2, &["A", "B", "C"]);
    let b = world.at("B");
    assert_eq!(b.record("big-record").map(|(_, value)| value["text"].as_str().map(str::len)), Some(Some(4_300_000)));
    assert_eq!(vault_at(&world, b).plain("large-token-19").unwrap().as_str(), value(19));
    let c = world.at("C");
    assert_eq!(c.copies.stamp(RESOURCE), a.copies.stamp(RESOURCE), "the copy that only holds caught up");
    assert!(!holds(&folder_bytes(&c.state), &big[..64]), "no plain value at a computer that only holds a copy");

    // A computer that was away pulls the long change later: the writer's page is answered in parts.
    world.set_down("B", true);
    let again: String = big.chars().rev().collect();
    let stamp = a.write("big-record-2", json!({"kind": "note", "text": again})).expect("acknowledged by C");
    world.set_down("B", false);
    world.run(2, &["A", "B", "C"]);
    assert!(b.copies.stamp(RESOURCE) >= stamp, "B pulled it");
    assert_eq!(b.record("big-record-2").map(|(_, value)| value["text"].as_str().map(str::len)), Some(Some(4_300_000)));
    assert!(*world.net.largest.lock().unwrap() <= bound);
}

/// Plan 4a, B-2 (PR 2): a write of class `crdt-merge` commits at a computer that does
/// not hold the writer turn, with no acknowledgement, and reads back there at once. A lease-writer write at the same
/// computer is still refused: only the class that merges by stamps moves off the writer turn.
#[test]
fn a_crdt_merge_write_commits_at_a_computer_without_the_writer_turn() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let b = world.at("B");
    assert_eq!(writers(&world), vec!["A"], "A holds the writer turn; B does not");
    let key = "@list/groceries";
    let mutation = Mutation { id: "row-1".to_owned(), expected_version: 0, request_key: "merge-row-1".to_owned(), deleted: false,
        value: json!({"kind": "note", "text": "MERGE_TEXT"}) };
    b.copies.write_in_class(key, &crate::account::computers::ScopeClass::parse("crdt-merge").unwrap(), |store| write_record!(store, OWNER, key, mutation))
        .unwrap_or_else(|refused| panic!("a crdt-merge write commits without the writer turn: {refused:?}"));
    let read = b.copies.read(key, "row-1").unwrap().record;
    assert_eq!(read.map(|record| record.value["text"].clone()), Some(json!("MERGE_TEXT")), "B reads its own write at once");
    assert!(b.write("note-b", json!({"kind": "note", "text": "LEASE_TEXT"})).is_err(), "a lease-writer write still needs the writer turn");
}

/// Stage 3 item 6: copies follow every store of the account. Before, `CopiesConfig.records` was one path and every
/// resource but the vault was kept in it, so a list (`@list/<id>`, its own file `list-<id>.sqlite`), an own work
/// (`@own-work/<id>`) and a further store of a volume (the storage audit's overflow stores, `<book>.overflow-1.sqlite`,
/// which hold the same resource names as the book) had no copy at a second computer, or were written into the wrong file
/// there. Now each is written at the writer in the file its placement row names, acknowledged by a second copy, and
/// kept at every other computer in the same file: plain where the computer may answer, sealed where it only holds a copy.
#[test]
fn copies_follow_every_store_of_the_account() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let mutation = |id: &str, text: &str| Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false,
        value: json!({"kind": "note", "text": text}) };
    let written = [
        ("@list/groceries", "list-groceries.sqlite", "row-1", "LIST_ROW_TEXT"),
        ("@own-work/plan", "own-work-plan.sqlite", "step-1", "OWN_WORK_TEXT"),
        ("overflow:1/own-records", "records.overflow-1.sqlite", "taken-1", "OVERFLOW_TEXT"),
    ];
    a.write("note-1", json!({"kind": "note", "text": "BOOK_TEXT"})).unwrap();
    for (key, _, id, text) in written {
        let name = key.rsplit_once("1/").map_or(key, |(_, name)| name);
        a.copies.write_in(key, |store| write_record!(store, OWNER, name, mutation(id, text)))
            .unwrap_or_else(|refused| panic!("{key} is acknowledged: {refused:?}"));
    }
    world.run(2, &["A", "B", "C"]);
    for name in ["A", "B", "C"] {
        let computer = world.at(name);
        for (key, file, id, text) in written {
            assert!(computer.state.join(file).exists(), "{name} keeps {key} in {file}");
            assert_eq!(computer.copies.stamp(key), a.copies.stamp(key), "{name} holds every change of {key}");
            let record = computer.copies.read(key, id).unwrap().record;
            if name == "C" {
                assert!(record.is_some_and(|record| record.value.get("sealed").is_some() || record.value != json!({"kind": "note", "text": text})),
                    "C keeps {key} sealed");
                assert!(!holds(&std::fs::read(computer.state.join(file)).unwrap(), text), "no plain value of {key} at C");
            } else {
                assert_eq!(record.map(|record| record.value["text"].clone()), Some(json!(text)), "{name} reads {key}");
            }
        }
        // The book itself keeps only its own record: nothing of the other stores was written into it.
        let book = std::fs::read(computer.state.join("records.sqlite")).unwrap();
        for (key, _, _, text) in written {
            assert!(!holds(&book, text), "{name}'s records book holds nothing of {key}");
        }
    }
    assert_eq!(world.at("B").record("note-1").map(|(_, value)| value["text"].clone()), Some(json!("BOOK_TEXT")));
}

/// Two claimers that split the votes again and again (measured 2026-11-03 with three `trillion-local serve` computers
/// restarted at once: writer numbers 33 to 53 in about 3 minutes and no writer, A and C claiming at the same instant every
/// 10 s, each one's own row moved by the other's ask before its own vote). A claimer's turn left out the computer its own
/// writer row named, and after a split claim the voters' rows name different computers, so two computers counted the same
/// turn. Now a computer whose claim did not win counts every computer that may claim, in the voters' order (the same at
/// every computer), so no two of them share a turn, until it hears a writer.
#[test]
fn after_a_claim_that_did_not_win_no_two_computers_claim_on_the_same_turn() {
    let world = world(&[0, 1, 2]);
    let now = world.clock.load(Ordering::Acquire);
    let ended = now - 20_000;
    // A split claim at writer number 5 left the rows naming different computers: A's row names C, C's and B's name A.
    world.at("A").copies.set_writer_row_for_test(&world.at("C").id, 5, ended);
    world.at("B").copies.set_writer_row_for_test(&world.at("A").id, 5, ended);
    world.at("C").copies.set_writer_row_for_test(&world.at("A").id, 5, ended);
    let turns = |names: &[&str]| -> Vec<i64> { names.iter().map(|name| world.at(name).copies.claim_turn_for_test().0).collect() };
    let before = turns(&["A", "C"]);

    // Each of A and C claims once and loses (`Ok(false)`): B answers, but its live writer row names the other claimer, and
    // the other claimer is out of reach.
    for (name, other) in [("A", "C"), ("C", "A")] {
        world.at("B").copies.set_writer_row_for_test(&world.at(other).id, 5, now + 9_000);
        world.set_down(other, true);
        world.clock.store(world.at(name).copies.claim_turn_for_test().0 + 1, Ordering::Release);
        world.at(name).copies.tick();
        world.set_down(other, false);
        assert!(world.at(name).copies.holding().is_none(), "{name}'s claim did not win");
        assert!(world.at(name).copies.claim_turn_for_test().1, "{name} knows its claim did not win");
        world.clock.store(now, Ordering::Release);
    }
    world.at("B").copies.set_writer_row_for_test(&world.at("A").id, 5, ended);
    world.at("A").copies.set_writer_row_for_test(&world.at("C").id, 5, ended);
    world.at("C").copies.set_writer_row_for_test(&world.at("A").id, 5, ended);
    let after = turns(&["A", "C"]);
    assert_ne!(after[0], after[1], "two computers that lost a claim never share a turn (before: {before:?})");
    // Each counts every computer that may claim, in the voters' order, the same at every computer.
    let voters = world.at("A").copies.row().voters;
    let rank = |name: &str| voters.iter().position(|voter| *voter == world.at(name).id).unwrap() as i64;
    assert_eq!(after[0] - after[1], (rank("A") - rank("C")) * settings().renew_every_ms);

    // The writer moves: one computer wins, and every computer hears it and leaves the split.
    let mut writer = None;
    for _ in 0..40 {
        world.run(1, &["A", "B", "C"]);
        let writing: Vec<&str> = ["A", "B", "C"].into_iter().filter(|name| world.at(name).copies.holding().is_some()).collect();
        if let [one] = writing[..] {
            writer = Some(one);
            break;
        }
    }
    assert!(writer.is_some(), "a writer is chosen");
    world.run(1, &["A", "B", "C"]);
    assert!(["A", "B", "C"].iter().all(|name| !world.at(name).copies.claim_turn_for_test().1), "every computer heard the writer");
}

/// One answer that does not come back does not stop the writer (measured 2026-11-04 on three computers behind one
/// forwarder, the writer killed and its turn taken: about every 2 to 5 minutes one post to the one other computer
/// that may answer failed early, the write it carried was not acknowledged and the writer stopped writing, so the
/// writer moved again and again). With A off, every write of B needs C; C takes B's write and its answer is lost: B
/// sends the message again (`resend_when_lost`), C answers that it holds it, and the write is acknowledged. The same for
/// a sign-in change and for a renewal.
#[test]
fn one_lost_answer_does_not_stop_the_writer() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.at("A").write("first", json!({"kind": "note", "text": "first"})).unwrap();
    world.run(1, &["A", "B", "C"]);
    world.set_down("A", true);
    let mut writer = None;
    for _ in 0..40 {
        world.run(1, &["B", "C"]);
        if let Some(name) = ["B", "C"].into_iter().find(|name| world.at(name).copies.holding().is_some()) {
            writer = Some(name);
            break;
        }
    }
    let writer = writer.expect("B or C writes once A is off");
    let other = if writer == "B" { "C" } else { "B" };
    let number = world.at(writer).copies.holding();

    *world.net.lose_next_answer_from.lock().unwrap() = Some(world.at(other).id.clone());
    world.at(writer).write("second", json!({"kind": "note", "text": "second"})).expect("acknowledged though one answer was lost");
    assert!(world.net.lose_next_answer_from.lock().unwrap().is_none(), "an answer was lost");
    assert!(world.at(other).record("second").is_some(), "the other computer holds it once");

    // A change of the account's rows: a row removed at the writer, its answer lost once.
    world.at(writer).store().insert(Family::Lists, &list_row("lost", "lost")).unwrap();
    *world.net.lose_next_answer_from.lock().unwrap() = Some(world.at(other).id.clone());
    assert!(world.at(writer).store().remove(Family::Lists, "lost").unwrap(), "the change is made though one answer was lost");
    world.run(1, &[writer, other]);
    assert!(!holds_row(world.at(other), "lost"), "the other computer holds the removal");

    // A renewal whose answer is lost once.
    *world.net.lose_next_answer_from.lock().unwrap() = Some(world.at(other).id.clone());
    world.run(1, &[writer]);
    world.run(3, &[writer, other]);
    assert_eq!(world.at(writer).copies.holding(), number, "the writer keeps writing under the same number");
}

/// A write through the copies is also kept in the settle store of its resource (`record_store/mod.rs` `mirror_settle`),
/// at the writer and at every copy that takes it, with the writer's stamps: two computers that took the same changes
/// settle in one request that sends and takes nothing, and the settle store reads the record as written. Every store of
/// the account settles, each in its own file: a list, an own work and a further store of a volume (`settle_all`).
#[test]
fn writes_through_the_copies_keep_one_settle_root_at_every_computer_that_may_answer() {
    use crate::storage::record_store::record_sync::SettleStore;
    let world = world(&[0, 1]);
    world.start_with_a();
    let (a, b) = (world.at("A"), world.at("B"));
    for n in 0..5 {
        a.write(&format!("note-{n}"), json!({"kind": "note", "text": format!("text {n}")})).unwrap();
    }
    // A list, an own work and a further store of a volume each keep their records in their own file.
    let stores = ["@list/groceries", "@own-work/plan", "overflow:1/own-records"];
    for key in stores {
        let name = key.rsplit_once("1/").map_or(key, |(_, name)| name);
        let row = Mutation { id: "row-1".into(), expected_version: 0, request_key: format!("{key}-row-1"), deleted: false, value: json!({"kind": "row", "text": "milk"}) };
        a.copies.write_in(key, |store| write_record!(store, OWNER, name, row)).unwrap();
    }
    world.run(2, &["A", "B", "C"]);
    let root = |computer: &Computer, resource: &str| computer.copies.settle_store(resource).unwrap().checksum().unwrap().root;
    for resource in [RESOURCE].into_iter().chain(stores) {
        assert_eq!(root(a, resource), root(b, resource), "{resource}: A and B keep the same settle state");
        assert_ne!(root(a, resource), crate::storage::record_store::digest::Sums::new().root(), "{resource}: the settle store is not empty");
    }
    assert_eq!(a.copies.settle_store(RESOURCE).unwrap().read("note-3").unwrap().and_then(|fields| fields.get("text").cloned()), Some(json!("text 3")));
    let settled = b.copies.settle(&a.id, RESOURCE).unwrap();
    assert!(settled.equal && settled.requests == 1 && settled.sent == 0 && settled.took == 0, "{settled:?}");
    let all = b.copies.settle_all(&a.id);
    for key in stores {
        assert!(all.iter().any(|(resource, _)| resource == key), "{key} settles in its own file: {:?}", all.iter().map(|(resource, _)| resource).collect::<Vec<_>>());
    }
    assert!(all.iter().all(|(_, settled)| settled.as_ref().is_ok_and(|settled| settled.equal && settled.took == 0)), "{all:?}");
    // A deletion is a removal in the settle store too, at every copy.
    a.mutate(Mutation { id: "note-0".into(), expected_version: 1, request_key: "delete-note-0".into(), deleted: true, value: json!(null) }).unwrap();
    world.run(2, &["A", "B", "C"]);
    assert_eq!(b.copies.settle_store(RESOURCE).unwrap().read("note-0").unwrap(), None);
    assert_eq!(root(a, RESOURCE), root(b, RESOURCE));
}

/// A network answer stays paused until the test releases it. Drop releases too, so a failed assertion leaves no
/// blocked fixture thread behind. Unlike `hang`, this proves event order rather than an elapsed-time estimate.
struct PausedReplies(Arc<(Mutex<bool>, std::sync::Condvar)>);

impl Drop for PausedReplies {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}

fn pause_stamps(world: &World, name: &str) -> (PausedReplies, std::sync::mpsc::Receiver<()>) {
    let pause = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let waiting = pause.clone();
    let peer = world.at(name).id.clone();
    let (entered, heard) = std::sync::mpsc::channel();
    *world.net.on_stamps.lock().unwrap() = Some(Arc::new(move |to| {
        if to == peer {
            let _ = entered.send(());
            let mut released = waiting.0.lock().unwrap();
            while !*released {
                released = waiting.1.wait(released).unwrap();
            }
        }
    }));
    (PausedReplies(pause), heard)
}

fn pause_accepted_votes(world: &World, name: &str) -> (PausedReplies, std::sync::mpsc::Receiver<()>) {
    let pause = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let waiting = pause.clone();
    let asker = world.at(name).id.clone();
    let (entered, heard) = std::sync::mpsc::channel();
    *world.net.on_vote_answer.lock().unwrap() = Some(Arc::new(move |from, _to| {
        if from == asker {
            let _ = entered.send(());
            let mut released = waiting.0.lock().unwrap();
            while !*released {
                released = waiting.1.wait(released).unwrap();
            }
        }
    }));
    (PausedReplies(pause), heard)
}

/// The signed computers row and its key start in the real rows store, as in an account made by sign-up. Subsequent
/// row edits below use CopiedRows' actual rows_write, including settled-old-row, joint-term and row acknowledgements.
fn world_with_written_computers_row() -> World {
    use crate::account::rows::store::{Family, Row};
    let world = world(&[0, 1]);
    let a = world.at("A");
    let raw = Store::new(&*a.raw);
    super::keep_public_key(&raw, OWNER, &world.account).unwrap();
    raw.put(Family::Computers, &Row {
        id: super::Subject::Account(world.account.address()).row_id(), account: OWNER.into(), expires_at: 0,
        value: a.copies.row(),
    }).unwrap();
    world.start_with_a();
    a.copies.copy_outside_changes().unwrap();
    world
}

fn remove_c_as_a_voter(world: &World, writer: &Computer) -> ComputersRow {
    use crate::account::rows::store::{Family, Row};
    let initial = writer.copies.row();
    let voters = vec![world.at("A").id.clone(), world.at("B").id.clone()];
    let row = ComputersRow::sign_with_voters(&world.account.address(), initial.revision + 1,
        &initial.copy_keepers, &initial.may_answer, &voters, &world.account).unwrap();
    writer.store().put(Family::Computers, &Row {
        id: super::Subject::Account(world.account.address()).row_id(), account: OWNER.into(), expires_at: 0,
        value: row.clone(),
    }).unwrap();
    for computer in &world.computers {
        assert_eq!(computer.copies.row(), row, "the actual committed row reached {}", computer.id);
    }
    row
}

#[test]
fn a_valid_row_adopted_during_renewal_keeps_the_jointly_held_term_and_acks_only_current_voters() {
    let world = world_with_written_computers_row();
    let a = world.at("A");
    let term = a.copies.holding().unwrap();
    let (pause, entered) = pause_accepted_votes(&world, "A");
    let copies = a.copies.clone();
    let renewal = std::thread::spawn(move || copies.tick());
    for _ in 0..2 {
        entered.recv_timeout(expected_step_bound()).unwrap();
    }
    let next = remove_c_as_a_voter(&world, a);
    assert_eq!(a.copies.holding(), Some(term), "the old and new majorities still hold this writer's same live term");
    drop(pause);
    renewal.join().unwrap();
    *world.net.on_vote_answer.lock().unwrap() = None;
    assert_eq!(a.copies.holding(), Some(term), "merging the valid row preserves the safe renewed term");
    assert_eq!(a.copies.row(), next);
    assert!(world.at("B").write("conflicting-writer", json!({"kind": "note"})).is_err());
    a.write("under-current-row", json!({"kind": "note"})).unwrap();
    world.set_down("B", true);
    assert!(a.write("not-a-voting-majority", json!({"kind": "note"})).is_err(), "C is a copy keeper but no longer votes: A and C cannot acknowledge a write");
    assert!(a.record("not-a-voting-majority").is_none(), "the unacknowledged write rolled back");
}

#[test]
fn a_valid_row_adopted_during_an_old_claim_cannot_resurrect_it_over_a_new_writer() {
    let world = world_with_written_computers_row();
    let (a, b) = (world.at("A"), world.at("B"));
    // A's next claim gets actual votes under the old row, but neither answer reaches its cloned WriterRole yet.
    world.clock.fetch_add(settings().term_ms + settings().clock_margin_ms + 3 * settings().renew_every_ms, Ordering::AcqRel);
    let (pause, entered) = pause_accepted_votes(&world, "A");
    let copies = a.copies.clone();
    let claim = std::thread::spawn(move || copies.tick());
    for _ in 0..2 {
        entered.recv_timeout(expected_step_bound()).unwrap();
    }
    let old_claim_term = b.copies.writer_row().unwrap().1;
    // Only after that accepted term and its clock margin expire may B win a higher term. Its actual joint row edit
    // then reaches A while A's old vote answers are still paused; A remains both a copy keeper and a voter.
    world.clock.fetch_add(settings().term_ms + settings().clock_margin_ms + 3 * settings().renew_every_ms, Ordering::AcqRel);
    world.tick(&["B"]);
    let current_term = b.copies.holding().expect("B wins through real votes after A's pending term expires");
    assert!(current_term > old_claim_term);
    let next = remove_c_as_a_voter(&world, b);
    b.write("current-writer", json!({"kind": "note", "text": "acknowledged by current A and B"})).unwrap();
    drop(pause);
    claim.join().unwrap();
    *world.net.on_vote_answer.lock().unwrap() = None;
    assert_eq!(world.writers(), vec!["B"], "the late old-row vote answers cannot create a conflicting writer");
    assert_eq!(a.copies.row(), next);
    assert_eq!(a.copies.writer_row().map(|(writer, term, _)| (writer, term)), Some((b.id.clone(), current_term)),
        "the claim's compare-and-set cannot replace A's newer durable voter row");
    assert!(a.write("late-old-writer", json!({"kind": "note"})).is_err());
    assert!(a.record("late-old-writer").is_none());
    world.set_down("A", true);
    assert!(b.write("old-row-only-majority", json!({"kind": "note"})).is_err(), "B and removed voter C cannot acknowledge under the new row");
    assert!(b.record("old-row-only-majority").is_none());
}

/// The longest a test waits for a step it expects. A step ends by its own production deadline (wall clock, `ack_wait_ms`), so
/// it ends inside this bound even on a loaded host; the bound only ever catches a stuck test, never a slow one.
fn expected_step_bound() -> std::time::Duration {
    std::time::Duration::from_millis(settings().message_wait_ms.saturating_mul(10))
}

/// Run the actual timer's claim while C's stamps are held. The observation wait only bounds a broken test: C is
/// explicitly released after observing completion, and never supplies the quorum that lets the claim finish.
fn claim_before_c_answers(world: &World, name: &str) -> bool {
    let (pause, entered) = pause_stamps(world, "C");
    let copies = world.at(name).copies.clone();
    let (done, answer) = std::sync::mpsc::channel();
    let run = std::thread::spawn(move || {
        copies.tick();
        let _ = done.send(copies.holding().is_some());
    });
    let entered = entered.recv_timeout(expected_step_bound());
    let finished = answer.recv_timeout(expected_step_bound());
    drop(pause);
    run.join().unwrap();
    *world.net.on_stamps.lock().unwrap() = None;
    assert!(entered.is_ok(), "the minority's stamps were actually paused");
    assert!(finished.is_ok(), "the claim waited for the paused minority's stamps: {finished:?}");
    finished.unwrap()
}

#[test]
fn a_claim_finishes_with_a_voter_majority_while_the_minoritys_stamps_are_paused() {
    let world = world(&[0, 1, 2]);
    assert!(claim_before_c_answers(&world, "A"), "A and B are a voting majority without C's stamps");
    assert_eq!(world.writers(), vec!["A"]);
}

#[test]
fn a_claim_catches_every_newer_resource_in_its_heard_majority_before_winning() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.set_down("A", true);
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_eq!(world.writers(), vec!["B"]);
    let (a, b) = (world.at("A"), world.at("B"));
    b.write("committed-without-a", json!({"kind": "note", "text": "held by B and C"})).unwrap();
    let resource = "@list/claim-majority";
    b.copies.write_in(resource, |store| write_record!(store, OWNER, resource, Mutation {
        id: "new-resource".into(), expected_version: 0, request_key: "claim-majority-new-resource".into(), deleted: false,
        value: json!({"kind": "note", "text": "a resource A has never followed"}),
    })).unwrap();
    assert!(a.record("committed-without-a").is_none());
    assert_eq!(a.copies.stamp(resource), 0);
    world.set_down("A", false);
    // A can have heard B's renewal without taking its record pages. Keep that durable voter term current so this
    // fixture isolates data catch-up, rather than the separate first refusal that teaches a claimer a newer term.
    a.copies.set_writer_row_for_test(&b.id, b.copies.holding().unwrap(), world.clock.load(Ordering::Acquire) + settings().term_ms);
    world.clock.fetch_add(settings().term_ms + settings().clock_margin_ms + 3 * settings().renew_every_ms, Ordering::AcqRel);
    assert!(claim_before_c_answers(&world, "A"), "A catches B's committed data before B votes for it");
    assert_eq!(a.record("committed-without-a").unwrap().1["text"], "held by B and C");
    assert_eq!(a.copies.read(resource, "new-resource").unwrap().record.unwrap().value["text"], "a resource A has never followed");
}

#[test]
fn a_claim_with_stamps_but_without_a_joined_voting_majority_never_wins() {
    let world = world_keeping_with_joining(&[0, 1, 2], 1 << 20, None, Some(1));
    world.set_down("C", true);
    world.tick(&["A"]);
    assert!(!world.at("B").copies.joined(), "B's joining copy has not caught up");
    assert!(world.writers().is_empty(), "B's stamps are not a takeover vote: the joined check still refuses it");
    world.set_down("B", true);
    world.tick(&["A"]);
    assert!(world.writers().is_empty(), "A alone never supplies a majority of three");
}

#[test]
fn a_claim_counts_its_heard_voters_against_the_row_it_caught_up_to() {
    let world = world(&[0, 1, 2]);
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    let voters = vec![a.id.clone(), c.id.clone()];
    let next = ComputersRow::sign_with_voters(&world.account.address(), 2, &world.ids, &voters, &voters, &world.account).unwrap();
    let told = super::KeptAccount { row: next.clone(), account_key: world.account.public_hex() };
    b.copies.answer(&a.id, Message::Row { told: Some(told), term: 0, made: true });
    world.set_down("C", true);
    world.tick(&["A"]);
    assert_eq!(a.copies.row(), next, "B's newer signed row is caught up before the gate is checked");
    assert!(world.writers().is_empty());
    assert!(!a.copies.claim_turn_for_test().1, "B no longer votes: its old-row response must fail the caught-up gate, before asking for votes");
}

#[test]
fn the_all_peer_stamps_helper_still_waits_for_a_paused_minority() {
    let world = world(&[0, 1, 2]);
    let (pause, entered) = pause_stamps(&world, "C");
    let copies = world.at("A").copies.clone();
    let peers = vec![world.at("B").id.clone(), world.at("C").id.clone()];
    let (done, answer) = std::sync::mpsc::channel();
    let run = std::thread::spawn(move || { let _ = done.send(copies.stamps_of_all(&peers)); });
    let entered = entered.recv_timeout(expected_step_bound());
    let before_release = answer.recv_timeout(std::time::Duration::from_millis(100));
    drop(pause);
    let after_release = answer.recv_timeout(expected_step_bound());
    run.join().unwrap();
    *world.net.on_stamps.lock().unwrap() = None;
    assert!(entered.is_ok());
    assert!(matches!(before_release, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "bootstrap still reads all peers");
    assert_eq!(after_release.unwrap().len(), 2, "both actual stamps answers are retained");
}

/// A rows change and the stamps round of a claim or a join go to every other computer at once (`send_all`): two
/// computers that hang delay a rows change once, never once each. Before, each went to one computer after another,
/// so two hanging computers held a rows change for two message waits (8 s), past the write's own `ack_wait_ms`.
/// Every computer in `peers` was entered before the first hung wait ended, so each was sent to at once.
fn assert_entered_together(world: &World, peers: &[String], what: &str) {
    let log = world.net.hung_log.lock().unwrap().clone();
    let first_end = log.iter().position(|(_, event)| *event == "leave").unwrap_or(log.len());
    for peer in peers {
        assert!(log[..first_end].iter().any(|(to, event)| to == peer && *event == "enter"), "{what} waited on {peer} after another hung wait ended: {log:?}");
    }
}

#[test]
fn two_hanging_computers_delay_a_rows_change_and_the_stamps_round_once_not_once_each() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.at("A").store().insert(Family::Lists, &list_row("test-row", "one")).unwrap();
    for name in ["B", "C"] {
        world.net.hang.lock().unwrap().insert(world.at(name).id.clone());
    }
    assert!(world.at("A").store().remove(Family::Lists, "test-row").is_err(), "not acknowledged while B and C may still admit");
    // Both hanging computers were entered before either wait ended: the change went to them at once, not one after the other.
    let peers: Vec<String> = ["B", "C"].iter().map(|name| world.at(name).id.clone()).collect();
    assert_entered_together(&world, &peers, "the rows change");
    world.net.hung_log.lock().unwrap().clear();
    assert!(world.at("A").copies.stamps_of_all(&peers).is_empty(), "a hanging computer answers no stamps");
    assert_entered_together(&world, &peers, "the stamps round");
    world.net.hang.lock().unwrap().clear();
}

/// A computer that only holds a copy keeps every value sealed under a fresh nonce, so its settle state never sums like
/// another copy's and a plain settle with it is refused (403). Its stamps are the writer's: comparing stamps alone
/// (`compare_stamps`) finds it equal once it took every change, and names the records it lacks while it is cut off, in
/// either direction; no value crosses.
#[test]
fn a_computer_that_only_holds_a_copy_is_compared_by_stamps_and_named_behind_while_cut_off() {
    let world = world(&[0, 1]);
    world.start_with_a();
    let (a, c) = (world.at("A"), world.at("C"));
    for n in 0..4 {
        a.write(&format!("note-{n}"), json!({"kind": "note", "text": format!("SECRET_{n}")})).unwrap();
    }
    world.run(2, &["A", "B", "C"]);
    assert_eq!(c.copies.settle(&a.id, RESOURCE).unwrap_err().status, 403, "no plain settle with a computer that only holds a copy");
    let compared = a.copies.compare_stamps(&c.id, RESOURCE).unwrap();
    assert!(compared.equal && compared.they_lack.is_empty() && compared.we_lack.is_empty(), "{compared:?}");
    let from_c = c.copies.compare_stamps(&a.id, RESOURCE).unwrap();
    assert!(from_c.equal, "{from_c:?}");
    world.set_down("C", true);
    a.write("note-late", json!({"kind": "note", "text": "SECRET_LATE"})).unwrap();
    world.set_down("C", false);
    let behind = a.copies.compare_stamps(&c.id, RESOURCE).unwrap();
    assert_eq!(behind.they_lack, vec!["note-late".to_string()], "{behind:?}");
    assert_eq!(c.copies.compare_stamps(&a.id, RESOURCE).unwrap().we_lack, vec!["note-late".to_string()]);
    world.run(3, &["A", "B", "C"]);
    assert!(a.copies.compare_stamps(&c.id, RESOURCE).unwrap().equal, "C caught up from the feed");
    assert!(!holds(&folder_bytes(&c.state), "SECRET_LATE"), "no plain value reached C");
}

// ---------------------------------------------------------------------------------------------------------------
// The account stores travel as records; a holding answer goes in parts; a row of the account's made outside the copies travels.

fn stores_of(policy: &[(&str, &str)], kv: &[(&str, &str, &str)]) -> crate::account::create::AccountStores {
    crate::account::create::AccountStores {
        policy: policy.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
        kv: kv.iter().map(|(key, blob_id, blob)| crate::account::create::KvEntry {
            key: key.to_string(), blob_id: blob_id.to_string(), expiration: None, blob: blob.to_string(),
        }).collect(),
    }
}

/// Write `stores` into `computer`'s own account stores (as an account route's rights change, or an operator's publication, writes them).
fn set_stores(computer: &Computer, stores: &crate::account::create::AccountStores) {
    crate::account::create::apply_account_stores(&computer.state, std::path::Path::new(POLICY), stores,
        &crate::account::create::KeptHere::default()).unwrap();
}

fn read_stores(computer: &Computer) -> Option<crate::account::create::AccountStores> {
    crate::account::create::read_account_stores(&computer.state, std::path::Path::new(POLICY), usize::MAX).ok()
}

fn policy_of(computer: &Computer) -> Vec<(String, String)> {
    read_stores(computer).map(|stores| stores.policy).unwrap_or_default()
}

fn kv_of(computer: &Computer) -> Vec<(String, String)> {
    read_stores(computer).map(|stores| stores.kv.into_iter().map(|entry| (entry.key, entry.blob)).collect()).unwrap_or_default()
}

fn owned(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(one, two)| (one.to_string(), two.to_string())).collect()
}

/// #63's first gap: the account stores (policy rows, app key-value entries) travelled once, in the holding answer, and
/// no later change of them at the writer reached a computer that already kept the account. Now they are records the
/// writer's feed carries: a change at the writer is at every other computer that may answer once its write is
/// acknowledged (pushed, not only pulled), a row removed is removed there, each computer's own service records stay its
/// own, a computer that only keeps a copy keeps them sealed and makes no stores, and after a takeover the new writer's
/// change reaches the computer left.
#[test]
fn the_account_stores_changed_at_the_writer_reach_every_computer_that_may_answer_and_stay_sealed_at_a_copy() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    assert!(b.copies.holds_secrets_key(), "B may answer and holds the root");
    // B publishes its own service record (each computer publishes the operator's into every account it serves).
    set_stores(b, &stores_of(&[], &[("service-record:show", "show-b", "B_OWN")]));

    set_stores(a, &stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:share", "\"PRIVATE_POLICY_ONE\"")],
        &[("personal-key:abc", "personal", "{\"userId\":\"person\"}"), ("service-record:show", "show-a", "A_OWN")]));
    world.tick(&["A"]);
    assert_eq!(policy_of(b), owned(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:share", "\"PRIVATE_POLICY_ONE\"")]),
        "the writer's policy rows are at B once its step wrote them, with no step of B's");
    assert_eq!(kv_of(b), owned(&[("personal-key:abc", "{\"userId\":\"person\"}"), ("service-record:show", "B_OWN")]),
        "the key-value entry travels; B's own service record stays its own");

    // A later change at the writer: a row changed, one added, one removed. Before, B never heard of it.
    set_stores(a, &stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:connect", "\"PRIVATE_POLICY_TWO\"")],
        &[("personal-key:abc", "personal", "{\"userId\":\"person\",\"turned\":2}")]));
    world.tick(&["A"]);
    assert_eq!(policy_of(b), owned(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:connect", "\"PRIVATE_POLICY_TWO\"")]));
    assert_eq!(kv_of(b), owned(&[("personal-key:abc", "{\"userId\":\"person\",\"turned\":2}"), ("service-record:show", "B_OWN")]));
    // A step with nothing changed writes nothing.
    let before = a.copies.stamp(super::account_stores::resource());
    world.tick(&["A", "B"]);
    assert_eq!(a.copies.stamp(super::account_stores::resource()), before, "unchanged stores write no record");

    // C only keeps a copy: the records are there, sealed, and it has no stores and no plain value.
    world.run(1, &["C"]);
    assert!(c.copies.stamp(super::account_stores::resource()) >= before, "C follows the account stores' records");
    assert!(!c.state.join(POLICY).exists(), "C makes no account stores");
    assert!(!holds(&folder_bytes(&c.state), "PRIVATE_POLICY_TWO"), "C keeps no plain policy value");

    // A goes; B takes the writer turn; B's own change reaches the computer that may answer next (A, back).
    world.set_down("A", true);
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_eq!(world.writers(), vec!["B"]);
    set_stores(b, &stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:connect", "\"PRIVATE_POLICY_THREE\"")],
        &[("personal-key:abc", "personal", "{\"userId\":\"person\",\"turned\":2}"), ("service-record:show", "show-b", "B_OWN")]));
    world.tick(&["B"]);
    world.set_down("A", false);
    world.run(2, &["A", "B", "C"]);
    assert_eq!(policy_of(a), owned(&[("policy-source", "{\"from\":\"new-account\"}"), ("rights:connect", "\"PRIVATE_POLICY_THREE\"")]),
        "the new writer's change reached A: {:?}", policy_of(a));
}

/// #63's second gap: the holding answer was one message (at most `message_body_bytes`), so an account whose answer was
/// larger was refused. Now an answer longer than one message is kept as parts by the copies of the computer that answers and the
/// asker takes them part by part, every message within the bound.
#[test]
fn a_holding_answer_longer_than_one_message_travels_in_parts() {
    use super::messages::{HeldRow, Holding};
    let world = world(&[0, 1]);
    world.start_with_a();
    let (a, b) = (world.at("A"), world.at("B"));
    let told = super::KeptAccount { row: a.copies.row(), account_key: world.account.public_hex() };
    let rows: Vec<HeldRow> = (0..12).map(|n| HeldRow {
        family: "lists".into(), id: format!("lists:big:{n}"), account: ACCOUNT.into(), expires_at: 0,
        value: json!({"words": "w".repeat(8_000), "n": n}),
    }).collect();
    let holding = Holding { row: told, restore: "{}".into(), index: String::new(), rows };
    let whole = Answer::Holding { holding: Box::new(holding.clone()) };
    assert!(serde_json::to_vec(&whole).unwrap().len() > 2 * settings().message_body_bytes, "the answer is longer than two messages");

    // B answers A's Message::Holding as the computer does (join_itself.rs): through its copies, in parts.
    struct Asking<'a> { from: String, to: &'a Copies, whole: Answer, sizes: Mutex<Vec<usize>> }
    impl Link for Asking<'_> {
        fn send(&self, _to: &str, message: &Message) -> Option<Answer> {
            let answer = match message {
                Message::Holding => self.to.answer_in_parts(&self.from, self.whole.clone()),
                other => self.to.answer(&self.from, other.clone()),
            };
            self.sizes.lock().unwrap().push(serde_json::to_vec(&answer).unwrap().len());
            Some(answer)
        }
    }
    let link = Asking { from: a.id.clone(), to: &b.copies, whole, sizes: Mutex::new(Vec::new()) };
    let answer = super::copies::send_in_parts(&link, &b.id, &Message::Holding);
    match answer {
        Some(Answer::Holding { holding: given }) => assert_eq!(*given, holding, "the whole answer came back the same"),
        other => panic!("no holding answer: {other:?}"),
    }
    let sizes = link.sizes.lock().unwrap();
    assert!(sizes.len() > 2, "it came in parts: {sizes:?}");
    assert!(sizes.iter().all(|size| *size <= settings().message_body_bytes), "every message within the bound: {sizes:?}");
}

/// Omitted command senders are not bounded by the account's signed member list.
/// Their large receipt cache therefore has aggregate count and byte bounds.
#[test]
fn omitted_command_receipt_parts_have_aggregate_bounds_and_release_capacity() {
    let world = world(&[0, 1]);
    let copies = &world.at("B").copies;
    let bounds = &settings().pending_writes;
    let answer = |bytes| Answer::SettleCommand { receipt: super::copies::pending::Receipt {
        id: "synthetic-command".into(), payload: json!({"sealed":"w".repeat(bytes)}),
    }};
    let mut first = None;
    for index in 0..bounds.incoming_transfers {
        let reply = copies.answer_in_parts(&format!("settle-command:omitted-{index}"), answer(settings().message_body_bytes));
        let Answer::Parts { transfer, count, .. } = reply else { panic!("receipt within the aggregate bounds was refused: {reply:?}"); };
        if first.is_none() { first = Some((transfer, count)); }
    }
    assert!(matches!(copies.answer_in_parts("settle-command:one-too-many", answer(settings().message_body_bytes)),
        Answer::Refused { code, .. } if code == "command_settle_busy"));
    let (transfer, count) = first.unwrap();
    assert!(matches!(copies.answer("omitted-0", Message::SettleCommandAnswerPart { transfer, index:count - 1 }), Answer::Part { .. }));
    assert!(matches!(copies.answer_in_parts("settle-command:now-room", answer(settings().message_body_bytes)), Answer::Parts { .. }),
        "taking the last receipt part frees its cache slot");

    // Expiry frees the previous receipts; one large receipt fits, a second
    // would exceed the aggregate byte allowance before the count allowance.
    world.clock.fetch_add(settings().part_hold_ms + 1, Ordering::AcqRel);
    let bytes = bounds.incoming_bytes / 2;
    assert!(matches!(copies.answer_in_parts("settle-command:large-one", answer(bytes)), Answer::Parts { .. }));
    assert!(matches!(copies.answer_in_parts("settle-command:large-two", answer(bytes)),
        Answer::Refused { code, .. } if code == "command_settle_busy"));
    assert!(matches!(copies.answer_in_parts("ordinary-member", answer(settings().message_body_bytes)), Answer::Parts { .. }),
        "a busy command receipt cache does not consume an ordinary peer's cache slot");
}

/// #63's fourth gap: a row written outside the copies (straight into a computer's own rows, not through its view) was only
/// logged on a writer step, and a computer that is not the writer and takes no requests does not step: a row made at A was
/// missing at B after A died. Now it is made one acknowledged change: once done, B holds it, before A steps again; and it
/// survives A's death and B's takeover.
#[test]
fn a_row_written_outside_the_copies_is_an_acknowledged_change_and_kept_after_the_writer_dies() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    // Straight into A's own rows, not through the account's view.
    Store::new(&*a.raw).insert(Family::Lists, &list_row("outside", "outside")).unwrap();
    assert!(!holds_row(b, "outside"), "B does not have it yet");
    assert_eq!(a.copies.copy_outside_changes().unwrap(), Some(1), "one row made outside the copies, acknowledged");
    assert!(holds_row(b, "outside"), "B holds it once acknowledged, with no step of its own");
    assert_eq!(a.copies.copy_outside_changes().unwrap(), Some(0), "nothing is left to copy");

    world.set_down("A", true);
    world.run(world.term_runs_out(), &["B", "C"]);
    assert_ne!(world.writers(), Vec::<&str>::new());
    assert!(holds_row(b, "outside"), "the row made at A is at B after A died");
    // A computer that cannot take the writer turn now copies nothing (A, cut off, while B or C holds it).
    Store::new(&*a.raw).insert(Family::Lists, &list_row("outside-late", "late")).unwrap();
    assert_eq!(a.copies.copy_outside_changes().unwrap(), None);
    assert!(!holds_row(b, "outside-late"));
}

/// #95's gap: a row written outside the copies at a computer that may answer but is not the writer stayed at that
/// computer. Now that computer hands it to the writer (`Message::OutsideChanges`), which makes it one acknowledged change
/// with the writer role staying where it is; the row comes back logged, and a removal travels the same way.
#[test]
fn a_row_written_outside_the_copies_at_a_computer_that_is_not_the_writer_reaches_the_writer() {
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    // Straight into B's own rows.
    Store::new(&*b.raw).insert(Family::Lists, &list_row("outside-at-b", "b")).unwrap();
    assert!(!holds_row(a, "outside-at-b"), "A does not have it yet");
    assert_eq!(b.copies.copy_outside_changes().unwrap(), Some(1), "B handed one row to the writer A");
    assert_eq!(world.writers(), vec!["A"], "the writer role stayed at A");
    assert!(holds_row(a, "outside-at-b"), "A holds the row B wrote");
    assert_eq!(b.copies.copy_outside_changes().unwrap(), Some(0), "B's row came back logged: nothing is left to hand");

    // Removed at B: the removal reaches A the same way.
    assert!(Store::new(&*b.raw).remove(Family::Lists, "outside-at-b").unwrap());
    assert_eq!(b.copies.copy_outside_changes().unwrap(), Some(1));
    assert!(!holds_row(a, "outside-at-b"), "the row removed at B is gone at the writer");
}

/// Measured 2026-11-04 (tests/computer_forwarder.rs, an account given voters after it was made): the first step of a
/// computer that was not the writer yet took the account stores' records, none written yet, over its own stores and removed
/// every policy row, so no other computer ever opened the account. A resource nobody wrote is never taken; the writer
/// writes its own rows there.
#[test]
fn account_stores_nobody_wrote_yet_never_remove_a_computers_own_rows() {
    let world = world(&[0, 1]);
    let (a, b) = (world.at("A"), world.at("B"));
    let rows = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "1")], &[]);
    set_stores(a, &rows);
    set_stores(b, &stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "1"), ("only-at-b", "2")], &[]));
    // Neither holds the writer turn yet: a step takes nothing.
    assert_eq!(a.copies.account_stores_step(), Default::default());
    assert_eq!(policy_of(a), rows.policy, "A's own rows stay");
    assert_eq!(policy_of(b).len(), 3, "B's own rows stay");
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    assert_eq!(policy_of(a), rows.policy);
    assert_eq!(policy_of(b), rows.policy, "once the writer wrote them, B holds the writer's rows");
}

/// A change of the account stores made at the writer is written as records right after the request that made it
/// (src/native_entry/computer.rs `forward`, and `after_door` for a call on a forwarder session). When no copy acknowledges
/// that write, the change is at the writer alone and is lost if the writer dies before a later step writes it: the step
/// says so (`refused`; the request that made it is answered as its route answered it, without waiting); the next step writes it while this computer still
/// writes, and once another computer took the term this computer's stores are put back to the account's records.
#[test]
fn a_store_change_no_copy_acknowledged_is_reported_refused_and_written_by_a_later_step() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    let first = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "1")], &[]);
    set_stores(a, &first);
    let stepped = a.copies.account_stores_step();
    assert!(!stepped.refused && stepped.written > 0, "with every copy up the change is acknowledged: {stepped:?}");
    assert_eq!(policy_of(b), first.policy, "B holds it");

    world.set_down("B", true);
    world.set_down("C", true);
    let changed = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "2")], &[]);
    set_stores(a, &changed);
    let stepped = a.copies.account_stores_step();
    assert!(stepped.refused && stepped.written == 0, "no copy acknowledged the change: {stepped:?}");
    assert_eq!(policy_of(b), first.policy, "B does not hold the change");

    world.set_down("B", false);
    world.set_down("C", false);
    world.run(world.term_runs_out(), &["A", "B", "C"]);
    let writer = world.writers();
    assert_eq!(writer.len(), 1, "one computer writes once the copies are back: {writer:?}");
    if writer == vec!["A"] {
        // A kept the term: its next step writes the change it kept, and it travels.
        assert!(!a.copies.account_stores_step().refused);
        assert_eq!(policy_of(b), changed.policy, "the change A kept travelled on a later step");
    } else {
        // Another computer took the term: the change no copy acknowledged was never made. A, which may answer, puts its
        // stores back to the account's records and never answers from it (before, A kept serving revision 2 while the
        // writer and every copy held revision 1).
        a.copies.account_stores_step();
        assert_eq!(policy_of(a), first.policy, "A's unacknowledged change is put back");
        assert_eq!(policy_of(b), first.policy);
    }
}

/// Measured 2026-11-13 on the person's account (35,624 key-value blobs, 887 MB): every request at the writer read every blob and
/// hashed them under one lock, and the calls queued behind it for minutes. A step now reads nothing while the store files
/// are as the last step left them, and, when they changed, a blob only for a row that is new or has another blob id.
#[test]
fn a_step_at_the_writer_reads_a_blob_only_for_a_row_that_changed() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    let blobs = a.state.join("storage/kv").join(crate::local_account::EXISTING_APP_KV_STORE).join("blobs");
    let first = stores_of(&[("policy-source", "{\"from\":\"new-account\"}")], &[("k:one", "one-1", "ONE"), ("k:two", "two-1", "TWO")]);
    set_stores(a, &first);
    let stepped = a.copies.account_stores_step();
    assert!(!stepped.refused && stepped.written == 3, "every row travelled once: {stepped:?}");
    assert_eq!(kv_of(b), kv_of(a), "B holds them");

    // Nothing changed: the step reads no blob (the first one cannot be read now, a read of it would fail) and writes nothing.
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(blobs.join("one-1"), std::fs::Permissions::from_mode(0)).unwrap();
    }
    assert!(std::fs::read_to_string(blobs.join("one-1")).is_err(), "a read of that blob fails");
    assert_eq!(a.copies.account_stores_step(), Default::default());
    assert_eq!(a.copies.account_stores_step(), Default::default());

    // One row changes to a new blob: the step makes that row's record only, though the other blob is unreadable.
    let connection = rusqlite::Connection::open(a.state.join("current-kv.sqlite")).unwrap();
    connection.execute("UPDATE _mf_entries SET blob_id='two-2' WHERE key='k:two'", []).unwrap();
    std::fs::write(blobs.join("two-2"), "TWO_CHANGED").unwrap();
    let stepped = a.copies.account_stores_step();
    assert!(!stepped.refused && stepped.written == 1, "only the changed row travelled: {stepped:?}");
    assert_eq!(kv_of(b).into_iter().find(|(key, _)| key == "k:two"), Some(("k:two".to_owned(), "TWO_CHANGED".to_owned())));

    // A row removed is a deleted record, and needs no blob.
    connection.execute("DELETE FROM _mf_entries WHERE key='k:one'", []).unwrap();
    let stepped = a.copies.account_stores_step();
    assert!(!stepped.refused && stepped.written == 1, "the removed row travelled as a deletion: {stepped:?}");
    assert!(kv_of(b).iter().all(|(key, _)| key != "k:one"), "B no longer holds it");
}

/// The callers that must not wait for the copies (the answer to a request, `after_door`, `hosting_answered`) ask for a step on
/// a thread of their own (`Copies::account_stores_step_soon`): the change still travels, a burst of asks runs no more than one
/// thread at a time, and a writer whose stores are as the last step left them starts none.
#[test]
fn a_step_asked_for_soon_writes_the_change_beside_the_caller_and_a_burst_adds_one_thread_at_most() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    let first = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "1")], &[]);
    set_stores(a, &first);
    assert!(a.copies.account_stores_step().written > 0);
    assert!(!a.copies.account_stores_of().unwrap().wants_step(&a.copies), "settled: nothing to run");

    let changed = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "2")], &[]);
    set_stores(a, &changed);
    assert!(a.copies.account_stores_of().unwrap().wants_step(&a.copies), "the files changed: a step is wanted");
    let threads_before = std::thread::current().id();
    for _ in 0..50 {
        a.copies.account_stores_step_soon();
    }
    assert_eq!(threads_before, std::thread::current().id());
    let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while policy_of(b) != changed.policy {
        assert!(std::time::Instant::now() < until, "the change never travelled: {:?}", policy_of(b));
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    while a.copies.account_stores_of().unwrap().wants_step(&a.copies) {
        assert!(std::time::Instant::now() < until, "the step never settled");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Measured 2026-11-13 (the whole engine at 400% CPU, load 187): every request wakes the account, and at a computer that does
/// not hold the writer turn the step opened the account-stores records store (a sqlite open and schema check) each time just to
/// read its stamp. A step there now has nothing to do while neither the records' file nor a store file changed, and wants to
/// run again as soon as the writer's change reaches it or its own stores change.
#[test]
fn a_step_at_a_computer_that_is_not_the_writer_wants_nothing_until_a_file_changed() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let (a, b) = (world.at("A"), world.at("B"));
    let stores = b.copies.account_stores_of().unwrap();
    let first = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "1")], &[]);
    set_stores(a, &first);
    assert!(a.copies.account_stores_step().written > 0);
    b.copies.account_stores_step();
    assert_eq!(policy_of(b), first.policy, "B holds the writer's rows");
    assert!(b.copies.holding().is_none() && !stores.wants_step(&b.copies), "B matches the records and no file changed: nothing to do");

    // The writer changes a row: the change reaches B's records file, and B wants a step again.
    let changed = stores_of(&[("policy-source", "{\"from\":\"new-account\"}"), ("revision", "2")], &[]);
    set_stores(a, &changed);
    assert!(a.copies.account_stores_step().written > 0);
    world.run(2, &["A", "B", "C"]);
    assert!(stores.wants_step(&b.copies) || policy_of(b) == changed.policy, "B's records moved");
    b.copies.account_stores_step();
    assert_eq!(policy_of(b), changed.policy);
    assert!(!stores.wants_step(&b.copies));

    // B's own stores change under it (not through the writer): a step is wanted and puts them back.
    set_stores(b, &first);
    assert!(stores.wants_step(&b.copies), "B's store files changed");
    b.copies.account_stores_step();
    assert_eq!(policy_of(b), changed.policy, "put back to the account's records");
}

/// A step thread (`step_soon`) runs while a step is wanted, so a step that leaves a step wanted is a thread that never ends
/// (measured 2026-11-13 on the person's engine: one thread at 100% CPU opening the records store in a loop). At a computer that does
/// not hold the writer turn, with nothing written to the account stores yet or with none of its own, a step ends with
/// nothing more to run until a file changed.
#[test]
fn a_step_at_a_computer_that_is_not_the_writer_ends_the_wish_when_nobody_wrote_the_account_stores() {
    let world = world(&[0, 1]);
    world.start_with_a();
    world.run(2, &["A", "B", "C"]);
    let b = world.at("B");
    let stores = b.copies.account_stores_of().unwrap();
    assert!(b.copies.holding().is_none());
    b.copies.account_stores_step();
    assert!(!stores.wants_step(&b.copies), "one step settled it: nothing more to run until a file changes");
}

#[test]
fn a_store_kept_in_the_records_book_before_it_had_a_file_of_its_own_is_carried_into_its_own_file() {
    use crate::records::Records as _;
    use crate::storage::{record_store::{settings::Limits, RecordStore, RealClock}, sqlite};
    let world = world(&[0, 1]);
    world.start_with_a();
    let b = world.at("B");
    // As a computer that ran before each list had a file of its own: the list's record is in the records book.
    let list = "@list/kept-in-the-book";
    let book = b.state.join("records.sqlite");
    {
        let supply = sqlite::open_owned(&book, "record_store", crate::storage::record_store_resources::bounds()).unwrap();
        let mut store = RecordStore::new(supply, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
        for at in 0..3 {
            store.mutate(OWNER, list, Mutation { id: format!("row-{at}"), expected_version: 0, request_key: format!("row-{at}"), deleted: false, value: json!({"kind": "row", "text": format!("row {at}")}) }).unwrap();
        }
    }
    assert!(b.copies.read(list, "row-0").unwrap().record.is_none(), "its own file holds nothing yet");
    assert_eq!(b.copies.carry_into_own_files(), 1);
    for at in 0..3 {
        let read = b.copies.read(list, &format!("row-{at}")).unwrap().record.map(|record| record.value["text"].clone());
        assert_eq!(read, Some(json!(format!("row {at}"))));
    }
    assert!(b.copies.stamp(list) > 0, "its stamp came with it");
    // Its settle store came too, and it is carried once only.
    assert!(b.copies.settle_store(list).unwrap().read("row-2").unwrap().is_some());
    assert_eq!(b.copies.carry_into_own_files(), 0);
}

#[test]
fn what_the_writer_takes_by_a_settle_reaches_its_records_and_through_the_feed_every_copy() {
    use crate::storage::record_store::record_sync::{Actor, SettleStore};
    let world = world(&[0, 1]);
    world.start_with_a();
    let (a, b) = (world.at("A"), world.at("B"));
    version(a, "shared", 0, false);
    world.run(2, &["A", "B", "C"]);
    // B's settle store holds a record the writer's copy lost (as after a failover): the settle is how A gets it back.
    let note = match json!({ "kind": "note", "text": "only B kept it" }) { Value::Object(map) => Some(map), _ => None };
    b.copies.settle_store(RESOURCE).unwrap().write(&[("kept-by-b", "note", note)], Actor::by("person")).unwrap();
    assert!(a.copies.read(RESOURCE, "kept-by-b").unwrap().record.is_none());
    let settled = a.copies.settle(&b.id, RESOURCE).unwrap();
    assert!(settled.equal && settled.took + settled.records_taken > 0, "{settled:?}");
    // The writer wrote it into its records as one acknowledged write; the feed brought it to B's records.
    let text = |computer: &Computer| computer.copies.read(RESOURCE, "kept-by-b").unwrap().record.map(|record| record.value["text"].clone());
    assert_eq!(text(a), Some(json!("only B kept it")));
    world.run(2, &["A", "B", "C"]);
    assert_eq!(text(b), Some(json!("only B kept it")));
    let root = |computer: &Computer| computer.copies.settle_store(RESOURCE).unwrap().checksum().unwrap().root;
    assert_eq!(root(a), root(b), "both settle stores hold the version the writer made of it");
    assert_eq!(a.copies.take_settled(), 0, "nothing is written twice");
}

/// Faults at the actual storage boundary, armed only after the synthetic world has started. Every store is a real
/// SQLite file in the test's temporary folder; only the selected file's open, log-page scan or carry readback refuses.
#[derive(Default)]
struct RecoveryFaults {
    target: Mutex<Option<PathBuf>>,
    opens: AtomicBool,
    pages_before_failure: AtomicI64,
    readback: AtomicBool,
    on_page_failure: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl RecoveryFaults {
    fn unarmed() -> Arc<Self> {
        Arc::new(Self { pages_before_failure: AtomicI64::new(-1), ..Self::default() })
    }
}

struct RecoveryStores(Arc<RecoveryFaults>);

impl StoreOpener for RecoveryStores {
    fn open(&self, path: &Path) -> Result<ComputerStore, crate::records::Error> {
        let selected = self.0.target.lock().unwrap().as_deref() == Some(path);
        if selected && self.0.opens.load(Ordering::Acquire) {
            return Err(crate::cause!(crate::records::Error::Unavailable));
        }
        let inner = crate::storage::sqlite::open_owned(path, "record_store", crate::storage::record_store_resources::bounds())
            .map_err(|error| crate::carry_cause!(crate::records::Error::Unavailable, error))?;
        Ok(Box::new(RecoveryStore { inner: Box::new(inner), faults: self.0.clone(), selected }))
    }

    fn limits(&self) -> Limits {
        Limits::fixed(1 << 20, 1 << 30)
    }
}

struct RecoveryStore {
    inner: ComputerStore,
    faults: Arc<RecoveryFaults>,
    selected: bool,
}

impl Storage for RecoveryStore {
    fn schema(&self) -> &'static crate::storage::Schema { self.inner.schema() }
    fn get(&self, family: &str, key: &[crate::storage::Value], read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Option<crate::storage::Row>> {
        if self.selected && family == "versions" && self.faults.readback.swap(false, Ordering::AcqRel) {
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        self.inner.get(family, key, read)
    }
    fn scan(&self, family: &str, range: &crate::storage::Range<'_>, read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Vec<crate::storage::Row>> {
        if self.selected && family == "settle_log" && read.len() == 3
            && self.faults.pages_before_failure.fetch_update(Ordering::AcqRel, Ordering::Acquire, |left| (left >= 0).then(|| left - 1)) == Ok(0) {
            let on_failure = self.faults.on_page_failure.lock().unwrap().take();
            if let Some(on_failure) = on_failure {
                on_failure();
            }
            return Err(crate::cause!(crate::storage::Error::Unavailable));
        }
        self.inner.scan(family, range, read)
    }
    fn put(&self, family: &str, row: &[(&str, crate::storage::Value)], when: crate::storage::When<'_>) -> crate::storage::Result<u64> { self.inner.put(family, row, when) }
    fn count(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> { self.inner.count(family, range) }
    fn erase(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> { self.inner.erase(family, range) }
    fn present(&self, family: &str) -> crate::storage::Result<bool> { self.inner.present(family) }
    fn custody(&self) -> crate::storage::Result<()> { self.inner.custody() }
    fn location(&self) -> Option<&str> { self.inner.location() }
    fn scoped(&self) -> bool { self.inner.scoped() }
    fn writing(&self) -> crate::storage::Result<bool> { self.inner.writing() }
    fn changes(&self) -> u64 { self.inner.changes() }
    fn mark(&self) -> crate::storage::Result<i64> { self.inner.mark() }
    fn schema_mark(&self) -> crate::storage::Result<i64> { self.inner.schema_mark() }
    fn allocated_bytes(&self) -> crate::storage::Result<u64> { self.inner.allocated_bytes() }
    fn reclaim(&self) -> crate::storage::Result<()> { self.inner.reclaim() }
    fn reclaim_step(&self, pages: u64) -> crate::storage::Result<u64> { self.inner.reclaim_step(pages) }
    fn overwrites_removed(&self) -> crate::storage::Result<bool> { self.inner.overwrites_removed() }
    fn open_scope(&self, intent: crate::storage::Intent) -> crate::storage::Result<()> { self.inner.open_scope(intent) }
    fn close_scope(&self, commit: bool) -> crate::storage::Result<()> { self.inner.close_scope(commit) }
}

/// A peer sends a missing record through the real settle answerer. That makes both its settle state and a pending
/// repair cursor; the record becomes an acknowledged account write only when take_settled succeeds.
fn send_recovery_record(copies: &Copies, from: &str, id: &str) {
    use crate::storage::record_store::{record_sync::{ChangeRow, SettleRequest, SettleStore}, stamps::Envelope};
    let fields = json!({"kind": "note", "text": id}).as_object().unwrap().clone();
    // An unstamped whole write must name what it replaced: Some(None) means the record was absent. Without that
    // basis the real answerer reports no_basis and applies nothing, which would never exercise a pending repair.
    let row = ChangeRow { id: format!("source-{id}"), envelopes: vec![Envelope { id: id.into(), kind: Some("note".into()), value: Some(fields), prior: Some(None), ..Envelope::default() }] };
    // This fixture supplies only the new upload; it is already through the receiver's prior log. Do not ask for
    // those older fixture rows back, which would turn the large-page test's setup answer into multipart delivery.
    let took_through = copies.settle_store(RESOURCE).unwrap().last_log_id().unwrap();
    let request = SettleRequest { rows: Some(vec![row]), took_through, ..SettleRequest::default() };
    match copies.answer(from, Message::Settle { resource: RESOURCE.into(), request }) {
        Answer::Settled { answer } => assert_eq!(answer.applied, 1, "the setup must apply one new record"),
        answer => panic!("the setup settle did not answer: {answer:?}"),
    }
    assert_eq!(copies.settle_store(RESOURCE).unwrap().read(id).unwrap().unwrap()["text"], id, "the setup's record is present in the settle store");
}

#[test]
fn a_settle_repair_whose_store_cannot_open_is_taken_once_after_it_recovers() {
    let faults = RecoveryFaults::unarmed();
    let world = world_keeping_with_stores(&[0, 1], 1 << 20, Some(Arc::new(RecoveryStores(faults.clone()))));
    world.start_with_a();
    let (a, b) = (world.at("A"), world.at("B"));
    *faults.target.lock().unwrap() = Some(a.state.join("records.sqlite"));
    send_recovery_record(&a.copies, &b.id, "after-open-refused");
    faults.opens.store(true, Ordering::Release);
    assert_eq!(a.copies.take_settled(), 0, "the store is unavailable");
    faults.opens.store(false, Ordering::Release);
    assert!(a.record("after-open-refused").is_none(), "the refused repair made no account write");
    assert_eq!(a.copies.take_settled(), 1, "the original pending repair survived the refused open");
    assert_eq!(a.record("after-open-refused").unwrap().0, 1);
    assert!(b.record("after-open-refused").is_some(), "the second computer acknowledged the repaired record");
    assert_eq!(a.copies.take_settled(), 0, "a retry makes no second version");
}

#[test]
fn a_failed_second_settle_log_page_writes_nothing_and_keeps_the_earliest_cursor() {
    use crate::storage::record_store::record_sync::{Actor, SettleStore, PAGE};
    // Both a cursor before the first row and one after a held row must survive a newer pending settle.
    for has_prefix in [false, true] {
        let faults = RecoveryFaults::unarmed();
        let world = world_keeping_with_stores(&[0, 1], 1 << 20, Some(Arc::new(RecoveryStores(faults.clone()))));
        world.start_with_a();
        let (a, b) = (world.at("A"), world.at("B"));
        *faults.target.lock().unwrap() = Some(a.state.join("records.sqlite"));
        let mut log = a.copies.settle_store(RESOURCE).unwrap();
        if has_prefix {
            let fields = json!({"kind": "note", "text": "already held"}).as_object().unwrap().clone();
            log.write(&[("before-repair", "note", Some(fields))], Actor::by("person")).unwrap();
        }
        assert_eq!(log.last_log_id().unwrap().is_some(), has_prefix);
        send_recovery_record(&a.copies, &b.id, "first-repair");
        for n in 0..PAGE {
            let id = format!("paged-repair-{n}");
            let fields = json!({"kind": "note", "text": id}).as_object().unwrap().clone();
            log.write(&[(&id, "note", Some(fields))], Actor::by("settle")).unwrap();
        }
        let copies = a.copies.clone();
        let from = b.id.clone();
        *faults.on_page_failure.lock().unwrap() = Some(Arc::new(move || send_recovery_record(&copies, &from, "newer-repair")));
        faults.pages_before_failure.store(1, Ordering::Release);
        assert_eq!(a.copies.take_settled(), 0, "a failed second page must not apply the first page's ids");
        assert_eq!(faults.pages_before_failure.load(Ordering::Acquire), -1, "the second page refused once");
        assert!(a.record("first-repair").is_none());
        assert!(a.record("paged-repair-0").is_none());
        assert_eq!(a.copies.take_settled(), PAGE + 2, "the failed attempt's earlier cursor wins over the newer settle's");
        for id in ["first-repair", "paged-repair-0", "newer-repair"] {
            assert_eq!(a.record(id).unwrap().0, 1);
            assert!(b.record(id).is_some(), "{id}: the repaired write was acknowledged");
        }
        assert_eq!(a.copies.take_settled(), 0, "completed repair does not replay");
    }
}

#[test]
fn a_carry_readback_failure_leaves_no_partial_destination_and_retry_preserves_newer_records() {
    use crate::storage::{record_store::{RecordStore, RealClock}, sqlite, Range, Read};
    let world = world(&[0, 1]);
    world.start_with_a();
    let a = world.at("A");
    let resource = "@list/carry-retry";
    let source = sqlite::open_owned(&a.state.join("carry-source.sqlite"), "record_store", crate::storage::record_store_resources::bounds()).unwrap();
    let mut source_records = RecordStore::new(&source, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
    source_records.mutate_local_with_check(OWNER, resource, Mutation { id: "row".into(), expected_version: 0, request_key: "source-row".into(), deleted: false, value: json!({"kind": "row", "text": "carried"}) }, || Ok(())).unwrap();
    let faults = RecoveryFaults::unarmed();
    let destination = RecoveryStore {
        inner: Box::new(sqlite::open_owned(&a.state.join("carry-destination.sqlite"), "record_store", crate::storage::record_store_resources::bounds()).unwrap()),
        faults: faults.clone(), selected: true,
    };
    faults.readback.store(true, Ordering::Release);
    assert!(a.copies.carry_own_resource(&source, &destination, resource).is_err(), "the page was written but could not be read back");
    assert!(!faults.readback.load(Ordering::Acquire), "the readback refused once");
    assert!(destination.scan("versions", &Range::all(), &[Read::whole("id")]).unwrap().is_empty(), "the outer scope rolled the written page back");
    assert!(a.copies.carry_own_resource(&source, &destination, resource).unwrap().unwrap().may_retire, "retry verifies the whole carry");
    let mut records = RecordStore::new(&destination, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
    assert_eq!(records.current_record(OWNER, resource, "row").unwrap().unwrap().value["text"], "carried");
    records.mutate_local_with_check(OWNER, resource, Mutation { id: "row".into(), expected_version: 1, request_key: "newer-row".into(), deleted: false, value: json!({"kind": "row", "text": "newer"}) }, || Ok(())).unwrap();
    assert!(a.copies.carry_own_resource(&source, &destination, resource).unwrap().is_none(), "a populated destination belongs to its live writes");
    assert_eq!(records.current_record(OWNER, resource, "row").unwrap().unwrap().value["text"], "newer");
    assert_eq!(source_records.current_record(OWNER, resource, "row").unwrap().unwrap().value["text"], "carried", "the original source stays intact");
}

#[test]
fn the_timer_retries_a_resource_carry_once_its_destination_can_be_written() {
    use crate::{records::Records, storage::{record_store::{RecordStore, RealClock}, sqlite, Intent, Scope}};
    let world = world(&[0, 1]);
    let a = world.at("A");
    let resource = "@list/carry-after-busy";
    let source = sqlite::open_owned(&a.state.join("records.sqlite"), "record_store", crate::storage::record_store_resources::bounds()).unwrap();
    let mut old = RecordStore::new(source, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
    old.mutate(OWNER, resource, Mutation { id: "row".into(), expected_version: 0, request_key: "old-row".into(), deleted: false, value: json!({"kind": "row", "text": "kept in the book"}) }).unwrap();
    let own = crate::storage::record_store_resources::placement(resource).unwrap().in_state_for(resource, &a.state).unwrap();
    let destination = sqlite::open_owned(&own, "record_store", crate::storage::record_store_resources::bounds()).unwrap();
    let busy = Scope::begin(&destination, Intent::Write).unwrap();
    world.start_with_a();
    busy.rollback().unwrap();
    assert!(a.copies.read(resource, "row").unwrap().record.is_none(), "the first timer pass could not reserve the destination");
    world.tick(&["A"]);
    assert_eq!(a.copies.read(resource, "row").unwrap().record.unwrap().value["text"], "kept in the book", "a refused pass was not marked complete");
    assert_eq!(a.copies.carry_into_own_files(), 0, "the completed destination is not carried over again");
}

/// The two-full-computer move failed on base main under the full integration suite: the new row was already told,
/// but its sole answering survivor still said catching_up until it claimed. Joining an idle account gets the root
/// and records without a live writer's sign-in readback. Keep the writer serving until the ordinary pull verifies
/// that readback, then exercise the actual signed row change and the successor's re-key without clearing readiness.
#[test]
fn a_writer_moves_only_after_its_survivor_reads_back_and_the_survivor_keeps_answering_through_rekey() {
    use crate::account::rows::store::{Family, Row};
    let world = world_keeping_with_joining(&[0, 1], 1 << 20, None, Some(1));
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    let address = world.account.address();
    let row_id = super::Subject::Account(address.clone()).row_id();
    let initial = a.copies.row();
    // As a real account starts, the signing key and signed computers row are already in the first computer's own
    // sign-in storage. The copies log captures them once A claims and sends them through its acknowledged feed.
    let raw = Store::new(&*a.raw);
    super::keep_public_key(&raw, OWNER, &world.account).unwrap();
    raw.put(Family::Computers, &Row { id: row_id.clone(), account: OWNER.into(), expires_at: 0, value: initial.clone() }).unwrap();
    world.tick(&["B"]);
    assert!(b.copies.joined() && b.copies.holds_secrets_key(), "the idle join actually caught up and received its root");
    assert!(!b.copies.answers_now(), "an idle join has not read back a live writer's account rows");
    world.tick(&["A"]);
    assert_eq!(world.writers(), vec!["A"]);
    a.write("before-move", json!({"kind": "note", "text": "acknowledged before the move"})).unwrap();
    assert!(a.copies.caught_up(&b.id), "B holds the acknowledged record stamps");
    assert!(b.record("before-move").is_some());
    assert!(!b.copies.answers_now(), "record acknowledgement is not the sign-in readback");

    let keepers = vec![b.id.clone(), c.id.clone()];
    let next = ComputersRow::sign_with_voters(&address, initial.revision + 1, &keepers, &[b.id.clone()], &keepers, &world.account).unwrap();
    let change = Row { id: row_id.clone(), account: OWNER.into(), expires_at: 0, value: next.clone() };
    assert!(a.store().put(Family::Computers, &change).is_err(), "the signed move is refused before it can strand calls");
    assert_eq!(a.copies.row(), initial, "A's serving row did not change");
    assert_eq!(b.copies.row(), initial, "B was not told an unmade row");
    assert_eq!(world.writers(), vec!["A"], "a refused move does not give up the writer turn");

    world.tick(&["B"]);
    assert!(b.copies.answers_now() && b.copies.may_admit(), "B's normal pull completes readback while A still serves");
    world.net.unsupported_ready.lock().unwrap().insert(b.id.clone());
    assert!(a.store().put(Family::Computers, &change).is_err(), "an unsupported optional probe cannot prove readiness");
    assert!(a.copies.caught_up(&b.id), "the ordinary stamps exchange still works with that computer");
    a.write("while-probe-unsupported", json!({"kind": "note", "text": "ordinary replication still works"})).unwrap();
    assert!(b.record("while-probe-unsupported").is_some(), "the readiness refusal did not disrupt ordinary replication");
    world.net.unsupported_ready.lock().unwrap().remove(&b.id);
    let old_root = secrets_key::key_identity(b.copies.keyring().unwrap().current()).unwrap();
    a.store().put(Family::Computers, &change).unwrap();
    assert_eq!(b.copies.row(), next);
    assert!(a.copies.removed() && !a.copies.holds_secrets_key());
    assert!(b.copies.answers_now() && b.copies.may_admit(), "the actual removal leaves B ready before it claims");
    world.run(2, &["B", "C"]);
    assert_eq!(world.writers(), vec!["B"]);
    b.copies.rekey().unwrap();
    let keyring = b.copies.keyring().unwrap();
    assert_ne!(secrets_key::key_identity(keyring.current()).unwrap(), old_root, "the new writer actually replaced its root");
    assert!(keyring.get(&old_root).is_some(), "the old root remains available for earlier sealed values");
    assert!(b.copies.answers_now() && b.copies.may_admit(), "re-key does not clear the completed readback");
    assert_eq!(b.record("before-move").unwrap().1["text"], "acknowledged before the move");
    b.write("after-move", json!({"kind": "note", "text": "acknowledged after re-key"})).unwrap();
    assert!(c.record("after-move").is_some(), "the successor's new write was acknowledged by its remaining copy");
}

/// Read-your-writes on the writer: a queued write (136) settles, then an ordinary store write (140) of the same record commits,
/// and a read by id must answer 140. The queued head must not keep serving the value the store has already replaced.
#[test]
fn a_read_by_id_after_an_ordinary_write_answers_that_write_not_the_queued_head() {
    use crate::account::computers::copies::pending;
    let world = world(&[0, 1]);
    prime_writer(&world, "A");
    world.run(2, &["A", "B"]);
    assert!(world.at("A").copies.writes_here(), "A holds a live writer term before it settles its queue");
    let a = world.at("A");
    let reader = "key:synthetic-reader";
    let queued = pending::Command {
        owner: OWNER.into(), sign_in: reader.into(), resource: "@own-records".into(), operation: "records:write".into(),
        request_key: "queued-136".into(),
        input: json!({"records":[{"id":"note","type":"note","value":{"words":"136"}}]}),
        scope: None, source_generation: 1,
        request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![pending::Projection { id: "note".into(), kind: "note".into(), value: Some(json!({"words":"136"})) }],
    };
    a.copies.set_pending_handler(Arc::new(move |_: &pending::Command| Some(pending::Terminal {
        cause: crate::cause!(pending terminal), status: 200, body: json!({"result":{"structuredContent":{"changed":true}}}), refused: false })));
    crate::record_model_policy::install_test_tools(&a.state);
    let submitted = a.copies.queue_pending(queued).unwrap();
    assert_eq!(a.copies.settle_pending(), 1, "the queued write settles at the writer");
    assert!(a.copies.pending_result(&submitted.id).unwrap().is_some_and(|terminal| !terminal.refused));
    a.write("note", own_body("note", r#"{"words":"140"}"#)).unwrap();
    assert_eq!(a.record("note").unwrap().1, own_body("note", r#"{"words":"140"}"#), "the store holds the ordinary write");
    // A record committed after the head's base is read through the ordinary store (pending.rs `latest`): the head steps aside,
    // and the route answers the store's 140 (hosting/pending.rs `local_record_unavailable` goes on to the ordinary read).
    assert!(a.copies.pending_projection(reader, "note", None, 1).unwrap().is_none(), "a read by id never answers the queued head's 136");
}

/// The own-records store keeps each record as its body { kind, sequence, stored, meta, protected } (native::body, as
/// own_records.rs:1008 writes it). A read by id through the copy answers the record's value, not that body, while a
/// queued head is in front of it.
#[test]
fn a_read_by_id_of_a_body_stored_record_answers_its_value_not_the_stored_body() {
    use crate::account::computers::copies::pending;
    let world = world(&[0, 1]);
    prime_writer(&world, "A");
    world.run(2, &["A", "B"]);
    let a = world.at("A");
    let reader = "key:synthetic-reader";
    let queued = pending::Command {
        owner: OWNER.into(), sign_in: reader.into(), resource: "@own-records".into(), operation: "records:write".into(),
        request_key: "queued-body-136".into(),
        input: json!({"records":[{"id":"note","type":"note","value":{"words":"136"}}]}),
        scope: None, source_generation: 1,
        request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![pending::Projection { id: "note".into(), kind: "note".into(), value: Some(json!({"words":"136"})) }],
    };
    a.copies.set_pending_handler(Arc::new(move |_: &pending::Command| Some(pending::Terminal {
        cause: crate::cause!(pending terminal), status: 200, body: json!({"result":{"structuredContent":{"changed":true}}}), refused: false })));
    crate::record_model_policy::install_test_tools(&a.state);
    let submitted = a.copies.queue_pending(queued).unwrap();
    assert_eq!(a.copies.settle_pending(), 1, "the queued write settles at the writer");
    assert!(a.copies.pending_result(&submitted.id).unwrap().is_some_and(|terminal| !terminal.refused));
    a.write("note", own_body("note", r#"{"words":"140"}"#)).unwrap();
    // The ordinary write is a body-stored record newer than the head's base (kept through `stored_form`, so the base is the
    // record's version): the head steps aside and the ordinary read answers, never the stored body as the head's value.
    assert!(a.copies.pending_projection(reader, "note", None, 1).unwrap().is_none(), "a read by id never answers the stored body as the head's value");
    assert_eq!(a.record("note").unwrap().1, own_body("note", r#"{"words":"140"}"#), "the store holds the ordinary write");
}

/// A head written before bases existed, on a computer that does not write: it keeps its own head until the writer settles it,
/// even when its store has caught up to a later committed value (the copy cannot tell which is newer without a base).
#[test]
fn a_base_less_head_on_a_non_writer_keeps_its_head_until_the_writer_settles_it() {
    use crate::account::computers::copies::pending;
    let world = world(&[0, 1]);
    prime_writer(&world, "A");
    world.run(2, &["A", "B"]);
    let (a, b) = (world.at("A"), world.at("B"));
    assert!(!b.copies.writes_here(), "B does not write, so it cannot settle its own head");
    let reader = "key:synthetic-reader";
    let queued = pending::Command {
        owner: OWNER.into(), sign_in: reader.into(), resource: "@own-records".into(), operation: "records:write".into(),
        request_key: "unbased-136-at-b".into(),
        input: json!({"records":[{"id":"note","type":"note","value":{"words":"136"}}]}),
        scope: None, source_generation: 1,
        request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![pending::Projection { id: "note".into(), kind: "note".into(), value: Some(json!({"words":"136"})) }],
    };
    b.copies.queue_pending_unbased(queued).unwrap();
    a.write("note", own_body("note", r#"{"words":"140"}"#)).unwrap();
    world.run(2, &["A", "B"]);
    assert_eq!(b.record("note").unwrap().1, own_body("note", r#"{"words":"140"}"#), "B's store has caught up to the writer's 140");
    let read = b.copies.pending_projection(reader, "note", None, 1).unwrap().expect("the record has a local image");
    assert_eq!(read.value, Some(json!({"words":"136"})), "B keeps its base-less head until the writer settles it, and does not guess");
}

mod independent_groups {
    use super::*;
    use crate::storage::{record_store::{RecordStore, RealClock}, record_store_resources::{domains::{Bound, Selection, Identity}, carry::{commit_log, live_adopt}, StateResources}, sqlite::{self, Access}};
    use super::super::messages::{GroupRequest, GroupAnswer};
    use std::time::{Duration, Instant};

    fn identity() -> Identity { Identity { id: "synthetic-copy-group".into(), incarnation: "first".into(), generation: 1 } }
    fn copy_key(scope: &Identity, resource: &str) -> String {
        super::super::copies::group_key(scope, resource).unwrap()
    }
    fn write_group(world: &World, words: &str, version: i64) { write_group_finish(world,words,version,true); }
    fn write_group_finish(world: &World, words: &str, version: i64, commit:bool) {
        write_group_values(world,words,version,commit,false);
    }
    fn write_group_values(world: &World, words: &str, version: i64, commit:bool, only_large_effect:bool) {
        write_group_on(world,"A",identity(),words,version,commit,true,only_large_effect);
    }
    fn write_group_on(world:&World,computer:&str,scope:Identity,words:&str,version:i64,commit:bool,finalize:bool,only_large_effect:bool) {
        let a = world.at(computer);
        let resources = Arc::new(StateResources::new(&a.state, crate::sqlite_work::WorkMeter::new()).unwrap());
        let domain = Bound::new(resources, OWNER, Selection { id: scope.id.clone(), incarnation: scope.incarnation.clone(), generation: 1, create: true }, 1).unwrap();
        let writer = domain.writer().unwrap();
        let lent = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(20)).unwrap();
        let tx = lent.begin(rusqlite::TransactionBehavior::Immediate).unwrap();
        let changes = crate::records::changes::HeldChanges::begin();
        let raw = sqlite::lend(&tx, "record_store", Access::Write).unwrap();
        let limits = crate::storage::record_store::settings::shipped().unwrap().live_adoption;
        let capture = live_adopt::CommandCapture::unbound(&raw, limits);
        let recorded = live_adopt::Recording::new(raw);
        recorded.bind(Some(capture.clone()));
        let mut store = RecordStore::new(&recorded, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
        if store.held_version(OWNER, crate::local_account::own_records::IDENTITY, "command-domain").unwrap() == 0 {
            store.mutate_local_with_check(OWNER, crate::local_account::own_records::IDENTITY, Mutation { id: "command-domain".into(), expected_version: 0, request_key: "install-group".into(), deleted: false, value: json!(scope) }, || Ok(())).unwrap();
        }
        for (resource, id) in [(RESOURCE,"effect"),(crate::local_account::own_records::KEYS,"field-key"),(crate::local_account::own_records::COMMANDS,"original-receipt")] {
            let value=if only_large_effect && resource!=RESOURCE {json!({"words":"bounded companion"})}else{json!({"words":words})};
            store.mutate_local_with_check(OWNER, resource, Mutation { id: id.into(), expected_version: version, request_key: format!("group-{version}-{id}"), deleted: false, value }, || Ok(())).unwrap();
        }
        drop(store);
        let effects = capture.final_effects(&recorded).unwrap();
        let stream = live_adopt::command_slot(OWNER, &json!(scope)).unwrap();
        let frame = commit_log::append_commit(&recorded, &stream, &format!("synthetic-command-{version}"), &effects, limits).unwrap();
        a.copies.acknowledge_captured(&recorded, &domain, Some(&frame)).unwrap();
        if commit {
            tx.commit().unwrap();
            let committed=sqlite::lend(lent.connection(),"record_store",Access::Write).unwrap();
            if finalize {a.copies.finalize_captured(&committed,&domain).unwrap();changes.published();}
        }else {tx.rollback().unwrap();}
    }
    fn words(world: &World, computer: &str, resource: &str, id: &str) -> String {
        world.at(computer).copies.read(&copy_key(&identity(),resource), id).unwrap().record.unwrap().value["words"].as_str().unwrap().into()
    }

    fn finalize_group(world:&World,computer:&str,scope:Identity)->Result<(),crate::records::Error> {
        let computer=world.at(computer);let resources=Arc::new(StateResources::new(&computer.state,crate::sqlite_work::WorkMeter::new()).unwrap());
        let domain=Bound::new(resources,OWNER,Selection {id:scope.id,incarnation:scope.incarnation,generation:scope.generation,create:false},1).unwrap();
        let writer=domain.writer().unwrap();let lent=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(20)).unwrap();
        let storage=sqlite::lend(lent.connection(),"record_store",Access::Write).unwrap();
        computer.copies.finalize_captured(&storage,&domain)
    }
    fn assert_physical_words(world:&World,computer:&str,wanted:&str) {
        physical(world,computer,|storage| {
            let store=RecordStore::new(storage,Box::new(RealClock),Limits::fixed(1<<20,1<<30)).unwrap();
            assert_eq!(store.current_record(OWNER,RESOURCE,"effect").unwrap().unwrap().value["words"],wanted);
        });
    }

    fn group_answer(world:&World,from:&str,to:&str,message:Message)->Answer {
        let link=NetLink {me:world.at(from).id.clone(),net:world.net.clone()};
        super::super::copies::send_in_parts(&link,&world.at(to).id,&message).expect("actual bounded multipart transport")
    }
    fn physical<T>(world:&World,computer:&str,work:impl FnOnce(&dyn crate::storage::Storage)->T)->T {
        let computer=world.at(computer);
        let resources=Arc::new(StateResources::new(&computer.state,crate::sqlite_work::WorkMeter::new()).unwrap());
        let scope=identity();let domain=Bound::new(resources,OWNER,Selection {id:scope.id,incarnation:scope.incarnation,generation:scope.generation,create:true},1).unwrap();
        let readers=domain.readers().unwrap();
        let raw=sqlite::open_owned(readers.path(),"record_store",crate::storage::record_store_resources::bounds()).unwrap();
        work(&raw)
    }
    fn trim_group(world:&World,computer:&str,through:i64,opaque:bool) {
        physical(world,computer,|store| {
            let stream=live_adopt::command_slot(OWNER,&json!(identity())).unwrap();
            let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
            if opaque {assert_eq!(commit_log::trim_opaque_through(store,&stream,through,limits).unwrap(),through);}
            else {assert_eq!(commit_log::trim_through(store,&stream,through,limits).unwrap(),through);}
        });
    }
    fn full_image(world:&World,computer:&str)->Vec<(String,Vec<crate::storage::Row>)> {
        physical(world,computer,|store|store.schema().families.iter()
            .filter(|family|!commit_log::opaque_map::is_transport_family(&family.family))
            .map(|family|{
                let reads=family.fields.iter().map(|field|crate::storage::Read::whole(field)).collect::<Vec<_>>();
                (family.family.clone(),store.scan(&family.family,&crate::storage::Range::all(),&reads).unwrap())
            }).collect())
    }

    #[test]
    fn a_maximum_public_record_value_crosses_the_real_encrypted_group_transport() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        let empty=serde_json::to_vec(&json!({"words":""})).unwrap().len();
        let words_value="x".repeat(crate::records::MAX_RECORD_BYTES-empty);
        let value=json!({"words":words_value});
        assert_eq!(serde_json::to_vec(&value).unwrap().len(),crate::records::MAX_RECORD_BYTES);
        let public=serde_json::to_vec(&json!({"scope":identity(),"records":[{"id":"effect","type":"synthetic","value":value}]})).unwrap();
        assert!(public.len()<=crate::mcp::request_bytes(),"the full scoped request fits the unchanged public request limit");
        write_group_values(&world,&words_value,0,true,true);
        assert_eq!(words(&world,"B",RESOURCE,"effect"),words_value,"the real bounded multipart/AEAD receiver retains every byte");
        let Answer::Group {answer:GroupAnswer::Page {term,base,mut commits,..}}=group_answer(&world,"B","A",Message::Group {request:GroupRequest::Pull {scope:identity(),writer:true,after:0}}) else{panic!("actual full frame through multipart Pull")};
        assert_eq!(commits.len(),1);
        let payload=commits.last_mut().unwrap().map.delta.updates.iter_mut().find_map(|update|update.payload.as_mut()).expect("actual row ciphertext");
        let mut envelope:serde_json::Value=serde_json::from_slice(payload).unwrap();
        let data=envelope["data"].as_str().unwrap();let changed=if data.starts_with('A'){format!("B{}",&data[1..])}else{format!("A{}",&data[1..])};envelope["data"]=json!(changed);*payload=serde_json::to_vec(&envelope).unwrap();
        let changed=Message::Group {request:GroupRequest::Push {scope:identity(),term,base,after:0,commits}};
        assert!(matches!(group_answer(&world,"A","B",changed),Answer::Refused {..}),"a compact root-authenticated commitment still refuses a substituted map delta");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),words_value);
        assert!(*world.net.largest.lock().unwrap()<=settings().message_body_bytes,"each part keeps the existing message bound");
    }

    #[test]
    fn a_current_retained_tail_is_applied_without_bootstrapping_the_same_history() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"one",0);
        world.set_down("B",true);write_group(&world,"two",1);world.set_down("B",false);
        let a=world.at("A");let b=world.at("B");let key=copy_key(&identity(),RESOURCE);
        let bootstraps=world.net.group_bootstraps.load(Ordering::Acquire);
        // A copy that lacks the group fetches it once from the writer, then reads it (012cdff09).
        b.copies.read(&key,"effect").expect("the copy fetches the group once and answers the current read");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"two");
        assert_eq!(world.net.group_bootstraps.load(Ordering::Acquire),bootstraps,"an available retained frame must use its complete-delta path");
        // Already current after the read's fetch: a further turn applies nothing.
        b.copies.catch_up_group_control(&a.id,&identity(),true).unwrap();
        assert_eq!(world.net.group_bootstraps.load(Ordering::Acquire),bootstraps);
    }

    #[test]
    fn retained_history_miss_reaches_bounded_physical_bootstrap_and_preserves_every_family() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        world.set_down("B",true);
        let writes=(crate::storage::record_store::settings::shipped().unwrap().live_adoption.page_rows/3+2) as i64;
        for version in 0..writes {write_group(&world,&format!("value-{version}"),version);}
        trim_group(&world,"A",writes-1,false);world.set_down("B",false);
        let a=world.at("A");let b=world.at("B");let mut turns=0;
        for _ in 0..100 {
            b.copies.catch_up_group_control(&a.id,&identity(),true).unwrap();turns+=1;
            if b.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_ok(){break;}
        }
        assert!(turns>1,"physical copy and materialization take bounded turns");
        assert!(turns<100,"the retained-history miss actually completes");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),format!("value-{}",writes-1));
        assert_eq!(full_image(&world,"B"),full_image(&world,"A"),"keys, receipts, tombstones, indexes and every current physical family are preserved");
    }

    #[test]
    fn a_read_while_a_bootstrap_is_in_progress_refuses_and_the_bootstrap_still_completes() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        world.set_down("B",true);
        let writes=(crate::storage::record_store::settings::shipped().unwrap().live_adoption.page_rows/3+2) as i64;
        for version in 0..writes {write_group(&world,&format!("value-{version}"),version);}
        trim_group(&world,"A",writes-1,false);world.set_down("B",false);
        let a=world.at("A");let b=world.at("B");
        // The first turn starts the bootstrap. A read now refuses: the group is not whole yet.
        b.copies.catch_up_group_control(&a.id,&identity(),true).unwrap();
        assert!(b.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),"a read during a bootstrap refuses until the group is whole");
        // The refused read did not reset the bootstrap: catch-up turns still complete it, and the read then answers.
        let mut previous=-1;
        for _ in 0..100 {
            let caught=b.copies.catch_up_group_control(&a.id,&identity(),true).unwrap();
            if caught==previous {break;}
            previous=caught;
        }
        assert_eq!(words(&world,"B",RESOURCE,"effect"),format!("value-{}",writes-1));
        assert!(b.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_ok(),"once whole, the copy answers the read");
    }

    #[test]
    fn opaque_relay_bootstraps_an_empty_peer_after_its_encrypted_tail_was_trimmed() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        world.set_down("B",true);
        for version in 0..3 {write_group(&world,&format!("private-{version}"),version);}
        trim_group(&world,"C",2,true);world.set_down("B",false);
        let c=world.at("C");let b=world.at("B");
        assert!(c.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),"compaction grants no root");
        let mut completed=false;
        for _ in 0..100 {
            b.copies.catch_up_group_control(&c.id,&identity(),false).unwrap();
            if b.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_ok(){completed=true;break;}
        }
        assert!(completed,"the copy-only relay supplies a complete snapshot without source plaintext");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"private-2");
        assert_eq!(full_image(&world,"B"),full_image(&world,"A"));
    }

    #[test]
    fn bootstrap_source_snapshot_is_pinned_retried_and_scope_bound() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        let writes=(crate::storage::record_store::settings::shipped().unwrap().live_adoption.page_rows/3+2) as i64;
        for version in 0..writes {write_group(&world,&format!("pinned-{version}"),version);}
        let a=world.at("A");let b=world.at("B");
        let first=Message::Group {request:GroupRequest::Bootstrap {scope:identity(),writer:true,snapshot:None,ordinal:0}};
        let answer=group_answer(&world,"B","A",first.clone());
        let Answer::Group {answer:GroupAnswer::Bootstrap {page,..}}=&answer else{panic!("source begins actual bootstrap")};
        assert!(!page.done,"exercise a later bounded page");let cut=page.head.clone();
        assert_eq!(group_answer(&world,"B","A",first),answer,"lost response retries exact ciphertext/page");
        write_group(&world,"after snapshot",writes);
        let wrong=Identity {incarnation:"wrong".into(),..identity()};
        assert!(matches!(a.copies.answer(&b.id,Message::Group {request:GroupRequest::Bootstrap {scope:wrong,writer:true,snapshot:Some(cut.snapshot.clone()),ordinal:1}}),Answer::Refused {..}));
        let mut ordinal=1;let mut done=false;
        for _ in 0..100 {
            let answer=group_answer(&world,"B","A",Message::Group {request:GroupRequest::Bootstrap {scope:identity(),writer:true,snapshot:Some(cut.snapshot.clone()),ordinal}});
            let Answer::Group {answer:GroupAnswer::Bootstrap {page,seal,..}}=answer else{panic!("same pinned cursor")};
            assert_eq!(page.head,cut,"new commits cannot change a resumed cut");
            if let Some(seal)=seal {assert_eq!(seal.head,cut);done=true;break;}
            ordinal+=1;
        }
        assert!(done);assert_eq!(cut.through,writes);assert_eq!(words(&world,"A",RESOURCE,"effect"),"after snapshot");
    }

    #[test]
    fn chosen_complete_copy_claims_only_after_actual_writer_release_and_quorum() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"before handover",0);
        let a=world.at("A");let b=world.at("B");let term=a.copies.holding().unwrap();
        assert!(matches!(b.copies.answer(&a.id,Message::Group {request:GroupRequest::TakeWriter {scope:identity(),released_term:term}}),Answer::Refused {..}),"an invitation cannot replace a live lease");
        assert!(a.copies.hand_over_domain_to(&identity(),&b.id).unwrap(),"the chosen eligible copy actually wins the existing votes");
        assert_eq!(world.writers(),vec!["B"]);
        assert!(a.copies.hand_over_domain_to(&identity(),&b.id).unwrap(),"same chosen successor readback is idempotent");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"before handover");
    }

    #[test]
    fn prepared_rollback_is_not_promoted_on_election_and_uncertain_a_does_not_hold_b() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"committed",0);write_group_finish(&world,"aborted",1,false);
        assert_physical_words(&world,"B","committed");
        world.set_down("A",true);world.run(world.term_runs_out()+8,&["B","C"]);
        assert_eq!(world.writers(),vec!["B"],"the finalized prefix can elect without exposing pending A");
        assert!(world.at("B").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),"unknown original source fences only its domain");
        let other=Identity {id:"independent-pending-control".into(),..identity()};
        write_group_on(&world,"B",other.clone(),"B commits",0,true,true,false);
        assert_eq!(world.at("B").copies.read(&copy_key(&other,RESOURCE),"effect").unwrap().record.unwrap().value["words"],"B commits");
        world.set_down("A",false);
        world.at("B").copies.open_held().unwrap();
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"committed","actual ordered source absence resolves the aborted preparation");
        write_group_on(&world,"B",identity(),"retried exactly once",1,true,true,false);
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"retried exactly once");
    }

    #[test]
    fn source_commit_before_finalize_is_recovered_without_fresh_effect_dispatch() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"committed",0);
        write_group_on(&world,"A",identity(),"source actually committed",1,true,false,false);
        assert_physical_words(&world,"B","committed");
        assert!(world.at("A").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),"source cannot disclose before finalized-copy proof");
        world.set_down("A",true);world.run(world.term_runs_out()+8,&["B","C"]);
        assert_eq!(world.writers(),vec!["B"]);
        assert!(world.at("B").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err());
        world.set_down("A",false);
        world.at("B").copies.open_held().unwrap();
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"source actually committed");
        physical(&world,"B",|storage| {
            let stream=live_adopt::command_slot(OWNER,&json!(identity())).unwrap();let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
            assert_eq!(commit_log::physical_commit(storage,&stream,2,limits).unwrap().unwrap().identity,"synthetic-command-1","recover the original command, never dispatch a replacement");
        });
    }

    #[test]
    fn trimmed_original_frame_is_unknown_and_pending_peer_recovers_a_full_current_cut() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"before",0);write_group_on(&world,"A",identity(),"committed but reply missed",1,true,false,false);
        let digest=physical(&world,"A",|storage| {
            let stream=live_adopt::command_slot(OWNER,&json!(identity())).unwrap();let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
            commit_log::digest_of(&commit_log::physical_commit(storage,&stream,2,limits).unwrap().unwrap(),limits).unwrap()
        });
        world.set_down("B",true);finalize_group(&world,"A",identity()).unwrap();write_group(&world,"later committed cut",2);world.set_down("B",false);
        assert!(matches!(world.at("A").copies.answer(&world.at("B").id,Message::Group {request:GroupRequest::Resolve {scope:identity(),sequence:2,digest}}),Answer::Refused {..}),"trimmed committed frame must not become false rollback evidence");
        assert_physical_words(&world,"B","before");let bootstraps=world.net.group_bootstraps.load(Ordering::Acquire);let mut complete=false;
        for _ in 0..100 {
            world.at("B").copies.catch_up_group_control(&world.at("A").id,&identity(),true).unwrap();
            if world.at("B").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_ok(){complete=true;break;}
        }
        assert!(complete);assert!(world.net.group_bootstraps.load(Ordering::Acquire)>bootstraps);
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"later committed cut");assert_eq!(full_image(&world,"A"),full_image(&world,"B"));
    }

    #[test]
    fn a_rolled_back_first_command_can_retry_with_its_new_source_token_key() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group_on(&world,"A",identity(),"never committed",0,false,false,false);
        assert!(world.at("B").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err());
        write_group(&world,"first real commit",0);
        assert_eq!(words(&world,"A",RESOURCE,"effect"),"first real commit");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"first real commit");
        assert_eq!(full_image(&world,"A"),full_image(&world,"B"));
    }

    #[test]
    fn an_old_source_rejoins_after_the_successor_advances_past_its_pending_frame() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"before",0);write_group_on(&world,"A",identity(),"old source committed",1,true,false,false);
        world.set_down("A",true);world.run(world.term_runs_out()+8,&["B","C"]);assert_eq!(world.writers(),vec!["B"]);
        world.set_down("A",false);world.at("B").copies.open_held().unwrap();
        let term=world.at("B").copies.holding().unwrap();
        assert!(matches!(world.at("C").copies.answer(&world.at("B").id,Message::Group {request:GroupRequest::Push {scope:identity(),term,base:2,after:2,commits:vec![]}}),Answer::Group {answer:GroupAnswer::Applied {through:2}}));
        world.set_down("A",true);write_group_on(&world,"B",identity(),"successor advanced",2,true,true,false);world.set_down("A",false);
        assert!(world.at("A").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err());
        let bootstraps=world.net.group_bootstraps.load(Ordering::Acquire);
        let mut complete=false;
        for _ in 0..100 {
            // A missed the election while down. Its ordinary vote/stamps path
            // must first learn B's current lease, then run bounded repair.
            world.run(1,&["B","C","A"]);
            if world.at("A").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_ok(){complete=true;break;}
        }
        assert!(complete,"old source's conservative pending fence resolves through full canonical replacement");
        assert!(world.net.group_bootstraps.load(Ordering::Acquire)>bootstraps);
        assert_eq!(words(&world,"A",RESOURCE,"effect"),"successor advanced");
        assert_eq!(full_image(&world,"A"),full_image(&world,"B"));
    }

    #[test]
    fn original_source_absence_is_never_accepted_ahead_of_its_physical_writer() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"committed",0);
        let a=world.at("A");let resources=Arc::new(StateResources::new(&a.state,crate::sqlite_work::WorkMeter::new()).unwrap());
        let scope=identity();let domain=Bound::new(resources,OWNER,Selection {id:scope.id.clone(),incarnation:scope.incarnation.clone(),generation:scope.generation,create:false},1).unwrap();
        let writer=domain.writer().unwrap();let lent=writer.lend(Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(20)).unwrap();
        let tx=lent.begin(rusqlite::TransactionBehavior::Immediate).unwrap();
        let raw=sqlite::lend(&tx,"record_store",Access::Write).unwrap();let stream=live_adopt::command_slot(OWNER,&json!(scope)).unwrap();let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
        let first=commit_log::physical_commit(&raw,&stream,1,limits).unwrap().unwrap();
        let second=commit_log::append_commit(&raw,&stream,"paused-physical-source",&first.effects,limits).unwrap();
        let digest=commit_log::digest_of(&second,limits).unwrap();drop(raw);
        let source=a.copies.clone();let from=world.at("B").id.clone();let request=Message::Group {request:GroupRequest::Resolve {scope,sequence:2,digest}};
        let retry=request.clone();let (send,receive)=std::sync::mpsc::channel();
        let task=std::thread::spawn(move||send.send(source.answer(&from,request)).unwrap());
        let early=receive.recv_timeout(Duration::from_millis(100)).ok();
        assert!(!matches!(early,Some(Answer::Group {answer:GroupAnswer::Resolved {committed:false,..}})),"a read snapshot's missing uncommitted frame is not an absence proof");
        tx.commit().unwrap();
        let answer=early.unwrap_or_else(||receive.recv_timeout(Duration::from_secs(20)).unwrap());task.join().unwrap();
        let answer=if matches!(answer,Answer::Refused {..}) {a.copies.answer(&world.at("B").id,retry)}else{answer};
        assert!(matches!(answer,Answer::Group {answer:GroupAnswer::Resolved {committed:true,..}}),"physical reservation orders commit before resolution");
    }

    #[test]
    fn lost_finalize_replies_recover_the_original_receipt_without_another_effect() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"before",0);
        write_group_on(&world,"A",identity(),"committed once",1,true,false,false);
        world.net.lose_finalize_answers.store(true,Ordering::Release);
        assert!(finalize_group(&world,"A",identity()).is_err(),"no finalized quorum reply may disclose success");
        assert_physical_words(&world,"B","committed once");
        assert!(world.at("A").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),"unconfirmed source stays fenced");
        world.net.lose_finalize_answers.store(false,Ordering::Release);
        finalize_group(&world,"A",identity()).unwrap();
        assert_eq!(words(&world,"A",RESOURCE,"effect"),"committed once");
        assert_eq!(words(&world,"B",crate::local_account::own_records::COMMANDS,"original-receipt"),"committed once");
        physical(&world,"A",|storage| {
            let stream=live_adopt::command_slot(OWNER,&json!(identity())).unwrap();let limits=crate::storage::record_store::settings::shipped().unwrap().live_adoption;
            assert_eq!(commit_log::frontiers(storage,&stream,limits).unwrap().stored,2);
            assert_eq!(commit_log::physical_commit(storage,&stream,2,limits).unwrap().unwrap().identity,"synthetic-command-1");
            assert!(commit_log::physical_commit(storage,&stream,3,limits).unwrap().is_none(),"recovery never dispatches a new command");
        });
        finalize_group(&world,"A",identity()).unwrap();
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"committed once");
    }

    #[test]
    fn complete_group_is_retried_after_lost_ack_and_never_uses_primary_copy_keys() {
        let world = world(&[0,1]);
        prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();
        world.run(2,&["A","B","C"]);
        *world.net.lose_next_group_answer_from.lock().unwrap() = Some(world.at("B").id.clone());
        write_group(&world,"one",0);
        assert!(world.net.lose_next_group_answer_from.lock().unwrap().is_none());
        for (resource,id) in [(RESOURCE,"effect"),(crate::local_account::own_records::KEYS,"field-key"),(crate::local_account::own_records::COMMANDS,"original-receipt")] {
            assert_eq!(words(&world,"B",resource,id),"one");
            assert!(world.at("B").copies.read(resource,id).unwrap().record.is_none(), "a member is never replicated into the primary namespace");
        }
        let bad = Message::Push { term: world.at("A").copies.holding().unwrap(), resource: copy_key(&identity(),RESOURCE), after: 0, changes: vec![], base: 0 };
        assert!(matches!(world.at("B").copies.answer(&world.at("A").id,bad),Answer::Refused { .. }));
    }

    #[test]
    fn acknowledged_group_followed_by_local_rollback_cannot_disclose_the_aborted_postimage() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"committed",0);
        write_group_finish(&world,"not committed",1,false);
        assert_eq!(words(&world,"A",RESOURCE,"effect"),"committed");
        let peer=world.at("B").copies.read(&copy_key(&identity(),RESOURCE),"effect");
        if let Ok(read)=peer {assert_eq!(read.record.unwrap().value["words"],"committed","a durable acknowledgement cannot disclose a locally aborted postimage");}
    }

    #[test]
    fn a_reused_position_cannot_qualify_a_different_aborted_frame() {
        let world=world(&[0,1]);prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();world.run(2,&["A","B","C"]);
        write_group(&world,"committed",0);
        world.set_down("C",true);
        write_group_finish(&world,"aborted",1,false);
        world.set_down("B",true);
        world.set_down("C",false);
        write_group(&world,"new committed value",1);
        world.set_down("B",false);
        let a=world.at("A");let b=world.at("B");
        let positions=[&a.copies,&b.copies].map(|copies|match copies.answer(&world.at("C").id,Message::Group {request:GroupRequest::Probe {scope:identity()}}) {
            Answer::Group {answer:GroupAnswer::Stamps {through,..}}=>through,_=>panic!("actual prepared position"),
        });
        assert_eq!(positions[0],positions[1],"the physical prepared positions alone deliberately agree");
        assert_eq!(b.copies.stamp(&copy_key(&identity(),RESOURCE)),1,"election ranks only finalized history");
        assert_eq!(words(&world,"A",RESOURCE,"effect"),"new committed value");
        // A mismatched frame is not answered from; the read fetches the writer's group once and answers its committed value (012cdff09).
        b.copies.read(&copy_key(&identity(),RESOURCE),"effect").expect("a mismatched digest is repaired by one fetch, then read");
        assert_eq!(words(&world,"B",RESOURCE,"effect"),"new committed value");
    }

    #[test]
    fn bounded_inventory_discovers_opaque_only_history_without_granting_read_authority() {
        let world = world(&[0,1]);
        prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();
        world.run(2,&["A","B","C"]);
        world.set_down("B",true);
        write_group(&world,"synthetic-opaque-body-only",0);
        let c = world.at("C");
        let resources = Arc::new(StateResources::new(&c.state,crate::sqlite_work::WorkMeter::new()).unwrap());
        let mut inventory = crate::storage::record_store_resources::domains::Inventory::copies(resources,OWNER.into()).unwrap();
        let mut found = Vec::new();
        for page_number in 0..1000 {
            let (page,complete) = inventory.page(1,Arc::new(AtomicBool::new(false)),Instant::now()+Duration::from_secs(30)).unwrap();
            assert!(page.len() <= 1);
            found.extend(page);
            if complete { break; }
            assert!(page_number < 999,"bounded cursor reaches the end");
        }
        assert_eq!(found,vec![identity()]);
        assert!(c.copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err());
        let wrong = Identity { incarnation:"stale".into(),..identity() };
        assert!(matches!(c.copies.answer(&world.at("A").id,Message::Group { request:GroupRequest::Probe { scope:wrong } }),Answer::Refused {..}));
        for message in [
            Message::Pull { writer:false,resource:copy_key(&identity(),RESOURCE),after:0,limit:1 },
            Message::History { writer:false,resource:copy_key(&identity(),RESOURCE),id:"effect".into(),version:1,since:0,before:2,limit:1 },
        ] {
            assert!(matches!(c.copies.answer(&world.at("A").id,message),Answer::Refused {..}),"partial member feeds never expose a group");
        }
        let sent = serde_json::to_string(&world.net.last_group.lock().unwrap().clone().unwrap()).unwrap();
        for plain in ["synthetic-opaque-body-only","field-key","original-receipt","synthetic-command-"] {
            assert!(!sent.contains(plain),"physical values, keys and native identity remain inside ciphertext");
        }
    }

    #[test]
    fn a_late_member_fault_rolls_back_earlier_members_and_exact_retry_commits_all() {
        let world = world(&[0,1]);
        prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();
        world.run(2,&["A","B","C"]);
        write_group(&world,"one",0);
        world.set_down("B",true);
        write_group(&world,"two",1);
        let second=world.net.last_group.lock().unwrap().clone().unwrap();
        // B is down: C's durable acknowledgement was necessary for quorum,
        // so this observation has no race with an optional background send.
        assert!(world.at("C").copies.read(&copy_key(&identity(),RESOURCE),"effect").is_err(),
            "encrypted-only durable progress is never readable materialized data");
        let Answer::Group { answer: GroupAnswer::Stamps { through, materialized, .. } } = world.at("C").copies.answer(
            &world.at("A").id, Message::Group { request: GroupRequest::Probe { scope: identity() } }) else { panic!("encrypted durable frontier") };
        assert_eq!((through, materialized), (2, -1));
        write_group(&world,"three",2);
        let third=world.net.last_group.lock().unwrap().clone().unwrap();
        world.set_down("B",false);
        let a = world.at("A");
        assert!(matches!(a.copies.answer(&world.at("B").id,Message::Group {request:GroupRequest::Pull {scope:identity(),writer:true,after:1}}),Answer::Refused {..}),"an old retained-history cursor must bootstrap");
        let Message::Group {request:GroupRequest::Prepare {term,base,mut commits,..}}=second else{panic!("actual second complete-frame push")};
        let Message::Group {request:GroupRequest::Prepare {commits:last,..}}=third else{panic!("actual third complete-frame push")};
        assert_eq!(commits.last().unwrap().sequence,2);
        commits.extend(last.into_iter().filter(|wire|wire.sequence==3));
        assert_eq!(commits.len(),2,"exercise an applied prefix before the late authenticated fault using actual authenticated pushes");
        let valid = Message::Group { request: GroupRequest::Push { scope: identity(), term, base, after: 1, commits } };
        let mut broken = valid.clone();
        let Message::Group { request: GroupRequest::Push { commits, .. } } = &mut broken else { panic!("actual sent group") };
        commits.last_mut().unwrap().payload = "broken authenticated late frame".into();
        assert!(matches!(world.at("B").copies.answer(&world.at("A").id,broken),Answer::Refused { .. }));
        // Every resource is checked before any read: a read fetches the whole group once (012cdff09).
        for (resource,id) in [(RESOURCE,"effect"),(crate::local_account::own_records::KEYS,"field-key"),(crate::local_account::own_records::COMMANDS,"original-receipt")] {
            let b=world.at("B");
            let resources=Arc::new(StateResources::new(&b.state,crate::sqlite_work::WorkMeter::new()).unwrap());
            let scope=identity();
            let domain=Bound::new(resources,OWNER,Selection {id:scope.id,incarnation:scope.incarnation,generation:scope.generation,create:false},1).unwrap();
            let readers=domain.readers().unwrap();
            let raw=sqlite::open_owned(readers.path(),"record_store",crate::storage::record_store_resources::bounds()).unwrap();
            let store=RecordStore::new(raw,Box::new(RealClock),Limits::fixed(1<<20,1<<30)).unwrap();
            assert_eq!(store.current_record(OWNER,resource,id).unwrap().unwrap().value["words"],"one","no prefix of a failed group reaches physical state");
        }
        for (resource,id) in [(RESOURCE,"effect"),(crate::local_account::own_records::KEYS,"field-key"),(crate::local_account::own_records::COMMANDS,"original-receipt")] {
            let b=world.at("B");
            b.copies.read(&copy_key(&identity(),resource),id).expect("the stale copy fetches the group once and answers the current read (012cdff09)");
        }
        assert!(matches!(world.at("B").copies.answer(&world.at("A").id,valid.clone()),Answer::Group { answer: GroupAnswer::Applied { .. } }));
        assert!(matches!(world.at("B").copies.answer(&world.at("A").id,valid),Answer::Group { answer: GroupAnswer::Applied { .. } }));
        for (resource,id) in [(RESOURCE,"effect"),(crate::local_account::own_records::KEYS,"field-key"),(crate::local_account::own_records::COMMANDS,"original-receipt")] {
            assert_eq!(words(&world,"B",resource,id),"three");
        }
        let wrong = Identity { incarnation: "other".into(), ..identity() };
        assert!(matches!(world.at("B").copies.answer(&world.at("A").id,Message::Group { request: GroupRequest::Probe { scope: wrong } }),Answer::Refused { .. }));
    }
}


#[test]
fn an_aging_native_write_cannot_commit_without_its_original_voting_majority() {
    let world=world(&[0,1,2]);let a=world.at("A");
    prime_writer(&world,"A");world.at("A").write("ordinary",json!({"text":"prime writer"})).unwrap();
    let term=a.copies.holding().unwrap();let elapsed=crate::legacy_records::Bounds::default().elapsed;
    let advance=settings().term_ms-settings().clock_margin_ms-i64::try_from(elapsed.as_millis()).unwrap()+2;
    assert!(advance>0);world.clock.fetch_add(advance,Ordering::AcqRel);
    assert_eq!(a.copies.holding(),Some(term));let aging=a.copies.writer_row().unwrap().2;
    world.set_down("B",true);world.set_down("C",true);
    assert_eq!(a.copies.prepare_write_turn(),Ok(()),"admission keeps the held term without a voter round trip");
    assert!(matches!(a.write("no-effect-without-voters",json!({"kind":"note"})),Err(WriteRefused::NotAcknowledged(_))),"the commit fence refuses an aging term without its second copy's acknowledgement");
    assert!(a.record("no-effect-without-voters").is_none());
    assert_eq!(a.copies.writer_row().unwrap().2,aging,"the refused renewal did not extend the term");
}

fn assert_peer_refusal(answer: Answer, expected_code: &str) {
    let Answer::Refused { code, cause, .. } = answer else { panic!("expected a peer refusal") };
    assert_eq!(code, expected_code);
    assert!(!cause.file().is_empty());
    assert!(cause.line() > 0 && cause.column() > 0);
}

fn heard_format(computer: &str, sealed_versions: Option<Vec<u32>>, now: u64) -> super::copy_rule::Reported {
    super::copy_rule::Reported { computer: computer.to_owned(), always_on: true, takes_new_accounts: true, has_room: true, last_seen: now, sealed_versions, unit: None }
}

#[test]
fn a_snapshot_reaches_an_old_peer_in_the_old_format_and_a_new_peer_in_the_new_one() {
    let _heard = super::copy_rule::heard_lock_for_test();
    let world = world(&[0, 1, 2]);
    world.start_with_a();
    register_vaults(&world);
    let a = world.at("A");
    let (b, c) = (world.at("B"), world.at("C"));
    // B is an older build that reports no formats; C opens version 2 too. The heard reports are process-wide, so each
    // phase ends by putting every peer back to what it reports by default.
    let mut now: u64 = 1_000;
    super::copy_rule::hear_reports(vec![heard_format(&b.id, None, now), heard_format(&c.id, Some(vec![1, 2]), now)], now);
    vault_at(&world, a).put("alpha", secret("one")).unwrap();
    world.run(1, &["A", "B", "C"]);
    assert_eq!(a.copies.sealed_version(), 1, "an old peer holds the writer back to the old format");
    for name in ["B", "C"] {
        assert_eq!(vault_at(&world, world.at(name)).plain("alpha").unwrap().as_str(), "one", "{name} holds the snapshot in the old format");
    }

    now += 1;
    super::copy_rule::hear_reports(vec![heard_format(&b.id, Some(vec![1, 2]), now), heard_format(&c.id, Some(vec![1, 2]), now)], now);
    vault_at(&world, a).put("alpha", secret("two")).unwrap();
    world.run(1, &["A", "B", "C"]);
    assert_eq!(a.copies.sealed_version(), 2, "every peer opens version 2, so the writer seals in it");
    for name in ["B", "C"] {
        assert_eq!(vault_at(&world, world.at(name)).plain("alpha").unwrap().as_str(), "two", "{name} holds the snapshot in version 2");
    }

    now += 1;
    super::copy_rule::hear_reports(vec![heard_format(&b.id, None, now), heard_format(&c.id, None, now)], now);
}

#[test]
fn a_copy_only_peer_that_reports_no_formats_gets_the_snapshot_sealed_in_the_old_format() {
    let _heard = super::copy_rule::heard_lock_for_test();
    // A and B may answer; C only holds a copy and is an older build that reports no formats, so A keeps the old format.
    let world = world(&[0, 1]);
    world.start_with_a();
    register_vaults(&world);
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    let now: u64 = 1_000;
    super::copy_rule::hear_reports(vec![heard_format(&b.id, Some(vec![1, 2]), now), heard_format(&c.id, None, now)], now);
    vault_at(&world, a).put("alpha", secret("one")).unwrap();
    world.run(1, &["A", "B", "C"]);
    assert_eq!(a.copies.sealed_version(), 1, "the copy-only peer holds the writer back to the old format");
    let resource = crate::secrets::resource().unwrap();
    let kept = c.copies.read(resource, "value:alpha").unwrap().record.map(|record| record.value);
    let kept = kept.expect("the copy-only peer received the snapshot's value row");
    assert!(super::sealed::is_sealed(&kept), "it arrives sealed");
    assert_eq!(kept["sealed"], json!(1), "sealed in the old format it can open");
    super::copy_rule::hear_reports(vec![heard_format(&b.id, None, now + 1), heard_format(&c.id, None, now + 1)], now + 1);
}

/// A follower whose writer row names a computer that does not hold the turn (a stale row) asks that computer, is refused,
/// and follows the writer the refusal names, instead of asking the same computer again on every step (the 2026-11-11 hel1
/// storm: 7,329 `not_writer` refusals in 24 hours, the sender not named in the log).
#[test]
fn a_follower_refused_by_a_stale_writer_follows_the_writer_the_refusal_names() {
    let world = world(&[0, 1, 2]);
    prime_writer(&world, "A");
    let term = world.at("A").copies.holding().unwrap();
    let now = world.clock.load(Ordering::Acquire);
    // B's row names C, which holds nothing; C's row names the real writer A, live.
    world.at("B").copies.set_writer_row_for_test(&world.at("C").id, term, now + 9_000);
    world.at("C").copies.set_writer_row_for_test(&world.at("A").id, term, now + 9_000);
    world.at("B").copies.tick();
    assert_eq!(world.at("B").copies.writer_row().map(|(writer, _, _)| writer), Some(world.at("A").id.clone()),
        "B follows the writer that C's refusal names");
}

/// A computer refused with no live writer named does not lose its follower's pulls to the same computer again within one
/// renewal: the stale row is cleared, and the next step asks the voters, not the computer that refused.
#[test]
fn a_follower_refused_with_no_writer_named_does_not_ask_that_computer_again_within_a_renewal() {
    let world = world(&[0, 1, 2]);
    prime_writer(&world, "A");
    let term = world.at("A").copies.holding().unwrap();
    let now = world.clock.load(Ordering::Acquire);
    // C holds nothing and its row names no live writer (it names itself, expired); B's row still names C.
    world.at("C").copies.set_writer_row_for_test(&world.at("C").id, term, now - 1);
    world.at("B").copies.set_writer_row_for_test(&world.at("C").id, term, now + 9_000);
    let c = world.at("C").id.clone();
    let pulls_to_c = || world.net.sent.lock().unwrap().iter().filter(|(_, to, kind)| *to == c && *kind == "pull").count();
    world.at("B").copies.tick();
    let live_c = world.at("B").copies.writer_row().is_some_and(|(writer, _, expires)| writer == c && expires > now);
    assert!(!live_c, "B no longer holds C as a live writer once C refuses with no writer named");
    let before = pulls_to_c();
    world.at("B").copies.tick();
    assert_eq!(pulls_to_c(), before, "B does not ask C again within one renewal");
}

/// A joining computer that may answer and holds no root takes its root from a may-answer peer that holds it, even when its
/// writer row names a computer that does not answer. Before, the joiner followed the row's writer only: the root comes on a
/// sign-in pull from a computer that answers, so a silent row writer left the joiner without its root for ever (fsn1's four
/// accounts, 2026-11-11: joining with no key while hel1's claim waited for their Ready).
#[test]
fn a_joining_holder_takes_its_root_from_a_may_answer_peer_when_its_writer_row_names_a_silent_computer() {
    let world = world_keeping_with_joining(&[0, 1, 2], 1 << 20, None, Some(1));
    let (b, c) = (world.at("B"), world.at("C"));
    let now = world.clock.load(Ordering::Acquire);
    // B's writer row names C live; C does not answer.
    b.copies.set_writer_row_for_test(&c.id, 5, now + 9_000);
    world.set_down("C", true);
    assert!(!b.copies.holds_secrets_key(), "B starts with no root");
    b.copies.tick();
    assert!(b.copies.holds_secrets_key(), "B took its root from A, which holds it and may answer");
    // With C still silent, A and B are a majority of three: the claim follows once B's root is in.
    for _ in 0..12 {
        world.run(1, &["A", "B"]);
        if !world.writers().is_empty() { break; }
    }
    assert!(!world.writers().is_empty(), "A and B claim the writer turn once B holds its root");
}

/// A queued held-value write from a computer that holds a copy but is not the writer settles at the writer, and its receipt
/// comes back to that computer. Two computers in one world, as a place pair: A creates the account, names A and B, and holds the
/// writer turn; B joins, takes its root, and queues the command. This is the in-process form of the live proof's queued put
/// (key-custody-build: a failing-first test for the peer that cannot open the account).
#[test]
fn a_joined_peer_settles_its_queued_command_at_the_writer_and_the_receipt_returns() {
    use crate::account::rows::store::{Family, Row};
    use crate::account::computers::copies::pending;
    let world = world_keeping_with_joining(&[0, 1], 1 << 20, None, Some(1));
    let (a, b) = (world.at("A"), world.at("B"));
    let address = world.account.address();
    let row_id = super::Subject::Account(address.clone()).row_id();
    let raw = Store::new(&*a.raw);
    super::keep_public_key(&raw, OWNER, &world.account).unwrap();
    raw.put(Family::Computers, &Row { id: row_id, account: OWNER.into(), expires_at: 0, value: a.copies.row() }).unwrap();
    world.tick(&["B"]);
    assert!(b.copies.joined() && b.copies.holds_secrets_key(), "B joined and took its root before it queues anything");
    world.tick(&["A"]);
    assert_eq!(world.writers(), vec!["A"], "A holds the writer turn");

    let received = Arc::new(Mutex::new(Vec::new()));
    let seen = received.clone();
    a.copies.set_pending_handler(Arc::new(move |command: &pending::Command| {
        seen.lock().unwrap().push(command.request_key.clone());
        Some(pending::Terminal { cause: crate::cause!(pending terminal), status: 200,
            body: json!({"result":{"structuredContent":{"write_count":1}}}), refused: false })
    }));
    let command = pending::Command {
        owner: OWNER.into(), sign_in: "key:synthetic-queued-peer".into(),
        resource: "@own-records".into(), operation: "records:write".into(), request_key: "queued-from-b".into(),
        input: json!({"records":[{"id":"queued-note","type":"note","value":{"words":"queued at B"}}]}),
        scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![],
    };
    let queued = b.copies.queue_pending(command).unwrap();
    assert_eq!(b.copies.settle_pending(), 1, "B's queued command is settled by the writer");
    assert_eq!(*received.lock().unwrap(), vec!["queued-from-b".to_owned()], "the writer's own handler ran the command once");
    let receipt = b.copies.pending_result(&queued.id).unwrap().expect("the receipt returns to B");
    assert!(!receipt.refused, "the writer accepted it");
}

/// A lone holder: the one voter of its account, which took the writer turn by a write. When its term runs out with nothing asking
/// for the turn again, its own next timer step takes the term back, within one renewal period. Before, the row still named it as
/// writer, so it left itself out of its own claim, and an account in use with no other voter stayed without a writer.
#[test]
fn a_lone_holder_whose_term_ran_out_takes_it_back_on_its_own_timer() {
    let world = world_with_voters(&[0], &[0], 1 << 20, None, None);
    prime_writer(&world, "A");
    assert_eq!(world.writers(), vec!["A"]);
    let lapsed = settings().term_ms + 2 * settings().clock_margin_ms + settings().renew_every_ms;
    world.clock.fetch_add(lapsed, Ordering::AcqRel);
    assert!(world.at("A").copies.holding().is_none(), "the term ran out at the voter");
    world.clock.fetch_add(settings().renew_every_ms, Ordering::AcqRel);
    world.at("A").copies.tick();
    assert_eq!(world.writers(), vec!["A"], "the lone holder takes its term back within one renewal period");
}

/// A write at a copy whose account the computer's timer does not step yet asks for it first: the write is refused for the turn,
/// as it is with no term, and the computer's timer is told the account is used (`set_on_write`).
#[test]
fn a_write_asks_the_computers_timer_for_the_account_before_it_waits_for_the_turn() {
    let world = world(&[0]);
    let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = asked.clone();
    world.at("A").copies.set_on_write(Box::new(move || {
        counter.fetch_add(1, Ordering::AcqRel);
    }));
    assert!(world.at("A").write("asks-the-timer", json!({"kind": "note", "text": "a write to an idle account"})).is_err());
    assert_eq!(asked.load(Ordering::Acquire), 1, "the write asked the timer for the account once");
}

/// A computer that holds a live term but that the account's voters have taken out of the voter set settles nothing locally.
/// The account's own signed row, one revision on, names the voters without it, so the term it still holds is no longer one
/// the voters keep for it. Before, its local term alone settled the queued command and returned the receipt as the writer's.
#[test]
fn a_writer_removed_from_the_voters_settles_nothing_locally() {
    use crate::account::rows::store::{Family, Row};
    use crate::account::computers::copies::pending;
    let world = world_keeping_with_joining(&[0, 1], 1 << 20, None, Some(1));
    let (a, b) = (world.at("A"), world.at("B"));
    let address = world.account.address();
    let row_id = super::Subject::Account(address.clone()).row_id();
    let raw = Store::new(&*a.raw);
    super::keep_public_key(&raw, OWNER, &world.account).unwrap();
    raw.put(Family::Computers, &Row { id: row_id, account: OWNER.into(), expires_at: 0, value: a.copies.row() }).unwrap();
    world.tick(&["B"]);
    world.tick(&["A"]);
    assert_eq!(world.writers(), vec!["A"], "A holds the writer turn before its removal");

    let current = a.copies.row();
    let me = a.copies.computer().to_string();
    let voters: Vec<String> = current.voters.iter().filter(|voter| **voter != me).cloned().collect();
    let removed = super::ComputersRow::sign_with_voters(&address, current.revision + 1, &current.copy_keepers, &current.may_answer, &voters, &world.account).unwrap();
    let told = super::KeptAccount { row: removed, account_key: world.account.public_hex() };
    a.copies.answer(&b.id, Message::Row { told: Some(told), term: 0, made: true });

    let ran = Arc::new(Mutex::new(Vec::new()));
    let seen = ran.clone();
    a.copies.set_pending_handler(Arc::new(move |command: &pending::Command| {
        seen.lock().unwrap().push(command.request_key.clone());
        Some(pending::Terminal { cause: crate::cause!(pending terminal), status: 200,
            body: json!({"result":{"structuredContent":{"write_count":1}}}), refused: false })
    }));
    let command = pending::Command {
        owner: OWNER.into(), sign_in: "key:synthetic-queued-removed".into(),
        resource: "@own-records".into(), operation: "records:write".into(), request_key: "queued-at-removed-writer".into(),
        input: json!({"records":[{"id":"queued-note","type":"note","value":{"words":"queued at a removed writer"}}]}),
        scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![],
    };
    a.copies.queue_pending(command).unwrap();
    assert_eq!(a.copies.settle_pending(), 0, "a computer outside the voter set settles nothing locally");
    assert!(ran.lock().unwrap().is_empty(), "no handler ran for a computer the voters removed");
}

/// A computer that was never a voter never settles a command here: it answers as not the writer, and the command goes to a
/// voter that holds the writer turn. C may answer and keeps a copy, but the account's voters are A and B only.
#[test]
fn a_computer_that_was_never_a_voter_never_settles_locally() {
    use crate::account::computers::copies::pending;
    let world = world_with_voters(&[0, 1, 2], &[0, 1], 1 << 20, None, Some(2));
    let (a, c) = (world.at("A"), world.at("C"));
    world.tick(&["C"]);
    assert!(c.copies.joined() && c.copies.holds_secrets_key(), "C joined and took its root before it queues anything");
    world.tick(&["A"]);
    assert_eq!(world.writers(), vec!["A"], "A holds the writer turn");
    let ran_at_c = Arc::new(Mutex::new(Vec::new()));
    let seen = ran_at_c.clone();
    c.copies.set_pending_handler(Arc::new(move |command: &pending::Command| {
        seen.lock().unwrap().push(command.request_key.clone());
        Some(pending::Terminal { cause: crate::cause!(pending terminal), status: 200,
            body: json!({"result":{"structuredContent":{"write_count":1}}}), refused: false })
    }));
    let ran_at_a = Arc::new(Mutex::new(Vec::new()));
    let seen_a = ran_at_a.clone();
    a.copies.set_pending_handler(Arc::new(move |command: &pending::Command| {
        seen_a.lock().unwrap().push(command.request_key.clone());
        Some(pending::Terminal { cause: crate::cause!(pending terminal), status: 200,
            body: json!({"result":{"structuredContent":{"write_count":1}}}), refused: false })
    }));
    let command = pending::Command {
        owner: OWNER.into(), sign_in: "key:synthetic-queued-never-voter".into(),
        resource: "@own-records".into(), operation: "records:write".into(), request_key: "queued-at-never-voter".into(),
        input: json!({"records":[{"id":"queued-note","type":"note","value":{"words":"queued at a never-voter"}}]}),
        scope: None, source_generation: 1, request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
        bearer: "synthetic-only".into(), accepted_at_ms: 1_000_000, person_present: None, checked_kinds: vec![],
        projection: vec![],
    };
    c.copies.queue_pending(command).unwrap();
    assert_eq!(c.copies.settle_pending(), 1, "the writer settles the command for C");
    assert!(ran_at_c.lock().unwrap().is_empty(), "C's own handler never runs: it was never a voter");
    assert_eq!(*ran_at_a.lock().unwrap(), vec!["queued-at-never-voter".to_owned()], "the voter that holds the writer turn runs it once");
}

/// A row edit written to this computer's sign-in store is the row it tells next: the tell reads the newer of the cached row and
/// the stored one, so a `sign-in:set-places` edit (which writes the store and not the cache) is not told as its revision before.
#[test]
fn a_row_edit_written_to_the_store_is_the_row_told_next() {
    use crate::account::rows::store::{Family, Row};
    let world = world_with_written_computers_row();
    let a = world.at("A");
    let before = a.copies.row();
    assert_eq!(a.copies.told_row().unwrap().row.revision, before.revision);
    let edited = ComputersRow::sign_with_voters(&world.account.address(), before.revision + 1,
        &before.copy_keepers, &before.may_answer, &before.voters, &world.account).unwrap();
    Store::new(&*a.raw).put(Family::Computers, &Row {
        id: super::Subject::Account(world.account.address()).row_id(), account: OWNER.into(), expires_at: 0,
        value: edited.clone(),
    }).unwrap();
    assert_eq!(a.copies.told_row().unwrap().row, edited, "the tell carries the row the store holds, not the cached revision");
}
