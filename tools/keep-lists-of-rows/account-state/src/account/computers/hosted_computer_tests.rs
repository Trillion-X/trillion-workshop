//! A computer whose storage its host lends holds and answers for an account, by the same path as any other computer
//! (2026-11-04; the plan in docs/, steps 3 and 4).
//!
//! Design (docs/placement-decision/answer-decision.md candidate:1): a computer is anything that computes and runs
//! trillion-local, described only by what it reports; moving an account is one path: add another copy keeper, let it catch up from the
//! writer's change feed, move the writer row. A computer whose host gives each running object its own SQLite keeps each records store in
//! that object's SQLite, which it reaches only through one statement call (`storage::hosted_sql::HostSql`). Here that call is the
//! native stand-in (`storage::sqlite::hosted_stand_in`, with the host's refusals: no transaction statement, PRAGMA or
//! VACUUM), opened through `copies::HostedStores`, so the computer's copies run every step (pushes, pulls, votes, catching
//! up, the writer turn) on the hosted-SQL supply, and never open a SQLite file of their own.
//!
//! Each computer runs its own copies, stores and account rows (`move_tests.rs` `World`). Two cases:
//! - the planned move: the account lives on local computer A; hosted computer H reports itself, is named in the account's
//!   row, joins as `computer join` leaves a computer (no record, no root), catches up, votes; the writer row moves to H;
//!   H answers reads and writes from its own copy, and every read through the move is answered;
//! - the old writer killed mid-write: A writes, H and local computer C follow; A is killed inside a write (after its
//!   records were changed, before any copy acknowledged it); H takes the writer turn by the majority of voters, and
//!   every acknowledged write is on H's copy once (version 1), the one never acknowledged is not, and H writes on.

use super::{
    copies::{HostedStores, StoreOpener},
    move_tests::{World, ACCOUNT, NAMES, OWNER, RESOURCE},
    rows_copy, ComputerReport, ComputersRow,
};
use crate::{
    account::rows::store::Family,
    records::{Error, Mutation},
    secrets::secrets_key,
    storage::{
        hosted_sql::{Cell, HostSql},
        record_store::settings::{Budget, Limits},
        sqlite::hosted_stand_in::{self, StandIn},
        Intent, Result as StorageResult,
    },
};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

/// What the hosted computer reports about itself: its storage (10 GB, the most one hosted object's SQLite holds in the
/// cost model under simulation/cost-models), its reach, and that it is always on. Nothing else about it is known.
const REPORT: &[u8] = br#"{"storage":{"bytes":10000000000},"reach":"https://hosted-computer.example","cost_per_month_cents":500,
    "contained_tools":false,"always_on":true,"takes_new_accounts":false}"#;

/// The stand-in host, counting every statement call any of the hosted computer's handles made.
struct Counted {
    host: StandIn,
    calls: Arc<AtomicU64>,
}

impl HostSql for Counted {
    fn exec(&self, sql: &str, bind: &[Cell]) -> StorageResult<Vec<Vec<Cell>>> {
        assert!(!hosted_stand_in::refused(sql), "the computer sent a statement its host refuses: {sql}");
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.host.exec(sql, bind)
    }
    fn hold(&self, intent: Intent) -> StorageResult<()> { self.host.hold(intent) }
    fn release(&self) -> StorageResult<()> { self.host.release() }
    fn mark(&self) -> StorageResult<i64> { self.host.mark() }
    fn bytes(&self) -> StorageResult<u64> { self.host.bytes() }
    fn custody(&self) -> StorageResult<()> { self.host.custody() }
    fn overwrites_removed(&self) -> bool { self.host.overwrites_removed() }
}

/// A host's lent database reached over the network: each statement is one HTTP request to the host's statement call for
/// the store named `store` (`POST /exec?store=...`, body `{"sql", "bind"}`, answer `{"rows"}` or `{"refused"}`), in the
/// same cell encoding as the hosted build (src/storage/computer_build). The sandbox proof runs the host in a local
/// development server of the hosted object (one object, one SQLite, per store name) and trillion-local against it.
struct Remote {
    at: String,
    store: String,
    calls: Arc<AtomicU64>,
}

fn cell_json(cell: &Cell) -> serde_json::Value {
    match cell {
        Cell::Null => serde_json::Value::Null,
        Cell::Real(v) => json!({ "r": v }),
        Cell::Text(v) => json!({ "t": v }),
        Cell::Blob(v) => json!({ "b": v.iter().map(|b| format!("{b:02x}")).collect::<String>() }),
    }
}

