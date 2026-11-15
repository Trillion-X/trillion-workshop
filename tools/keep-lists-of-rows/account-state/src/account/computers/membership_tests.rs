//! Adding a computer to a running account and removing one, at four computers in one process with a link that calls the
//! other computer's `Copies::answer` directly (as `copies_tests.rs` does; the forwarder is left out):
//! - a computer D added to a running A/B/C account starts with nothing, catches up (records past one page, sealed held
//!   values, the account's rows and the root sealed to its own key), reads the same, and neither claims the writer role nor votes
//!   for a takeover before it is caught up;
//! - a change of the voters while a term is held never lets two computers hold the writer role, and is not made while the
//!   old voters cannot take it;
//! - removing C, a computer that held the root: the account gets a new root that C never receives, every secret is
//!   sealed again under it, A and B read everything old and new, C's old root opens nothing written after, and C's
//!   votes, pages and rows pulls are refused.

use super::{
    classify_booted,
    copies::{Copies, CopiesConfig, Link},
    edit,
    keep_public_key,
    messages::{Answer, Message},
    settings,
    rows_copy::{self, CopiedRows},
    AccountKey, Change, ComputersRow, Refused, Subject,
};
use crate::{
    account::rows::store::{Family, Row, Store},
    secrets::{self, secrets_key::{self, ComputerKey}, SecretsKey, Secrets},
    records::Mutation,
    storage::record_store::settings::Limits,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

/// The vault's file in a state folder (src/storage/record_store_resources.json).
const VAULT_FILE: &str = "held-values.sqlite";
const OWNER: &str = "0cc0000000000000000000000000000000000000000000000000000000000003";
const ACCOUNT: &str = "person";
const RESOURCE: &str = "own-records";
const NAMES: [&str; 5] = ["A", "B", "C", "D", "E"];

#[derive(Default)]
struct Net {
    computers: Mutex<HashMap<String, Arc<Copies>>>,
    down: Mutex<HashSet<String>>,
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
        Some(computer.answer(&self.me, message.clone()))
    }
}

struct Computer {
    id: String,
    key: Arc<ComputerKey>,
    copies: Arc<Copies>,
    view: Arc<CopiedRows>,
    state: PathBuf,
}

impl Computer {
    fn store(&self) -> Store<'_> {
        Store::new(&*self.view)
    }

    /// The writer's write, acknowledged; answers its stamp.
    fn write(&self, id: &str, value: Value) -> i64 {
        self.try_write(id, value).expect("the writer's write is acknowledged")
    }

    fn try_write(&self, id: &str, value: Value) -> Result<i64, super::copies::WriteRefused> {
        let mutation = Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false, value };
        self.copies.write(|store| store.mutate_local_with_check(OWNER, RESOURCE, mutation, || Ok(()))).map(|change| change.sequence)
    }

    fn record(&self, id: &str) -> Option<Value> {
        self.copies.read(RESOURCE, id).unwrap().record.map(|record| record.value)
    }

    fn vault_file(&self) -> PathBuf {
        self.state.join(VAULT_FILE)
    }

    /// Seal `value` under `name` in this computer's vault, opened with the keyring this computer holds (at the writer only).
    fn hold(&self, name: &str, value: &str) {
        let keyring = self.copies.keyring().expect("this computer holds the root");
        let vault = Secrets::open_with_keyring(secrets::open_store(&self.vault_file()).unwrap(), OWNER, &keyring, naming()).unwrap();
        vault.put(name, Zeroizing::new(value.to_owned())).unwrap();
    }

    /// The value held under `name` in a copy of this computer's vault file (a read never writes the copy the computer
    /// follows), opened with the keyring this computer holds.
    fn held(&self, name: &str) -> Option<String> {
        let keyring = self.copies.keyring()?;
        let copy = tempfile::tempdir().unwrap();
        let file = copy.path().canonicalize().unwrap().join(VAULT_FILE);
        std::fs::copy(self.vault_file(), &file).unwrap();
        let vault = Secrets::open_with_keyring(secrets::open_store(&file).unwrap(), OWNER, &keyring, naming()).unwrap();
        vault.plain(name).ok().map(|value| value.as_str().to_owned())
    }

    fn identity(&self) -> Option<String> {
        self.copies.keyring().map(|keyring| secrets_key::key_identity(keyring.current()).unwrap())
    }
}

fn naming() -> secrets::VaultIdentity {
    secrets::VaultIdentity::new(crate::account_files::identity::word().unwrap()).unwrap()
}

