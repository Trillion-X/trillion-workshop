// src/storage/record_store_resources/books/tests.rs
//
// Purpose: Tests of the volume chooser in books.rs: the head store, the live level it reads, the operations that are
// volume, the split of a full store, and that no count cap refuses a create. Every store is synthetic (a temporary
// folder), so no account's data is touched. A store's flag is its live level, so each test sets it with a synthetic row:
// a row whose only levels are reached by any store (every store flagged), the shipped row (none flagged), or a row a
// prefilled store is past.

use super::*;
use serde_json::json;

const ACCOUNT: &str = "account-under-test";
const RESOURCE: &str = "notes";

/// The default row's levels under another limit: its shares stand, and its `full` headroom keeps the default's
/// proportion (256 MiB of 10 GB), as a row a computer gives for a small store would.
fn row(limit_bytes: u64) -> SizeRow {
    let default = &settings::shipped().unwrap().store_size.default;
    let mut row = default.clone();
    row.limit_bytes = limit_bytes;
    for level in &mut row.levels {
        if let Some(headroom) = level.headroom_bytes.as_mut() {
            *headroom = ((*headroom as u128 * limit_bytes as u128) / default.limit_bytes as u128) as u64;
        }
    }
    row
}

/// A row that every store has reached: its only level, refuse-growth, is reached by any store at all.
fn every_store_reached() -> SizeRow {
    SizeRow::parse(&json!({"limit_bytes": 1, "levels": [{"id": "refuse-growth", "at_share": 1.0, "refuses": ["growth"]}]})).unwrap()
}

/// A row that every store has reached as full: refuse-growth and full are both reached by any store at all.
fn every_store_full() -> SizeRow {
    SizeRow::parse(&json!({"limit_bytes": 1, "levels": [
        {"id": "refuse-growth", "at_share": 1.0, "refuses": ["growth"]},
        {"id": "full", "at_share": 1.0, "refuses": ["growth"], "waits_for_recovery": true}
    ]})).unwrap()
}

fn create(id: &str, bytes: usize) -> Mutation {
    Mutation { id: id.into(), expected_version: 0, request_key: format!("create-{id}"), deleted: false, value: json!({"kind": "note", "text": "x".repeat(bytes)}) }
}

/// The span directory as the accounts layer keeps it: one row in the primary store, published compare-and-set on the
/// version it was read at. A synthetic stand-in for the caller's implementation.
struct PrimaryRow;

const DIRECTORY_ROW: &str = "book-directory";

impl SpanDirectory for PrimaryRow {
    fn read(&self, primary: &RecordStore<Supply<Handle>>, account: &str) -> Result<Directory, Error> {
        Ok(match primary.get(account, RESOURCE, DIRECTORY_ROW)?.record {
            Some(record) => serde_json::from_value(record.value).unwrap(),
            None => Directory::new(),
        })
    }

    fn publish(&self, primary: &mut RecordStore<Supply<Handle>>, account: &str, directory: &Directory) -> Result<(), Error> {
        let version = primary.get(account, RESOURCE, DIRECTORY_ROW)?.record.map_or(0, |record| record.version);
        primary.mutate(account, RESOURCE, Mutation {
            id: DIRECTORY_ROW.into(),
            expected_version: version,
            request_key: format!("book-directory-{}", directory.generation()),
            deleted: false,
            value: serde_json::to_value(directory).unwrap(),
        })?;
        Ok(())
    }
}

fn volume() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let primary = dir.path().canonicalize().unwrap().join("own.sqlite");
    (dir, primary)
}