fn json_cell(value: &serde_json::Value) -> Option<Cell> {
    if value.is_null() {
        return Some(Cell::Null);
    }
    let object = value.as_object()?;
    if let Some(v) = object.get("r") {
        return v.as_f64().map(Cell::Real);
    }
    if let Some(v) = object.get("t") {
        return v.as_str().map(|text| Cell::Text(text.to_owned()));
    }
    let hex = object.get("b")?.as_str()?;
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(hex.get(at..at + 2)?, 16).ok()).collect::<Option<Vec<u8>>>().map(Cell::Blob)
}

impl Remote {
    fn call(&self, body: &serde_json::Value) -> StorageResult<serde_json::Value> {
        use std::io::{Read as _, Write as _};
        let body = body.to_string();
        let path: String = self.store.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        let mut stream = std::net::TcpStream::connect(&self.at).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        write!(stream, "POST /exec?store={path} HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.at, body.len()).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        let text = String::from_utf8(answer).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?;
        let (head, rest) = text.split_once("\r\n\r\n").ok_or(crate::cause!(crate::storage::Error::Unavailable))?;
        let rest = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { unchunk(rest) } else { rest.to_owned() };
        serde_json::from_str(&rest).map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))
    }
}

/// The body of a chunked HTTP answer.
fn unchunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.trim(), 16) else { break };
        if size == 0 || after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        rest = after[size..].trim_start_matches("\r\n");
    }
    out
}

impl HostSql for Remote {
    fn exec(&self, sql: &str, bind: &[Cell]) -> StorageResult<Vec<Vec<Cell>>> {
        assert!(!hosted_stand_in::refused(sql), "the computer sent a statement its host refuses: {sql}");
        self.calls.fetch_add(1, Ordering::Relaxed);
        let answer = self.call(&json!({ "sql": sql, "bind": bind.iter().map(cell_json).collect::<Vec<_>>() }))?;
        if let Some(refused) = answer.get("refused").and_then(|code| code.as_str()) {
            return Err(match refused {
                "conflict" => crate::cause!(crate::storage::Error::Conflict),
                "too_big" => crate::cause!(crate::storage::Error::TooBig),
                "invalid" => crate::cause!(crate::storage::Error::Invalid),
                _ => crate::cause!(crate::storage::Error::Unavailable),
            });
        }
        answer["rows"].as_array().ok_or(crate::cause!(crate::storage::Error::Unavailable))?.iter()
            .map(|row| row.as_array().ok_or(crate::cause!(crate::storage::Error::Unavailable))?.iter().map(|cell| json_cell(cell).ok_or(crate::cause!(crate::storage::Error::Unavailable))).collect())
            .collect()
    }
    // Such a host runs each request to its object as one unit; a scope's rollback is the supply's own undo journal.
    fn hold(&self, _intent: Intent) -> StorageResult<()> { Ok(()) }
    fn release(&self) -> StorageResult<()> { Ok(()) }
    fn mark(&self) -> StorageResult<i64> { Ok(0) }
    fn bytes(&self) -> StorageResult<u64> {
        let answer = self.call(&json!({ "size": true }))?;
        answer["bytes"].as_f64().map(|bytes| bytes as u64).ok_or(crate::cause!(crate::storage::Error::Unavailable))
    }
    fn custody(&self) -> StorageResult<()> { Ok(()) }
    fn overwrites_removed(&self) -> bool { false }
}

/// The hosted computer whose host is reached at `at` (host:port), when the sandbox runs one.
fn remote_computer(at: String) -> (ComputerReport, Arc<dyn StoreOpener>, Arc<AtomicU64>) {
    let report = ComputerReport::parse(REPORT).expect("the hosted computer's report is a valid report");
    let Budget::Bytes(bytes) = report.storage else { panic!("a hosted computer reports a fixed storage") };
    let calls = Arc::new(AtomicU64::new(0));
    let counted = calls.clone();
    let opener = HostedStores::new(
        move |path: &Path| Ok(Remote { at: at.clone(), store: path.display().to_string(), calls: counted.clone() }),
        Limits::fixed(1 << 20, bytes),
    );
    (report, Arc::new(opener), calls)
}