struct World {
    net: Arc<Net>,
    computers: Mutex<BTreeMap<&'static str, Arc<Computer>>>,
    ids: Vec<String>,
    keys: Vec<Arc<ComputerKey>>,
    account: AccountKey,
    clock: Arc<AtomicI64>,
    heard_clock: Arc<dyn crate::storage::time_source::Clock>,
    _heard: std::sync::MutexGuard<'static, ()>,
    root: SecretsKey,
    base: PathBuf,
    _dir: tempfile::TempDir,
}

/// Computers A, B, C hold the account, all answer and vote; A holds the root. D's and E's keys are made; they do not run.
fn world() -> World {
    world_of(3)
}

/// The first `count` computers (A first) hold the account, all answer and vote; A holds the root.
fn world_of(count: usize) -> World {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let account = AccountKey::generate().unwrap();
    let keys: Vec<Arc<ComputerKey>> = (0..5).map(|at| Arc::new(ComputerKey::from_bytes(vec![70 + at as u8; 32]).unwrap())).collect();
    let ids: Vec<String> = keys.iter().map(|key| super::ComputerSigner::of(key).unwrap().computer_id()).collect();
    let heard_clock = crate::storage::time_source::fixed(1_000_000);
    let heard_names: Vec<&str> = ids.iter().map(String::as_str).collect();
    let heard = crate::account::computers::copy_rule::hear_for_test(&*heard_clock, &heard_names);
    let world = World {
        net: Arc::new(Net::default()),
        computers: Mutex::new(BTreeMap::new()),
        ids,
        keys,
        account,
        clock: Arc::new(AtomicI64::new(1_000_000)),
        heard_clock,
        _heard: heard,
        root: secrets_key::generate().unwrap(),
        base,
        _dir: dir,
    };
    let first = &world.ids[..count];
    let row = ComputersRow::sign_with_voters(&world.account.address(), 1, first, first, first, &world.account).unwrap();
    for at in 0..count {
        world.start(at, &row, false);
    }
    world
}

impl World {
    /// Start computer `at` (0 is A) with `row` and an empty folder of its own; `joining`: it was added to a running account.
    fn start(&self, at: usize, row: &ComputersRow, joining: bool) -> Arc<Computer> {
        let name = NAMES[at];
        let folder = self.base.join(name.to_lowercase());
        std::fs::create_dir_all(&folder).unwrap();
        let raw = crate::account::rows::open(&folder).unwrap();
        {
            // The account's folder at a computer: its public key row and its computers row.
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
            CopiesConfig { user: "person".into(), stores: None,
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
        .with_vault(folder.join(VAULT_FILE))
        .with_account_key(self.account.public_hex());
        let copies = if joining { copies.joining() } else { copies };
        let held = (at == 0).then(|| {
            secrets_key::write_sealed(&folder, &self.root, &self.keys[0]).unwrap();
            secrets_key::open_sealed_with(&folder, &self.keys[0]).unwrap()
        });
        let copies = Arc::new(copies.with_secrets_key(self.keys[at].clone(), folder.clone(), held));
        // Every write of this computer's vault file goes through its copies (`copies::vault_gate`).
        super::copies::register_vault(&copies);
        view.attach(&copies);
        self.net.computers.lock().unwrap().insert(self.ids[at].clone(), copies.clone());
        let computer = Arc::new(Computer { id: self.ids[at].clone(), key: self.keys[at].clone(), copies, view, state: folder });
        self.computers.lock().unwrap().insert(name, computer.clone());
        computer
    }

    fn at(&self, name: &str) -> Arc<Computer> {
        self.computers.lock().unwrap()[name].clone()
    }

    fn running(&self) -> Vec<&'static str> {
        self.computers.lock().unwrap().keys().copied().collect()
    }

    /// One timer step at every running computer that is not down, after the clock moved one renewal on. Answers which
    /// computers hold the writer role after it; never two (checked here at every step).
    fn step(&self) -> Vec<&'static str> {
        self.clock.fetch_add(settings().renew_every_ms, Ordering::AcqRel);
        for name in self.running() {
            if !self.net.down.lock().unwrap().contains(&self.at(name).id) {
                self.at(name).copies.tick();
            }
        }
        let writers = self.writers();
        assert!(writers.len() <= 1, "two computers hold the writer role at once: {writers:?}");
        writers
    }

    fn run(&self, steps: usize) {
        for _ in 0..steps {
            self.step();
        }
    }