/// Lane (b) of the storage audit: a store prefilled past 85% of its row's limit sends the next growth write to a new
/// store (old trillion own-record-volume.json); a row with a larger limit, and no code change, keeps the same prefilled
/// store as the head.
#[test]
fn a_prefilled_store_past_85_percent_sends_the_next_write_to_a_new_store_and_a_row_moves_the_limit() {
    let (_dir, primary) = volume();
    let small = Books::new(&primary, WorkMeter::new(), Some(row(4 * 1024 * 1024)));
    // Prefill the primary store until it crosses 85% of 4 MiB.
    let mut prefilled = 0;
    loop {
        let (order, _) = small.write(ACCOUNT, RESOURCE, create(&format!("prefill-{prefilled}"), 32 * 1024)).unwrap();
        prefilled += 1;
        if order != 0 || small.open_book(0).unwrap().level().unwrap().reached("refuse-growth") {
            assert_eq!(order, 0, "every prefill lands in the primary until it crosses the level");
            break;
        }
    }
    let primary_store = small.open_book(0).unwrap();
    let level = primary_store.level().unwrap();
    assert!(level.refuses_growth() && level.bytes * 100 >= level.limit_bytes() * 85, "{} of {}", level.bytes, level.limit_bytes());
    let (order, _) = small.write(ACCOUNT, RESOURCE, create("next", 32 * 1024)).unwrap();
    assert_eq!(order, 1, "the next write lands in a new store");
    assert!(book_path(&primary, 1).unwrap().ends_with("own.overflow-1.sqlite") && book_path(&primary, 1).unwrap().exists());
    assert_eq!(small.held().unwrap(), vec![0, 1]);
    // A record lives in one store: it is found there and changed there, whatever store is the head.
    let (found, record) = small.find(ACCOUNT, RESOURCE, "prefill-0").unwrap().unwrap();
    assert_eq!(found, 0);
    let update = Mutation { id: "prefill-0".into(), expected_version: record.version, request_key: "update-prefill-0".into(), deleted: false, value: json!({"kind": "note", "text": "short"}) };
    assert_eq!(small.write(ACCOUNT, RESOURCE, update).unwrap().0, 0, "an update goes to the store that holds the record");
    assert_eq!(small.find(ACCOUNT, RESOURCE, "next").unwrap().unwrap().0, 1);

    // The same prefilled files under a row of 100 MiB: no code change, the primary is far below 85%, so it is the first
    // book in order that has not reached the level and takes creates again; no third store is made.
    let large = Books::new(&primary, WorkMeter::new(), Some(row(100 * 1024 * 1024)));
    assert!(!large.open_book(0).unwrap().level().unwrap().refuses_growth());
    assert_eq!(large.write(ACCOUNT, RESOURCE, create("after-row-change", 1024)).unwrap().0, 0);
    assert_eq!(large.held().unwrap(), vec![0, 1]);
    crate::quiet_eprintln!("books: {prefilled} prefills of 32 KiB crossed 85% of 4 MiB; the next write made store 1");
}

/// Port of old trillion test/own-record-chooser.test.mjs: a store past the growth level is passed over for a create,
/// and the next store is made and registered. Under the 4 MiB row the primary is prefilled past the level and the
/// store made after it is empty, so the create lands in it; under the 100 MiB row the primary takes creates again.
#[test]
fn the_store_past_the_growth_level_is_passed_over_and_the_next_create_lands_in_a_new_store() {
    let (_dir, primary) = volume();
    let small = Books::new(&primary, WorkMeter::new(), Some(row(4 * 1024 * 1024)));
    let mut prefilled = 0;
    while !small.open_book(0).unwrap().level().unwrap().reached("refuse-growth") {
        small.write(ACCOUNT, RESOURCE, create(&format!("prefill-{prefilled}"), 32 * 1024)).unwrap();
        prefilled += 1;
    }
    assert_eq!(small.head().unwrap(), Head { order: 1, create: true }, "the store past the level is passed over");
    assert_eq!(small.write(ACCOUNT, RESOURCE, create("next", 8)).unwrap().0, 1);
    assert_eq!(small.head().unwrap(), Head { order: 1, create: false }, "the store made takes the next create");
    assert!(small.is_volume_operation("inbound:take").unwrap());
    assert!(!small.is_volume_operation("settings:read").unwrap(), "one-per-account state stays in the primary store");
    let large = Books::new(&primary, WorkMeter::new(), Some(row(100 * 1024 * 1024)));
    assert_eq!(large.head().unwrap(), Head { order: 0, create: false }, "below the level the primary takes creates again");
}

/// Port of old trillion test/own-record-heads.test.mjs: volume operations are data (`volume_stores.operations`).
#[test]
fn volume_operations_are_data_and_only_inbound_take_is_volume() {
    let (_dir, primary) = volume();
    let books = Books::new(&primary, WorkMeter::new(), None);
    assert!(books.is_volume_operation("inbound:take").unwrap());
    for one in ["records:write", "settings:save", "claims:handOff", "tell:serviceNotice"] {
        assert!(!books.is_volume_operation(one).unwrap(), "{one}");
    }
}