/// The host the sandbox proof runs (`TRILLION_HOSTED_SQL_AT`, host:port).
fn sandbox_host() -> String {
    std::env::var("TRILLION_HOSTED_SQL_AT").expect("set TRILLION_HOSTED_SQL_AT to the host:port of the hosted objects' statement call")
}

/// The hosted computer's report, and the opener its adapter gives: each store path the copies name is a database the host
/// keeps under that name (here a stand-in file beside it, `.hosted`, never the SQLite file a disk computer would open).
fn hosted_computer() -> (ComputerReport, Arc<dyn StoreOpener>, Arc<AtomicU64>) {
    let report = ComputerReport::parse(REPORT).expect("the hosted computer's report is a valid report");
    let Budget::Bytes(bytes) = report.storage else { panic!("a hosted computer reports a fixed storage") };
    let calls = Arc::new(AtomicU64::new(0));
    let counted = calls.clone();
    let opener = HostedStores::new(
        move |path: &Path| {
            let host = hosted_stand_in::open(&path.with_extension("hosted")).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            Ok(Counted { host, calls: counted.clone() })
        },
        Limits::fixed(1 << 20, bytes),
    );
    (report, Arc::new(opener), calls)
}

fn note(id: &str, n: usize) -> Mutation {
    Mutation { id: id.to_owned(), expected_version: 0, request_key: format!("write-{id}"), deleted: false, value: json!({"kind": "note", "n": n}) }
}

/// The records store files at computer `name`: a hosted computer has no `records.sqlite` of its own.
fn disk_store_at(world: &World, name: &str) -> bool {
    world.folder(name).join("records.sqlite").exists()
}

#[test]
fn a_hosted_computer_answers_reads_and_writes_from_its_own_copy_after_the_writer_row_moves() {
    planned_move(hosted_computer());
}

/// The same move with the hosted computer's stores in the hosted objects' own SQLite, reached over the network (the
/// sandbox proof: `TRILLION_HOSTED_SQL_AT=127.0.0.1:8799 cargo test --lib hosted_computer_tests -- --ignored`).
#[test]
#[ignore = "needs the hosted objects' statement call running (TRILLION_HOSTED_SQL_AT)"]
fn sandbox_a_hosted_computer_answers_after_the_writer_row_moves() {
    planned_move(remote_computer(sandbox_host()));
}

fn planned_move((report, opener, calls): (ComputerReport, Arc<dyn StoreOpener>, Arc<AtomicU64>)) {
    let world = World::new();
    let secrets_key = secrets_key::generate().unwrap();
    assert_eq!((report.always_on, report.reach.as_str()), (Some(true), "https://hosted-computer.example"));

    // The account lives on local computer A alone, which writes 20 records.
    let first = ComputersRow::sign_with_voters(&world.account.address(), 1, &world.ids_of(&["A"]), &world.ids_of(&["A"]),
        &world.ids_of(&["A"]), &world.account).unwrap();
    let a = world.start(0, &first, false, Some(&secrets_key));
    a.copies.tick();
    assert!(a.copies.holding().is_some());
    for n in 0..20 {
        a.write(&format!("before-{n}"), "written at A before the move");
    }
    a.store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "door", "door")).unwrap();
    let key = "door";
    let record = "before-0";

    // 1. Add a copy keeper: the owner's row names the hosted computer (B) a copy keeper that may answer; it joins with nothing.
    let second = world.edit("A", 1, &["A", "B"], &["A", "B"], &["A"]).expect("the edit naming the hosted computer lands");
    let h = world.start_on(1, &second, true, None, Some(opener));
    assert!(!h.copies.answers_now(), "the hosted computer takes no calls before it caught up");
    world.until("h-catches-up", key, record, 60, || h.copies.joined() && h.copies.holds_secrets_key());
    for n in 0..20 {
        assert!(h.copies.read(RESOURCE, &format!("before-{n}")).unwrap().record.is_some(), "the hosted computer holds before-{n}");
    }
    assert_eq!(h.census(), a.census(), "the hosted computer holds the same account rows as A");

    // 2. It votes, then 3. the writer row moves: only the hosted computer may answer.
    let mut third = None;
    world.until("h-votes", key, record, 30, || {
        third = third.take().or_else(|| world.edit("A", 2, &["A", "B"], &["A", "B"], &["A", "B"]).ok());
        third.is_some()
    });
    world.until("h-reads-back", key, record, 30, || h.copies.answers_now());
    let mut fourth = None;
    world.until("writer-moves", key, record, 30, || {
        fourth = fourth.take().or_else(|| world.edit("A", 3, &["A", "B"], &["B"], &["A", "B"]).ok());
        fourth.is_some()
    });
    world.until("writer-moves", key, record, 60, || h.copies.holding().is_some());
    assert!(a.copies.holding().is_none() && !a.copies.answers_now(), "A gave the writer turn up");

    // The hosted computer writes 20 records and answers reads of every record from its own copy.
    for n in 0..20 {
        h.write(&format!("after-{n}"), "written at the hosted computer");
    }
    world.seconds("h-answers", key, "after-19", 10);
    assert_eq!(world.answered_by("h-answers"), vec!["B"; 10], "{:?}", world.failed_reads());
    let held = (0..20).flat_map(|n| [format!("before-{n}"), format!("after-{n}")])
        .filter(|id| h.copies.read(RESOURCE, id).unwrap().record.is_some_and(|record| record.version == 1))
        .count();
    assert_eq!(held, 40, "the hosted computer's copy holds all 40 records once");
    for n in 0..20 {
        assert!(a.copies.read(RESOURCE, &format!("after-{n}")).unwrap().record.is_some(), "A follows the hosted writer: after-{n}");
    }
    assert!(!disk_store_at(&world, "B") && disk_store_at(&world, "A"), "the hosted computer opened no SQLite file of its own");

    let reads = world.reads.lock().unwrap().len();
    assert_eq!(world.failed_reads(), Vec::new(), "every read is answered ({reads} reads)");
    eprintln!("hosted-computer move: {reads} reads, 0 failed; 40 of 40 records on the hosted copy; {} host statement calls",
        calls.load(Ordering::Relaxed));
}