    fn writers(&self) -> Vec<&'static str> {
        self.running().into_iter().filter(|name| self.at(name).copies.holding().is_some()).collect()
    }

    fn term_runs_out(&self) -> usize {
        ((settings().term_ms + 2 * settings().clock_margin_ms) / settings().renew_every_ms) as usize + 4
    }

    fn set_down(&self, name: &str, down: bool) {
        let id = self.ids[NAMES.iter().position(|known| *known == name).unwrap()].clone();
        let mut set = self.net.down.lock().unwrap();
        if down {
            set.insert(id);
        } else {
            set.remove(&id);
        }
    }

    /// The computers named, by id, in the order given.
    fn ids_of(&self, names: &[&str]) -> Vec<String> {
        names.iter().map(|name| self.ids[NAMES.iter().position(|known| known == name).unwrap()].clone()).collect()
    }

    /// The owner's row edit at `computer` (the door's `sign-in:set-places`: signed by the account's key, compare-and-set
    /// on the revision): `copy_keepers`, `may_answer` and `voters` by name.
    fn edit(&self, computer: &str, expected: u64, copy_keepers: &[&str], may_answer: &[&str], voters: &[&str]) -> Result<ComputersRow, Refused> {
        let change = Change {
            pursuit: None,
            expected_revision: expected,
            copy_keepers: self.ids_of(copy_keepers),
            may_answer: self.ids_of(may_answer),
            voters: self.ids_of(voters),
        };
        edit(&self.at(computer).store(), ACCOUNT, &Subject::Account(self.account.address()), &change, &self.account, &serde_json::Value::Null).map(|row| row.value)
    }

    fn start_with_a(&self) {
        self.at("A").copies.tick();
        assert_eq!(self.writers(), vec!["A"]);
        self.run(2);
    }
}

fn takeover_vote(world: &World) -> Message {
    let id = format!("{}{}", settings().writer_row_prefix, Subject::Account(world.account.address()).row_id());
    let ask = super::writer_row::Ask { id, prior: 1, term: 99, expires_at_ms: world.clock.load(Ordering::Acquire) + settings().term_ms };
    Message::Vote { ask, stamps: Vec::new() }
}