/// Port of old trillion test/own-record-heads.test.mjs: an account with one store writes to the primary.
#[test]
fn an_account_with_one_store_writes_to_the_primary() {
    let (_dir, primary) = volume();
    let books = Books::new(&primary, WorkMeter::new(), None);
    assert_eq!(books.head().unwrap(), Head { order: 0, create: false });
}

/// Port of old trillion test/own-record-heads.test.mjs: a store at the growth level is skipped; with every store at it
/// the next one is named to be made; a store below the level takes creates again.
#[test]
fn a_store_at_the_growth_level_is_skipped_and_with_none_left_the_next_is_named_to_be_made() {
    let (_dir, primary) = volume();
    let flagged = Books::new(&primary, WorkMeter::new(), Some(every_store_reached()));
    assert_eq!(flagged.head().unwrap(), Head { order: 1, create: true }, "at the level the next store is named to be made");
    flagged.open_book(1).unwrap();
    assert_eq!(flagged.head().unwrap(), Head { order: 2, create: true }, "every store at the level: the next one is named");
    assert!(flagged.open_book(2).unwrap().level().is_ok(), "the store made reads back");
    assert!(flagged.find(ACCOUNT, RESOURCE, "nothing-yet").unwrap().is_none());
    assert_eq!(flagged.held().unwrap(), vec![0, 1, 2]);
    let below = Books::new(&primary, WorkMeter::new(), None);
    assert_eq!(below.head().unwrap(), Head { order: 0, create: false }, "a store below the level takes creates again");
}

/// Port of old trillion test/own-record-heads.test.mjs: a second ask for the next store names the same one, and a head
/// ask makes no store.
#[test]
fn a_second_ask_names_the_same_next_store_and_a_head_ask_makes_none() {
    let (_dir, primary) = volume();
    let flagged = Books::new(&primary, WorkMeter::new(), Some(every_store_reached()));
    assert_eq!(flagged.head().unwrap(), Head { order: 1, create: true });
    assert_eq!(flagged.head().unwrap(), Head { order: 1, create: true }, "a second ask names the same store");
    assert!(!book_path(&primary, 1).unwrap().exists(), "a head ask makes no store");
    assert_eq!(flagged.held().unwrap(), vec![0]);
}

/// Past the first store, with a row every store has reached, every create lands in a new store and none is refused.
/// Past the 64 stores of the old cap as well: 66 creates land in orders 1 to 66.
#[test]
fn more_stores_than_the_old_cap_are_made_and_no_create_is_refused() {
    let (_dir, primary) = volume();
    let books = Books::new(&primary, WorkMeter::new(), Some(every_store_reached()));
    let made = 66;
    for at in 1..=made {
        assert_eq!(books.write(ACCOUNT, RESOURCE, create(&format!("r{at}"), 8)).unwrap().0, at);
    }
    assert_eq!(books.held().unwrap().len(), made + 1);
    assert!(book_path(&primary, made).unwrap().exists());
}

/// A full store splits at the median of its movable records: the span from there up moves to the next store, the
/// directory publishes generation 1, and the moved rows read from the new store while the rest stay in the primary.
#[test]
fn a_full_store_splits_its_span_at_the_median_and_the_moved_rows_read_from_the_new_store() {
    let (_dir, primary) = volume();
    let default = Books::new(&primary, WorkMeter::new(), None);
    for at in 0..10 {
        default.write(ACCOUNT, RESOURCE, create(&format!("row-{at}"), 8)).unwrap();
    }
    let full = Books::new(&primary, WorkMeter::new(), Some(every_store_full()));
    let split = full
        .split_full(ACCOUNT, RESOURCE, 0, |id| id.starts_with("row-"), &PrimaryRow)
        .unwrap()
        .expect("the full store splits");
    assert_eq!(split, Split { at: "row-5".into(), to_store: 1, generation: 1 });
    let directory = PrimaryRow.read(&full.open_book(0).unwrap(), ACCOUNT).unwrap();
    assert_eq!(directory.generation(), 1, "the directory publishes the next generation");
    assert_eq!((directory.owner("row-2"), directory.owner("row-7")), (0, 1));
    assert!(full.open_book(1).unwrap().get(ACCOUNT, RESOURCE, "row-7").unwrap().record.is_some(), "the directory and the new store agree: the moved row reads from the new store");
    assert!(full.open_book(0).unwrap().get(ACCOUNT, RESOURCE, "row-7").unwrap().record.is_none(), "and is gone from the primary");
    assert!(full.open_book(0).unwrap().get(ACCOUNT, RESOURCE, "row-2").unwrap().record.is_some(), "rows below the boundary stay");
    assert_eq!(full.held().unwrap(), vec![0, 1]);
}