#[test]
fn every_acknowledged_write_is_on_the_hosted_copy_once_after_the_old_writer_is_killed_mid_write() {
    killed_mid_write(hosted_computer());
}

/// The same failover with the hosted computer's stores in the hosted objects' own SQLite (the sandbox proof).
#[test]
#[ignore = "needs the hosted objects' statement call running (TRILLION_HOSTED_SQL_AT)"]
fn sandbox_every_acknowledged_write_is_on_the_hosted_copy_once_after_the_old_writer_is_killed() {
    killed_mid_write(remote_computer(sandbox_host()));
}

fn killed_mid_write((_, opener, calls): (ComputerReport, Arc<dyn StoreOpener>, Arc<AtomicU64>)) {
    let world = World::new();
    let root = secrets_key::generate().unwrap();
    // A and the hosted computer (B) may answer; C keeps a copy and votes. All three vote, so the two left are a majority.
    let all = world.ids_of(&NAMES);
    let row = ComputersRow::sign_with_voters(&world.account.address(), 1, &all, &world.ids_of(&["A", "B"]), &all, &world.account).unwrap();
    let a = world.start(0, &row, false, Some(&root));
    let h = world.start_on(1, &row, true, None, Some(opener));
    let c = world.start(2, &row, false, Some(&root));
    for _ in 0..90 {
        if a.copies.holding().is_some() && h.copies.joined() && h.copies.answers_now() && c.copies.joined() {
            break;
        }
        world.step();
    }
    assert!(a.copies.holding().is_some() && h.copies.answers_now(), "A writes, the hosted computer has caught up and answers");

    // A writes one record a second; at write 40 it is killed inside the write, after its records changed and before
    // any copy acknowledged it.
    let mut acknowledged = Vec::new();
    let mut lost = Vec::new();
    for n in 0..41 {
        world.step();
        let id = format!("w-{n}");
        let killed = n == 40;
        let written = a.copies.write(|store| {
            let written = write_record!(store, OWNER, RESOURCE, note(&id, n));
            if killed {
                world.net.down.lock().unwrap().insert(world.id("A"));
            }
            written
        });
        match written {
            Ok(_) => acknowledged.push(id),
            Err(_) => lost.push(id),
        }
    }
    assert_eq!((acknowledged.len(), lost.clone()), (40, vec!["w-40".to_owned()]), "40 writes acknowledged, the one killed mid-write not");

    // The hosted computer takes the writer turn by the voters' majority (itself and C).
    for _ in 0..90 {
        if h.copies.holding().is_some() {
            break;
        }
        world.step();
    }
    assert!(h.copies.holding().is_some(), "the hosted computer took the writer turn");
    let once = acknowledged.iter()
        .filter(|id| h.copies.read(RESOURCE, id).unwrap().record.is_some_and(|record| record.version == 1))
        .count();
    assert_eq!(once, 40, "every acknowledged write is on the hosted copy once");
    assert!(h.copies.read(RESOURCE, "w-40").unwrap().record.is_none(), "the write no copy acknowledged is not on it");

    // The hosted computer writes on from its own copy, and C follows it.
    for n in 41..61 {
        world.step();
        h.write(&format!("w-{n}"), "written at the hosted computer");
    }
    for _ in 0..10 {
        world.step();
    }
    let at_c = (41..61).filter(|n| c.copies.read(RESOURCE, &format!("w-{n}")).unwrap().record.is_some()).count();
    assert_eq!(at_c, 20, "C follows the hosted writer");
    assert!(!disk_store_at(&world, "B"));
    eprintln!("hosted-computer failover: {} acknowledged, {} lost mid-write (never acknowledged), {once} of {} on the hosted copy once; \
        20 of 20 later writes at the hosted computer reached C; {} host statement calls",
        acknowledged.len(), lost.len(), acknowledged.len(), calls.load(Ordering::Relaxed));
}