#[test]
fn a_computer_added_to_a_running_account_catches_up_from_nothing_before_it_claims_or_votes() {
    let world = world();
    world.start_with_a();
    let a = world.at("A");
    // More records than one page of the feed carries, a row of the account's and secrets.
    for at in 0..(settings().feed_page_items * 2 + 5) {
        a.write(&format!("r{at}"), json!({"kind": "note", "text": format!("record {at}")}));
    }
    a.store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "test-row", "one")).unwrap();
    a.hold("service-token", "secret one");
    world.run(2);
    assert_eq!(world.at("B").held("service-token").as_deref(), Some("secret one"));

    // A computer that is behind never becomes a voter: it would hold every write until it caught up.
    assert_eq!(world.edit("A", 1, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C", "D"]), Err(crate::cause!(Refused::Storage)),
        "D has caught up with nothing: it is not made a voter");
    // The owner adds D: it holds and answers, and does not vote yet.
    let row = world.edit("A", 1, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C"]).expect("the change is made");
    assert_eq!(row.revision, 2);
    for name in ["A", "B", "C"] {
        assert_eq!(world.at(name).copies.row(), row, "{name} took the new row while it runs");
    }
    assert_eq!(world.writers(), vec!["A"], "A keeps the writer role through the change");

    // D starts with the account's row and nothing else.
    let d = world.start(3, &row, true);
    assert!(!d.copies.joined() && d.record("r0").is_none());
    assert!(matches!(d.copies.answer(&world.at("B").id, takeover_vote(&world)), Answer::Vote { vote, .. } if !vote.accepted),
        "D gives no takeover its vote before it is caught up");
    let mut steps = 0;
    while !d.copies.joined() {
        assert!(steps < 20, "D catches up");
        assert_eq!(world.step(), vec!["A"], "D never takes the writer role while it catches up");
        steps += 1;
    }
    world.run(1);
    // A write made while D only holds counts without it (three voters, A and one other hold it).
    a.write("while-holding", json!({"kind": "note", "text": "D follows, does not vote"}));
    world.run(1);
    assert!(a.copies.caught_up(&d.id), "D reported holding everything A holds");
    // Caught up, D becomes the fourth voter: one voter more, one step.
    let row = world.edit("A", 2, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C", "D"]).expect("D votes once caught up");
    assert_eq!(row.revision, 3);
    world.run(1);
    assert_eq!(d.copies.row(), row);

    // D reads the same records, secrets, account rows and root.
    for at in 0..(settings().feed_page_items * 2 + 5) {
        let id = format!("r{at}");
        assert_eq!(d.record(&id), a.record(&id), "{id} is the same at D");
    }
    assert_eq!(d.copies.stamp(RESOURCE), a.copies.stamp(RESOURCE));
    assert!(d.copies.holds_secrets_key(), "D may answer: it got the root, sealed to its own key");
    let sealed = std::fs::read(secrets_key::sealed_file(&d.state).unwrap()).unwrap();
    assert_eq!(secrets_key::key_identity(&secrets_key::open(&sealed, &d.key).unwrap()).unwrap(), secrets_key::key_identity(&world.root).unwrap());
    assert_eq!(d.held("service-token").as_deref(), Some("secret one"), "D opens the secrets");
    assert!(rows_copy::holds_list_row(&**d.view.raw(), "test-row"), "D holds the account's row");

    // Four voters now: with A gone a takeover needs three of A, B, C and D, and D counts.
    world.set_down("A", true);
    world.set_down("B", true);
    for _ in 0..world.term_runs_out() {
        world.step();
    }
    assert!(world.writers().is_empty(), "C and D alone are two of four: nobody takes the writer role");
    world.set_down("B", false);
    for _ in 0..world.term_runs_out() {
        world.step();
    }
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "B, C and D are three of four: one of them takes the writer role");
    assert_ne!(writers[0], "A");
}

#[test]
fn a_change_of_the_voters_while_a_term_is_held_never_lets_two_computers_hold_the_writer_role() {
    let world = world();
    world.start_with_a();
    world.at("A").write("before", json!({"kind": "note", "text": "before"}));
    world.run(1);

    // Two voters moved in one edit are refused outright.
    assert_eq!(world.edit("A", 1, &["A", "B", "C"], &["A", "B", "C"], &["A", "B"]).map(|_| ()), Ok(()), "one voter less is one step");
    assert_eq!(world.edit("A", 2, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "C", "D"]), Err(crate::cause!(Refused::Invalid)),
        "B out and C, D in is more than one step");

    // While the old voters cannot take it, a change is not made and every row stays as it was. A keeps the writer role
    // and keeps replying: a row nobody took is acted on nowhere, so the refused edit does not also pause the account.
    // (C is up: a new voter that does not answer whether it joined is behind, and the change would be refused before it
    // is proposed, `Copies::caught_up`.)
    world.set_down("B", true);
    let term = world.at("A").copies.holding().expect("A holds the writer role");
    assert!(world.edit("A", 2, &["A", "B", "C"], &["A", "B", "C"], &["A", "B", "C"]).is_err(), "only A holds it, of A and B");
    assert!(world.edit("A", 2, &["A", "B", "C"], &["A", "B", "C"], &["A", "B", "C"]).is_err(), "refused again, as plainly");
    assert_eq!(world.at("A").copies.holding(), Some(term), "A keeps its term after a refused row edit");
    assert!(world.at("A").copies.answers_now(), "A still answers the account");
    assert!(world.at("A").record("before").is_some(), "A still reads the account's records");
    for name in ["A", "B", "C"] {
        assert_eq!(world.at(name).copies.row().revision, 2, "{name} holds no row that was not made");
    }
    world.set_down("B", false);
    let mut seen: BTreeMap<u64, &'static str> = BTreeMap::new();
    let mut note = |world: &World| {
        for name in world.writers() {
            let term = world.at(name).copies.holding().unwrap();
            assert_eq!(*seen.entry(term).or_insert(name), name, "term {term} held by two computers");
        }
    };
    for _ in 0..world.term_runs_out() {
        world.step();
        note(&world);
    }
    let writer = world.writers();
    assert_eq!(writer.len(), 1, "after the term ran out a voter took the writer role again");

    // A change proposed but not made (the other voter is down) is held by C only as a proposal: C never acts on it,
    // and no later claimer catches it up.
    let other = if writer[0] == "A" { "B" } else { "A" };
    world.set_down(other, true);
    assert!(world.edit(writer[0], 2, &["A", "B", "C"], &["A", "B", "C"], &["A", "B", "C"]).is_err(), "one of two voters cannot make it");
    assert_eq!(world.at("C").copies.row().revision, 2, "C keeps the row it held");
    world.set_down(other, false);
    for _ in 0..world.term_runs_out() {
        world.step();
        note(&world);
    }
    let writer = world.writers();
    assert_eq!(writer.len(), 1);
    for name in ["A", "B", "C"] {
        assert_eq!(world.at(name).copies.row().revision, 2, "{name}: the change that was not made is nowhere");
    }

    // A voter is added while the writer holds its term, then the writer and the new voter go at once: the takeover asks
    // the new voters (three of A, B, C, D), and with D out of reach nobody takes it. D first holds without voting, and
    // becomes a voter only once it has caught up.
    let writer = writer[0];
    let row = world.at(writer).copies.row();
    let next = world.edit(writer, row.revision, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C"]).expect("one copy keeper more");
    for name in ["A", "B", "C"] {
        assert_eq!(world.at(name).copies.row(), next, "{name} holds the new row");
    }
    assert_eq!(world.edit(writer, next.revision, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C", "D"]), Err(crate::cause!(Refused::Storage)),
        "D is not running: it is not made a voter");
    let d = world.start(3, &next, true);
    let mut steps = 0;
    while !(d.copies.joined() && world.at(writer).copies.caught_up(&d.id)) {
        assert!(steps < 20, "D catches up");
        world.step();
        note(&world);
        steps += 1;
    }
    let next = world.edit(writer, next.revision, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C", "D"]).expect("D votes");
    world.set_down(writer, true);
    world.set_down("D", true);
    for _ in 0..world.term_runs_out() {
        world.step();
        note(&world);
    }
    assert!(world.writers().is_empty(), "two of the other voters alone are not three of four");
    assert_eq!(world.at("B").copies.row(), next);
    // D comes back; then a majority of the new voters takes the writer role.
    world.set_down("D", false);
    for _ in 0..(2 * world.term_runs_out()) {
        world.step();
        note(&world);
    }
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "{writers:?}");
    assert_ne!(writers[0], writer);
    assert!(world.at("D").copies.joined());
    // The old writer comes back: it holds an older term and follows; never two writers.
    world.set_down(writer, false);
    for _ in 0..4 {
        world.step();
        note(&world);
    }
    assert_eq!(world.writers(), writers);
    for name in ["A", "B", "C", "D"] {
        assert!(world.at(name).record("before").is_some(), "{name} holds the write made before the changes");
    }
}

#[test]
fn removing_a_computer_that_held_the_root_re_keys_the_account() {
    let world = world();
    world.start_with_a();
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    // Each computer reports the seal formats it opens, as the forwarder answers its report: a writer seals a new format only
    // once every peer reports it can open it (`sealed::choose_write_version`).
    let now = world.clock.load(Ordering::Acquire) as u64;
    let reported = |computer: &str| super::copy_rule::Reported { computer: computer.to_owned(), always_on: false, takes_new_accounts: false,
        has_room: true, last_seen: now, sealed_versions: Some(super::sealed::opened_versions()), unit: None };
    super::copy_rule::hear_reports(vec![reported(&b.id), reported(&c.id)], now);
    a.write("old-record", json!({"kind": "note", "text": "old"}));
    a.hold("old-value", "old secret");
    a.hold("old-two", "two");
    a.hold("old-three", "three");
    world.run(2);
    let first = secrets_key::key_identity(&world.root).unwrap();
    assert_eq!(c.identity().as_deref(), Some(first.as_str()), "C answers and holds the root");
    let c_root = c.copies.keyring().unwrap().current().duplicate();

    // The owner removes C: one voter less, and C no longer holds or answers.
    let row = world.edit("A", 1, &["A", "B"], &["A", "B"], &["A", "B"]).expect("the change is made");
    assert!(c.copies.removed(), "C learned it is removed");
    assert!(!c.copies.holds_secrets_key(), "C forgot the root");
    assert!(!secrets_key::sealed_file(&c.state).unwrap().exists(), "C dropped its sealed secrets key file");

    // A made a new root and keeps the old one only in the keyring, sealed under the new one.
    let second = a.identity().unwrap();
    assert_ne!(second, first, "the account has a new root");
    assert_eq!(a.copies.keyring().unwrap().identities().unwrap(), vec![second.clone(), first.clone()]);
    world.run(2);
    for name in ["old-value", "old-two", "old-three"] {
        assert!(secrets::opens_with(&secrets::open_store(&a.vault_file()).unwrap(), OWNER, a.copies.keyring().unwrap().current(), name),
            "{name} is sealed again under the new root");
    }
    assert_eq!(b.identity().as_deref(), Some(second.as_str()), "B got the new root");
    assert_eq!(b.copies.keyring().unwrap().identities().unwrap(), vec![second.clone(), first.clone()], "and the keyring");
    let sealed = std::fs::read(secrets_key::sealed_file(&b.state).unwrap()).unwrap();
    assert_eq!(secrets_key::key_identity(&secrets_key::open(&sealed, &b.key).unwrap()).unwrap(), second, "B's sealed secrets key file holds the new root");

    // The re-key is reported at the writer by names, never by value.
    let report = a.copies.last_rekey().expect("A reports the re-key it resealed");
    let mut reported = report.names.clone();
    reported.sort();
    assert_eq!(reported, ["old-three", "old-two", "old-value"], "every held value is named in the report");
    assert!(report.to_string().starts_with("computers-copies event=resealed-under-new-root"), "the report is the typed event line");
    assert!(!report.to_string().contains("old secret"), "the report names values, never their text");

    // Written after the removal.
    a.write("new-record", json!({"kind": "note", "text": "new"}));
    a.hold("new-value", "new secret");
    world.run(2);
    for computer in [&a, &b] {
        for (name, secret) in [("old-value", "old secret"), ("old-two", "two"), ("old-three", "three")] {
            assert_eq!(computer.held(name).as_deref(), Some(secret), "{name} survives the re-key");
        }
        assert_eq!(computer.held("new-value").as_deref(), Some("new secret"));
        assert!(computer.record("old-record").is_some() && computer.record("new-record").is_some());
    }

    // C: nothing written after reaches it, and its old root opens nothing written after.
    assert!(c.record("new-record").is_none(), "no record written after the removal reaches C");
    assert!(c.record("old-record").is_some(), "what C already held stays with it (out of reach to fix)");
    for vault in [a.vault_file(), b.vault_file()] {
        let copy = tempfile::tempdir().unwrap();
        let file = copy.path().canonicalize().unwrap().join(VAULT_FILE);
        std::fs::copy(vault, &file).unwrap();
        let store = secrets::open_store(&file).unwrap();
        assert!(!secrets::opens_with(&store, OWNER, &c_root, "new-value"), "C's old root does not open a value written after");
        assert!(!secrets::opens_with(&store, OWNER, &c_root, "old-value"), "nor the snapshot sealed again under the new root");
    }
    assert!(!secrets::opens_with(&secrets::open_store(&c.vault_file()).unwrap(), OWNER, &c_root, "new-value"));

    // C's messages are refused at A and B.
    for computer in [&a, &b] {
        for message in [
            takeover_vote(&world),
            Message::Push { term: 99, resource: RESOURCE.into(), after: 0, changes: Vec::new(), base: 0 },
            Message::SignInPull { after: 0, limit: 8, needs_secrets_key: true, root_identity: None },
            Message::Stamps,
        ] {
            assert!(matches!(computer.copies.answer(&c.id, message), Answer::Refused { code, .. } if code == "not_a_computer_of_this_account"));
        }
    }
    // An old row C sends changes nothing.
    let old = ComputersRow::sign_with_voters(&world.account.address(), 1, &world.ids_of(&["A", "B", "C"]), &world.ids_of(&["A", "B", "C"]),
        &world.ids_of(&["A", "B", "C"]), &world.account).unwrap();
    let told = super::KeptAccount { row: old, account_key: world.account.public_hex() };
    assert!(matches!(a.copies.answer(&c.id, Message::Row { told: Some(told), term: 99, made: true }), Answer::Row { told: Some(kept), .. } if kept.row == row));
    // The forwarder-side step: with A gone, B alone is the majority of A and B? No: two voters need both.
    world.set_down("A", true);
    world.run(world.term_runs_out());
    assert!(world.writers().is_empty() || world.writers() == vec!["A"], "B alone is one of two voters: no takeover");
}

#[test]
fn a_write_counts_only_once_a_majority_of_the_voters_hold_it() {
    let world = world_of(5);
    world.start_with_a();
    let a = world.at("A");
    // A and B alone are two of five: a write only B holds is not acknowledged, and is rolled back.
    for name in ["C", "D", "E"] {
        world.set_down(name, true);
    }
    assert_eq!(a.try_write("lonely", json!({"kind": "note", "text": "two of five"})), Err(crate::cause!(super::copies::WriteRefused::NotAcknowledged)));
    assert!(a.record("lonely").is_none(), "nothing of it is visible at the writer");
    // With E back, A, B and E are three of five: acknowledged.
    for name in ["C", "D", "E"] {
        world.set_down(name, false);
    }
    for _ in 0..world.term_runs_out() {
        world.step();
    }
    let writer = world.at(world.writers()[0]);
    let writer_at = writer_name(&world, &writer);
    // Two computers other than the writer go (which computer took the writer role depends on the claim order): the writer and two
    // others are three of five.
    let others: Vec<&str> = ["A", "B", "C", "D", "E"].into_iter().filter(|name| *name != writer_at).collect();
    let (gone, kept_by) = (&others[..2], &others[2..]);
    for name in gone {
        world.set_down(name, true);
    }
    writer.write("kept", json!({"kind": "note", "text": "three of five"}));
    // The writer and every computer but the two that went and one copy keeper go: any majority that takes over (three of five)
    // holds a voter that holds the write, so the write survives the takeover.
    let keeper = kept_by.iter().copied().find(|name| world.at(name).record("kept").is_some()).unwrap();
    for name in kept_by.iter().copied().chain([writer_at]) {
        if name != keeper {
            world.set_down(name, true);
        }
    }
    for name in gone {
        world.set_down(name, false);
    }
    for _ in 0..(2 * world.term_runs_out()) {
        world.step();
    }
    let writers = world.writers();
    assert_eq!(writers.len(), 1, "{gone:?} and {keeper} take the writer role: {writers:?}");
    assert!(world.at(writers[0]).record("kept").is_some(), "the new writer holds the acknowledged write");
}

fn writer_name(world: &World, computer: &Computer) -> &'static str {
    NAMES.into_iter().find(|name| world.computers.lock().unwrap().get(name).is_some_and(|held| held.id == computer.id)).unwrap()
}

#[test]
fn after_a_re_key_a_copy_only_computer_holds_values_sealed_under_the_new_root() {
    use super::sealed::{open_value, At, Part, SecretsKeys};
    let world = world();
    world.start_with_a();
    // D joins and only holds a copy.
    let row = world.edit("A", 1, &["A", "B", "C", "D"], &["A", "B", "C"], &["A", "B", "C"]).expect("D holds a copy");
    let d = world.start(3, &row, true);
    for _ in 0..10 {
        world.step();
    }
    assert!(d.copies.joined());
    let (a, b, c) = (world.at("A"), world.at("B"), world.at("C"));
    let before = a.write("before", json!({"kind": "note", "text": "before"}));
    world.run(2);
    let c_root = c.copies.keyring().unwrap().current().duplicate();

    // C is removed: the account is re-keyed.
    world.edit("A", 2, &["A", "B", "D"], &["A", "B"], &["A", "B"]).expect("C removed");
    let keyring = a.copies.keyring().unwrap();
    let after = a.write("after", json!({"kind": "note", "text": "after"}));
    world.run(3);
    let at = |id: &'static str, from: i64| At { owner: OWNER, resource: RESOURCE, id, version: 1, from, part: Part::Value };
    let held_after = d.record("after").expect("D holds the record written after");
    assert!(super::sealed::is_sealed(&held_after), "D holds it sealed");
    let new_only = SecretsKeys::of(keyring.current()).unwrap();
    assert_eq!(open_value(&new_only, &at("after", after), &held_after).unwrap(), json!({"kind": "note", "text": "after"}),
        "sealed under the new root");
    assert!(open_value(&SecretsKeys::of(&c_root).unwrap(), &at("after", after), &held_after).is_err(), "C's old root does not open it");
    let held_before = d.record("before").unwrap();
    assert!(open_value(&new_only, &at("before", before), &held_before).is_err(), "the value before was sealed under the old root");
    for computer in [&a, &b] {
        assert_eq!(computer.record("after"), Some(json!({"kind": "note", "text": "after"})));
        let roots = computer.copies.keyring().unwrap();
        assert_eq!(roots.identities().unwrap(), keyring.identities().unwrap(), "every computer that may answer holds every root");
    }

    // D is promoted: it gets the new root and the keyring, and opens what it held under either root.
    world.edit("A", 3, &["A", "B", "D"], &["A", "B", "D"], &["A", "B"]).expect("D answers");
    for _ in 0..4 {
        world.step();
    }
    assert!(d.copies.holds_secrets_key());
    assert_eq!(d.record("after"), Some(json!({"kind": "note", "text": "after"})));
    assert_eq!(d.record("before"), Some(json!({"kind": "note", "text": "before"})), "an older root of the keyring opens it");
}

#[test]
fn removing_a_computer_from_the_computers_list_fires_the_copy_rule_and_its_workflow_adds_another_that_votes_once_caught_up() {
    use super::copy_rule::{self, CopySettings, Here, ListRowWrite, Offered};
    let world = world();
    world.start_with_a();
    let a = world.at("A");
    a.write("before", json!({"kind": "note", "text": "before"}));
    // The account's copy rule, as list rows written at the writer (they travel with the copies): three keep a copy and
    // vote, two may answer; no computer here reports it is always on.
    let (_, rules) = copy_rule::for_tests();
    let least = CopySettings { least_copy_keepers: 3, least_voters: 3, least_may_answer: 2, least_always_on: 0 };
    assert_eq!(copy_rule::write_missing(&a.store(), ACCOUNT, &least, &rules).unwrap(), 2);
    copy_rule::set_offered(&a.store(), ACCOUNT, 0, vec![Offered { kind: None, computer: world.ids[4].clone(), has_room: true, always_on: false }]).unwrap();
    let caught_up = |computer: &str| a.copies.caught_up(computer);
    let here = || Here {
        account: ACCOUNT, key: &world.account, access: &Value::Null, computer: Some(&a.id), always_on: false, reports: &[],
        writer: a.copies.writer_row().map(|(writer, _, _)| writer), caught_up: &caught_up, now_ms: 1, clock: &*world.heard_clock,
    };
    assert_eq!(copy_rule::after_write(&a.store(), &here()).unwrap().short_by, Some(0), "A, B and C meet the rule");

    // D joins as a copy keeper that does not vote, and catches up.
    world.edit("A", 1, &["A", "B", "C", "D"], &["A", "B", "C", "D"], &["A", "B", "C"]).expect("D is added");
    let row = world.at("A").copies.row();
    let d = world.start(3, &row, true);
    for _ in 0..20 {
        if d.copies.joined() { break }
        world.step();
    }
    assert!(d.copies.joined(), "D caught up");

    // The owner removes C by its computers list row: four keepers to three is not below the rule (the door would let it),
    // but two voters are one short, so the rule fires and its workflow starts.
    let remove = ListRowWrite { computer: world.ids[2].clone(), keeps_copy: false, may_answer: false, votes: false, writer: false };
    let operation = remove.operation(Some(&row));
    assert!(!copy_rule::below_rule(&a.store(), ACCOUNT, 4, operation.keepers_after(Some(&row)).unwrap().len(), None).unwrap());
    super::apply(&a.store(), ACCOUNT, &operation, &world.account, &Value::Null, &*world.heard_clock).expect("C is removed");
    assert!(world.at("C").copies.removed());
    let outcome = copy_rule::after_write(&a.store(), &here()).unwrap();
    assert_eq!(outcome.short_by, Some(1), "{outcome:?}");
    assert_eq!(outcome.started.len(), 1, "{outcome:?}");
    let run = &outcome.runs[0];
    assert_eq!(run.added.as_deref(), Some(world.ids[4].as_str()), "the first offered computer with room is added: {run:?}");
    assert_eq!(run.blocked.as_ref().map(|why| why.as_str()), Some("waiting_for_caught_up"), "E has caught up with nothing: it does not vote yet");
    let row = a.copies.row();
    assert_eq!(row.copy_keepers, world.ids_of(&["A", "B", "D", "E"]).into_iter().collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>());
    assert!(!row.voters.contains(&world.ids[4]));

    // E starts with the row, catches up; the next sweep makes it a voter (one voter step) and the run finishes.
    let e = world.start(4, &row, true);
    for _ in 0..20 {
        if e.copies.joined() { break }
        world.step();
    }
    a.write("while-e-follows", json!({"kind": "note", "text": "E follows"}));
    world.run(2);
    assert!(a.copies.caught_up(&e.id), "E reported holding everything A holds");
    let swept = copy_rule::after_write(&a.store(), &here()).unwrap();
    let finished = swept.runs.iter().find(|run| run.state == "finished").expect("the run finished");
    assert_eq!(finished.status, json!("completed"), "{finished:?}");
    world.run(1);
    let row = a.copies.row();
    let mut voters = world.ids_of(&["A", "B", "E"]);
    voters.sort();
    assert_eq!(row.voters, voters, "E votes in C's place");
    assert_eq!(e.copies.row(), row, "E holds the new row");
    assert_eq!(copy_rule::after_write(&a.store(), &here()).unwrap().short_by, Some(0), "the account meets its rule again");
    assert_eq!(world.writers(), vec!["A"]);
}

/// docs/placement-decision/proofs.md: a computer that kept only a copy, as a voter, held the writer's rows mark and no
/// row of the account's (`take_mark`). Let answer, it pulls every row from the start, so a row made while it kept only a
/// copy is held there, with the computers that answered before down.
#[test]
fn a_copy_only_voter_let_answer_pulls_every_account_row_it_only_held_the_mark_of() {
    let world = world_of(2);
    world.start_with_a();
    let a = world.at("A");
    // C keeps a copy only, joins, then votes once caught up.
    let row = world.edit("A", 1, &["A", "B", "C"], &["A", "B"], &["A", "B"]).expect("C keeps a copy");
    let c = world.start(2, &row, true);
    for _ in 0..10 {
        world.step();
    }
    assert!(c.copies.joined());
    world.edit("A", 2, &["A", "B", "C"], &["A", "B"], &["A", "B", "C"]).expect("C votes once caught up");
    world.run(2);

    // A row made now reaches C as a mark only.
    a.store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "test-row", "one")).unwrap();
    a.write("note", json!({"kind": "note", "text": "kept"}));
    world.run(2);
    let raw_at_c = || rows_copy::holds_list_row(&**c.view.raw(), "test-row");
    assert!(!raw_at_c(), "a computer that keeps only a copy holds no row of the account's");

    // C is let answer: it gets the root and every row of the account's.
    world.edit("A", 3, &["A", "B", "C"], &["A", "B", "C"], &["A", "B", "C"]).expect("C answers");
    for _ in 0..6 {
        world.step();
    }
    assert!(c.copies.holds_secrets_key(), "C, let answer, got the root");
    assert!(raw_at_c(), "C pulled the row it only held the mark of");

    // A and B down: C alone holds the row in its own copy.
    world.set_down("A", true);
    world.set_down("B", true);
    assert!(raw_at_c(), "C holds the account's row in its own rows");
    assert_eq!(c.record("note"), Some(json!({"kind": "note", "text": "kept"})), "C reads the record from its own copy");
}