/// A store that has not reached its full level is not split.
#[test]
fn a_store_below_the_full_level_is_not_split() {
    let (_dir, primary) = volume();
    let default = Books::new(&primary, WorkMeter::new(), None);
    default.write(ACCOUNT, RESOURCE, create("row-0", 8)).unwrap();
    assert_eq!(default.split_full(ACCOUNT, RESOURCE, 0, |id| id.starts_with("row-"), &PrimaryRow).unwrap(), None);
    assert_eq!(default.held().unwrap(), vec![0]);
}

/// Containment check for the 2026-11-12 outbox report: a store past the growth level still takes an ordinary write (an
/// update, as a pending projection is) and reads back the latest value. The level refuses growth operations, not the
/// ordinary write or its read, so a store past the level alone does not lose or alternate a value.
#[test]
fn a_store_past_the_growth_level_still_takes_an_ordinary_write_and_reads_back_the_latest() {
    let (_dir, primary) = volume();
    let books = Books::new(&primary, WorkMeter::new(), Some(every_store_reached()));
    let mut store = books.open_book(0).unwrap();
    assert!(store.level().unwrap().refuses_growth(), "the store is past the growth level");
    store.mutate(ACCOUNT, RESOURCE, create("pending-1", 8)).unwrap();
    let first = store.get(ACCOUNT, RESOURCE, "pending-1").unwrap().record.unwrap();
    store
        .mutate(ACCOUNT, RESOURCE, Mutation { id: "pending-1".into(), expected_version: first.version, request_key: "update-pending-1".into(), deleted: false, value: json!({"kind": "note", "text": "second"}) })
        .unwrap();
    let latest = store.get(ACCOUNT, RESOURCE, "pending-1").unwrap().record.unwrap();
    assert_eq!(latest.value["text"], "second", "the ordinary write lands and the read returns it");
    assert_eq!(latest.version, first.version + 1);
}

/// Step 1 of the write routing: a record resolves to the store its directory span names, and a commit that finds the
/// generation moved (a split published between the resolve and the write) resolves once more, on the new owner.
#[test]
fn a_record_resolves_to_its_span_owner_and_a_moved_generation_resolves_once_more() {
    let (_dir, primary) = volume();
    let books = Books::new(&primary, WorkMeter::new(), None);
    books.open_book(1).unwrap();
    assert_eq!(books.resolve(ACCOUNT, "row-7", &PrimaryRow).unwrap(), Resolved { order: 0, generation: 0 }, "no split yet: the primary owns every id");
    let mut primary_store = books.open_book(0).unwrap();
    let split = Directory::new().split(0, "row-5", 1).unwrap();
    PrimaryRow.publish(&mut primary_store, ACCOUNT, &split).unwrap();
    drop(primary_store);
    assert_eq!(books.resolve(ACCOUNT, "row-7", &PrimaryRow).unwrap(), Resolved { order: 1, generation: 1 });
    assert_eq!(books.resolve(ACCOUNT, "row-2", &PrimaryRow).unwrap(), Resolved { order: 0, generation: 1 });

    // A commit that finds generation 1 moved to 2 answers Stale once; the second resolve runs on the new generation.
    let mut asked = Vec::new();
    let answer = books
        .route(ACCOUNT, "row-7", &PrimaryRow, |resolved| {
            asked.push(resolved.generation);
            if asked.len() == 1 {
                return Ok(Commit::Stale);
            }
            Ok(Commit::Done(resolved.order))
        })
        .unwrap();
    assert_eq!(answer, 1, "the retry lands on the owner the directory names now");
    assert_eq!(asked, vec![1, 1], "the first commit resolved at generation 1 and was refused as stale; the retry resolved again");

    // Two stale answers in a row are a conflict, never a third retry.
    let mut tries = 0;
    let refused = books.route(ACCOUNT, "row-7", &PrimaryRow, |_| {
        tries += 1;
        Ok(Commit::<usize>::Stale)
    });
    assert!(refused.is_err(), "a second stale answer is refused");
    assert_eq!(tries, 2, "exactly one retry, then refused");
}