/// A computer whose storage its host lends settles plain records with a local computer exactly as two computers with files do
/// (`copies_tests.rs` `two_computers_that_may_answer_and_both_moved_settle...`): both may answer, each writes 20 records
/// into its own settle store, one settle brings both to one root, and a second settle is one request that moves nothing.
/// The hosted computer's settle store is the database its host lends, never a SQLite file of its own.
#[test]
fn a_hosted_computer_settles_its_records_with_a_local_computer_to_one_root() {
    use crate::storage::record_store::record_sync::{Actor, SettleStore};
    let (_, opener, calls) = hosted_computer();
    let world = World::new();
    let secrets_key = secrets_key::generate().unwrap();
    let first = ComputersRow::sign_with_voters(&world.account.address(), 1, &world.ids_of(&["A"]), &world.ids_of(&["A"]),
        &world.ids_of(&["A"]), &world.account).unwrap();
    let a = world.start(0, &first, false, Some(&secrets_key));
    a.copies.tick();
    a.write("before-0", "written at A before the hosted computer joins");
    a.store().insert(Family::Lists, &rows_copy::test_list_row(ACCOUNT, "door", "door")).unwrap();
    let key = "door";
    let second = world.edit("A", 1, &["A", "B"], &["A", "B"], &["A"]).expect("the edit naming the hosted computer lands");
    let h = world.start_on(1, &second, true, None, Some(opener));
    world.until("h-catches-up", key, "before-0", 60, || h.copies.joined() && h.copies.holds_secrets_key());

    let note = |text: &str| match json!({ "text": text }) { serde_json::Value::Object(map) => Some(map), _ => None };
    for (computer, prefix) in [(&a, "a"), (&h, "h")] {
        let mut store = computer.copies.settle_store(RESOURCE).unwrap();
        for n in 0..20 {
            store.write(&[(&format!("{prefix}-{n}"), "note", note(prefix))], Actor::by("person")).unwrap();
        }
    }
    let before = calls.load(Ordering::Relaxed);
    let settled = h.copies.settle(&a.id, RESOURCE).unwrap();
    assert!(settled.equal, "{settled:?}");
    let root = |computer: &super::move_tests::Computer| computer.copies.settle_store(RESOURCE).unwrap().checksum().unwrap().root;
    assert_eq!(root(&a), root(&h), "one root on both computers");
    assert_eq!(a.copies.settle_store(RESOURCE).unwrap().read("h-19").unwrap(), note("h"));
    assert_eq!(h.copies.settle_store(RESOURCE).unwrap().read("a-19").unwrap(), note("a"));
    let again = h.copies.settle(&a.id, RESOURCE).unwrap();
    assert!(again.equal && again.requests == 1 && again.sent == 0 && again.took == 0, "{again:?}");
    assert!(!disk_store_at(&world, "B") && disk_store_at(&world, "A"), "the hosted computer opened no SQLite file of its own");
    eprintln!("hosted-computer settle: took {}, sent {}, {} requests; again 1 request; {} host statement calls",
        settled.took, settled.sent, settled.requests, calls.load(Ordering::Relaxed) - before);
}
