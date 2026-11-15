//! Deleting an account (erase.rs), with synthetic accounts only: the ports of old trillion
//! test/account-deletion-failure-cause.test.mjs (a failure kept without identifiers), test/erasure-redrive.test.mjs (a
//! waiting deletion due now, and nothing else changed), test/account-delete-finishes-by-alarm.test.mjs (a deletion
//! larger than one call finished by later calls, and one already complete never run again) and
//! the old test that a kept deletion resumes where it stopped.

use super::*;
use crate::records::Mutation;
use crate::storage::{memory::Memory, record_store::{settings as store_settings, RealClock}};
use std::time::Duration;

const ACCOUNT: &str = "person";

/// A step that answers the pages it is given, in turn, and keeps the cursors it was asked at.
struct Scripted {
    pages: Vec<Result<Page, StepFailure>>,
    asked: Vec<String>,
}
impl Scripted {
    fn new(pages: Vec<Result<Page, StepFailure>>) -> Self {
        Scripted { pages, asked: Vec::new() }
    }
    fn done() -> Self {
        Scripted::new(vec![Ok(Page { erased: 0, next: None })])
    }
}
impl Step for Scripted {
    fn page(&mut self, cursor: &str) -> Result<Page, StepFailure> {
        self.asked.push(cursor.to_string());
        if self.pages.is_empty() { Ok(Page { erased: 0, next: None }) } else { self.pages.remove(0) }
    }
}

fn page(erased: u64, next: &str) -> Result<Page, StepFailure> {
    Ok(Page { erased, next: Some(next.into()) })
}

fn later() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

fn yes() -> bool {
    true
}

/// An empty store of the account's own rows, in memory.
fn rows_memory() -> Memory {
    Memory::open("sign_in").expect("the account rows schema opens")
}

/// Rows of the account in each family of its own rows, one of them expired, and another account's row.
fn account_rows(store: &Store<'_>) {
    for (family, id, expires_at) in [(Family::Lists, "l1", 0), (Family::Lists, "l2", 1), (Family::Computers, "c1", 0)] {
        store.put(family, &Row { id: id.into(), account: ACCOUNT.into(), expires_at, value: json!({"v": 1}) }).unwrap();
    }
    store.put(Family::Lists, &Row { id: "theirs".into(), account: "someone-else".into(), expires_at: 0, value: json!({"v": 1}) }).unwrap();
}

fn left(store: &Store<'_>, account: &str) -> usize {
    Family::ALL.iter().map(|family| store.ids_of(*family, account, 1000).unwrap().len()).sum()
}

#[test]
fn a_deletion_runs_every_step_in_order_from_its_kept_cursors_and_erases_the_account_rows_last() {
    let memory = rows_memory();
    let store = Store::new(&memory);
    account_rows(&store);
    let theirs = left(&store, "someone-else");
    begin(&store, ACCOUNT, 1).unwrap();
    assert!(deleting(&store, ACCOUNT).unwrap(), "a begun deletion is kept");
    let mut runs = Scripted::new(vec![page(2, "r1"), page(1, "r2"), Ok(Page { erased: 0, next: None })]);
    let mut files = Scripted::new(vec![page(3, "f1"), Ok(Page { erased: 1, next: None })]);
    let mut records = Scripted::done();
    let progress = {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step), (FILES, &mut files), (RECORDS, &mut records)] };
        advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap()
    };
    let Progress::Complete { erased_at } = progress else { panic!("complete: {progress:?}") };
    assert_eq!(runs.asked, ["", "r1", "r2"], "each page starts at the cursor the last one kept");
    assert_eq!(files.asked, ["", "f1"]);
    assert_eq!(left(&store, ACCOUNT), 1, "only the kept deletion row is left of the account's own rows, expired ones too");
    assert_eq!(left(&store, "someone-else"), theirs, "another account's rows are kept");
    let kept = kept(&store, ACCOUNT).unwrap().unwrap().value;
    assert_eq!((kept.erased_at, kept.erased[TOOL_RUNS], kept.erased[FILES]), (Some(erased_at), 3, 4));
    assert!(!deleting(&store, ACCOUNT).unwrap());
    // Complete is terminal: it is never begun or run again.
    assert_eq!(begin(&store, ACCOUNT, 2).unwrap_err(), crate::cause!(Refused::Complete));
    let mut steps = Steps { given: Vec::new() };
    assert_eq!(advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap(), Progress::Complete { erased_at });
}

#[test]
fn a_deletion_larger_than_one_call_goes_on_at_the_next_call_and_a_stop_resumes_where_it_was() {
    let memory = rows_memory();
    let store = Store::new(&memory);
    begin(&store, ACCOUNT, 1).unwrap();
    let many = settings().pages_per_call + 2;
    let mut runs = Scripted::new((0..many).map(|index| page(1, &format!("r{index}"))).collect());
    let first = {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step)] };
        advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap()
    };
    assert_eq!(first, Progress::Going { step: TOOL_RUNS.into() }, "one call takes at most its pages");
    assert_eq!(runs.asked.len(), settings().pages_per_call);
    // The process stopped here. Begun again, the kept deletion is answered, and it goes on at its kept cursor.
    assert_eq!(begin(&store, ACCOUNT, 5).unwrap().value.cursor, format!("r{}", settings().pages_per_call - 1));
    let mut again = Scripted::new(vec![Ok(Page { erased: 1, next: None })]);
    let mut files = Scripted::done();
    let mut records = Scripted::done();
    {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut again as &mut dyn Step), (FILES, &mut files), (RECORDS, &mut records)] };
        assert!(matches!(advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap(), Progress::Complete { .. }));
    }
    assert_eq!(again.asked, [format!("r{}", settings().pages_per_call - 1)]);
    // A call whose time is already over takes no page.
    let memory = rows_memory();
    let store = Store::new(&memory);
    begin(&store, ACCOUNT, 1).unwrap();
    let mut idle = Scripted::done();
    let mut steps = Steps { given: vec![(TOOL_RUNS, &mut idle as &mut dyn Step)] };
    assert_eq!(advance(&store, ACCOUNT, &mut steps, Instant::now(), &yes).unwrap(), Progress::Going { step: TOOL_RUNS.into() });
}

#[test]
fn a_failing_step_waits_its_pace_with_its_words_kept_without_identifiers_and_a_redrive_makes_it_due_now() {
    let memory = rows_memory();
    let store = Store::new(&memory);
    begin(&store, ACCOUNT, 1).unwrap();
    let words = "Resource 'files/a.txt' of person@example.test at https://example.test/x failed 3 times (1f3e9a0b77c1)";
    let original_cause = crate::cause!(account_erasure failing_test_step);
    let mut runs = Scripted::new(vec![Err(StepFailure { cause: original_cause.clone(), words: words.into(), transient: false })]);
    let failed = {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step)] };
        advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap()
    };
    let Progress::Failed { step, due_at } = failed else { panic!("failed: {failed:?}") };
    assert_eq!(step, TOOL_RUNS);
    let continuation = kept(&store, ACCOUNT).unwrap().unwrap().value.continuation;
    let retained_cause = continuation.last_failure.as_ref().unwrap().cause();
    assert_eq!(retained_cause, original_cause, "durable retry retains the producer's source identity");
    assert!(!retained_cause.id().contains("person@example.test"));
    assert!(!retained_cause.id().contains("files/a.txt"));
    assert_eq!((continuation.failures, continuation.state.as_str()), (1, "retry"));
    assert!(due_at >= now_ms() + settings().failure_delays_ms[0] - 1000);
    assert_eq!(continuation.last_failure.unwrap().shape, "Resource ? of ? at ? failed ? times (?)");
    // Before it is due nothing runs.
    let mut untouched = Scripted::done();
    {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut untouched as &mut dyn Step)] };
        assert!(matches!(advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap(), Progress::Waiting { .. }));
    }
    assert!(untouched.asked.is_empty());
    let described = state(&store, ACCOUNT).unwrap();
    assert_eq!(described["continuation"]["last_failure"]["step"], TOOL_RUNS);
    assert!(!described.to_string().contains("example.test"), "the state names no identifier");
    // A redrive makes it due now and keeps its failures; asked again it changes nothing.
    assert!(redrive(&store, ACCOUNT).unwrap());
    assert!(!redrive(&store, ACCOUNT).unwrap());
    let after = kept(&store, ACCOUNT).unwrap().unwrap().value;
    assert_eq!((after.continuation.failures, after.step.as_str(), after.cursor.as_str()), (1, TOOL_RUNS, ""));
    // A passing failure waits its own pace and never counts.
    let mut busy = Scripted::new(vec![Err(StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: "busy".into(), transient: true })]);
    {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut busy as &mut dyn Step)] };
        advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap();
    }
    let after = kept(&store, ACCOUNT).unwrap().unwrap().value.continuation;
    assert_eq!((after.failures, after.transient_failures), (1, 1));
}

#[test]
fn the_same_failure_past_the_bound_waits_longer_each_time_and_a_page_that_moves_nothing_stalls() {
    let rules = settings();
    let mut deletion = begin(&Store::new(&rows_memory()), ACCOUNT, 1).unwrap().value;
    let failure = StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: "the store refused".into(), transient: false };
    let mut waits = Vec::new();
    for _ in 0..rules.maximum_consecutive_failures + 2 {
        failed(&mut deletion, FILES, &failure, 0);
        waits.push(deletion.continuation.due_at);
    }
    assert_eq!(deletion.continuation.state, "recovery-required");
    let bound = rules.maximum_consecutive_failures as usize;
    assert_eq!(waits[bound], waits[bound - 1] * rules.repeat_growth, "past the bound the same failure waits longer");
    assert!(waits.iter().all(|wait| *wait <= rules.longest_repeat_delay_ms));
    // A page that answers what it answered last time moved nothing; after stall_after of them it waits.
    let mut deletion = begin(&Store::new(&rows_memory()), ACCOUNT, 1).unwrap().value;
    deletion.cursor = "same".into();
    for _ in 0..rules.stall_after {
        moved(&mut deletion, &Page { erased: 0, next: Some("same".into()) }, 10);
    }
    assert_eq!(deletion.continuation.state, "stalled");
    assert!(deletion.continuation.due_at > 10);
    moved(&mut deletion, &Page { erased: 1, next: Some("other".into()) }, 20);
    assert_eq!((deletion.continuation.state.as_str(), deletion.continuation.due_at), ("pending", 0), "progress ends the stall");
}

#[test]
fn a_failure_shape_takes_out_quoted_text_addresses_links_ids_and_numbers() {
    let shape = failure_shape("Resource quota: credit_exhausted rows_read 2248334 of 67584 for \"rpc\" at 3f2a9c1e-1111-2222-3333-444455556666");
    assert_eq!(shape, "Resource quota: credit_exhausted rows_read ? of ? for ? at ?");
    assert_eq!(failure_shape(&"word ".repeat(100)).chars().count(), settings().shape_chars);
}

#[test]
fn the_records_step_erases_each_resource_of_the_account_a_page_at_a_time_and_keeps_another_accounts() {
    let limits = store_settings::Limits::fixed(1 << 20, 10 << 30);
    let mut store = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap();
    let resources = &settings().records;
    let count = settings().rows_per_page + 3;
    for (account, resource) in [(ACCOUNT, &resources[0]), (ACCOUNT, &resources[1]), ("someone-else", &resources[0])] {
        for index in 0..count {
            store.mutate(account, resource, Mutation { id: format!("r{index:03}"), expected_version: 0,
                request_key: format!("{account}{resource}{index}"), deleted: false, value: json!({"n": index}) }).unwrap();
        }
    }
    let (mut cursor, mut pages, mut erased) = (String::new(), 0, 0);
    loop {
        let page = records_page(&mut store, ACCOUNT, &cursor).unwrap();
        pages += 1;
        erased += page.erased;
        match page.next {
            Some(next) => cursor = next,
            None => break,
        }
    }
    assert_eq!(erased as usize, count * 2);
    assert!(pages >= 4, "each resource takes more than one page");
    for resource in resources {
        assert!(store.list_page(ACCOUNT, resource, "", 10).unwrap().items.is_empty(), "{resource} holds none of the account's");
    }
    assert_eq!(store.list_page("someone-else", &resources[0], "", MAX_PAGE_ITEMS).unwrap().items.len(), count);
    // Erasing again from the start finds nothing.
    assert_eq!(records_page(&mut store, ACCOUNT, "").unwrap().erased, 0);
}

/// Bytes kept by the byte port in memory, by (origin, key).
#[derive(Default)]
struct Held(std::sync::Mutex<std::collections::HashMap<(String, String), Vec<u8>>>);
struct Port(std::sync::Arc<Held>);
impl crate::account_files::objects::Objects for Port {
    fn set_control(&mut self, _: crate::account_files::CallControl) {}
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, crate::account_files::objects::ObjectError> {
        let objects = self.0 .0.lock().unwrap();
        let bytes = objects.get(&(origin.to_owned(), key.to_owned())).ok_or(crate::account_files::objects::ObjectError::Refused(404, crate::cause!()))?;
        Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), crate::account_files::objects::ObjectError> {
        self.0 .0.lock().unwrap().insert((origin.to_owned(), key.to_owned()), bytes.to_vec());
        Ok(())
    }
    fn write_stream(&self, _: &str, _: &str, _: crate::account_files::objects::Body<'_>, _: &str) -> Result<(), crate::account_files::objects::ObjectError> {
        Err(crate::account_files::objects::ObjectError::Refused(501, crate::cause!()))
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<crate::account_files::objects::Stat>, crate::account_files::objects::ObjectError> {
        Ok(self.0 .0.lock().unwrap().get(&(origin.to_owned(), key.to_owned()))
            .map(|bytes| crate::account_files::objects::Stat { length: bytes.len() as u64, media_type: None }))
    }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<crate::account_files::objects::Listing, crate::account_files::objects::ObjectError> {
        Ok(crate::account_files::objects::Listing::default())
    }
    fn delete(&self, origin: &str, key: &str) -> Result<(), crate::account_files::objects::ObjectError> {
        self.0 .0.lock().unwrap().remove(&(origin.to_owned(), key.to_owned()));
        Ok(())
    }
}

#[test]
fn the_files_step_sets_aside_and_forgets_every_name_and_releases_every_byte_through_the_account_files() {
    let held = std::sync::Arc::new(Held::default());
    let limits = store_settings::Limits::fixed(1 << 20, 10 << 30);
    let mut store = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap();
    let origin: crate::account_files::objects::Origin = serde_json::from_value(json!({
        "kind": crate::account_files::ORIGIN_KIND, "rank": 1, "file_key_prefix": "files/",
        "reach": {"key_id": {"value": "k"}, "secret": {"value": "s"}, "bucket": {"value": "b"},
                  "endpoint": {"value": "https://s3.example.test"}, "region": {"value": "r"}}
    })).unwrap();
    store.mutate(ACCOUNT, crate::account_files::ORIGINS, Mutation {
        id: "store-one".into(), expected_version: 0, request_key: "origin-one".into(), deleted: false,
        value: serde_json::to_value(origin).unwrap(),
    }).unwrap();
    let mut files = AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone())));
    let origins = files.origins().unwrap();
    for (name, text) in [("/a.txt", "first"), ("/notes/b.txt", "second"), ("/notes/deep/c.txt", "third"), ("/gone.txt", "fourth")] {
        files.write_file(name, text.as_bytes(), "application/json", &origins).unwrap();
    }
    // One name was set aside before the deletion began.
    files.call("set_aside", &json!({"name": "/gone.txt"})).unwrap().unwrap();
    assert_eq!(held.0.lock().unwrap().len(), 4);

    let (mut cursor, mut pages) = (String::new(), 0);
    loop {
        let page = files_page(&mut files, &cursor).unwrap();
        pages += 1;
        assert!(pages < 200, "the files step ends");
        match page.next {
            Some(next) => cursor = next,
            None => break,
        }
    }
    let listed = files.list_files(Some("/"), None, None).unwrap();
    assert_eq!((listed["names"].clone(), listed["folders"].clone()), (json!([]), json!([])), "no name is left");
    let aside = files.call("list_set_aside", &json!({"folder": "/"})).unwrap().unwrap();
    assert_eq!((aside["names"].clone(), aside["folders"].clone()), (json!([]), json!([])), "nothing is left set aside");
    assert!(held.0.lock().unwrap().is_empty(), "every byte went to the byte release and was removed");
    assert!(!files.release_pending().unwrap());
    // Run again from the start, the step finds nothing and changes nothing.
    let mut cursor = String::new();
    for _ in 0..10 {
        match files_page(&mut files, &cursor).unwrap().next {
            Some(next) => cursor = next,
            None => break,
        }
    }
}

// ---- Ported from old trillion tests deleted by Trillion-X/trillion #243 (tag old-trillion-before-worker-retire,
// b6ae0ebf81): test/account-delete-finishes-by-alarm.test.mjs, test/account-delete-resumes.test.mjs and
// test/account-erasure-cold-source.test.mjs. The old PersonStore.deleteEverything (25 namespace rows a call) is this
// deletion's `advance` (at most `pages_per_call` pages of at most `rows_per_page` rows), its namespace files and chunks the
// account files the files step erases through their own functions (`files_page`), and its bucket the byte port above.
// The old alarm that finished a deletion with no request is dropped on purpose (erase.rs: "the deletion goes on each time
// it is asked"): later calls of the deletion stand in for the old wakes; every other operation is refused meanwhile
// (account_routes.rs `admitted`, `account_being_deleted`).

/// Files of the account in the account files over the byte port, each with its own bytes.
fn account_files_with(count: usize) -> (AccountFiles<Memory>, std::sync::Arc<Held>) {
    let held = std::sync::Arc::new(Held::default());
    let limits = store_settings::Limits::fixed(1 << 20, 10 << 30);
    let mut store = RecordStore::new(Memory::open("record_store").unwrap(), Box::new(RealClock), limits).unwrap();
    let origin: crate::account_files::objects::Origin = serde_json::from_value(json!({
        "kind": crate::account_files::ORIGIN_KIND, "rank": 1, "file_key_prefix": "files/",
        "reach": {"key_id": {"value": "k"}, "secret": {"value": "s"}, "bucket": {"value": "b"},
                  "endpoint": {"value": "https://s3.example.test"}, "region": {"value": "r"}}
    })).unwrap();
    store.mutate(ACCOUNT, crate::account_files::ORIGINS, Mutation {
        id: "store-one".into(), expected_version: 0, request_key: "origin-one".into(), deleted: false,
        value: serde_json::to_value(origin).unwrap(),
    }).unwrap();
    let mut files = AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone())));
    let origins = files.origins().unwrap();
    for at in 0..count {
        files.write_file(&format!("/file-{at:04}"), format!("bytes of file {at:04}").as_bytes(), "text/plain", &origins).unwrap();
    }
    assert_eq!(held.0.lock().unwrap().len(), count);
    (files, held)
}

/// The files step over the account files, counting the pages it was asked for and the most rows one page erased of
/// its row pages (the byte release's page is bounded by the call's time instead, release.rs `release_gone_bytes`).
struct FilesStep<'a> {
    files: &'a mut AccountFiles<Memory>,
    pages: usize,
    largest: u64,
}
impl Step for FilesStep<'_> {
    fn page(&mut self, cursor: &str) -> Result<Page, StepFailure> {
        self.pages += 1;
        let page = files_page(self.files, cursor)?;
        if !cursor.contains("\"release\"") {
            self.largest = self.largest.max(page.erased);
        }
        Ok(page)
    }
}

/// What is left of the account's files: live names, names set aside, bytes held, and whether a release is pending.
fn files_left(files: &mut AccountFiles<Memory>, held: &Held) -> (Value, Value, usize, bool) {
    let live = files.list_files(Some("/"), None, None).unwrap();
    let aside = files.call("list_set_aside", &json!({"folder": "/"})).unwrap().unwrap();
    (json!([live["names"], live["folders"]]), json!([aside["names"], aside["folders"]]), held.0.lock().unwrap().len(), files.release_pending().unwrap())
}

const OLD_FILES: usize = 60;

/// Ported from old test/account-delete-finishes-by-alarm.test.mjs, "an own delete that answers "being deleted" is
/// finished by the store's alarms alone, with no sign-in". A deletion larger than one call answers `complete: false`
/// with the being-deleted words, from then on the account is being deleted (every other operation refused), and later
/// calls of the deletion alone (the old alarms) finish it within the old 20 wakes, leaving no file and no byte.
#[test]
fn old_account_delete_finishes_by_alarm_a_being_deleted_answer_is_finished_by_later_calls_alone() {
    let memory = rows_memory();
    let store = Store::new(&memory);
    let (mut files, held) = account_files_with(OLD_FILES);
    begin(&store, ACCOUNT, now_ms()).unwrap();
    let mut call = || {
        let (mut runs, mut records) = (Scripted::done(), Scripted::done());
        let mut step = FilesStep { files: &mut files, pages: 0, largest: 0 };
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step), (FILES, &mut step), (RECORDS, &mut records)] };
        advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap()
    };
    let own = answer(&call());
    assert_eq!(own["complete"], false, "the account is larger than one call, so the person is told it is being deleted: {own}");
    assert_eq!(own["said"], words().being_deleted.as_str());
    assert!(deleting(&store, ACCOUNT).unwrap(), "and from now on nothing else of the account answers");
    let mut wakes = 0;
    while deleting(&store, ACCOUNT).unwrap() && wakes < 20 {
        call();
        wakes += 1;
    }
    assert!(!deleting(&store, ACCOUNT).unwrap(), "later calls finished the delete (after {wakes} calls)");
    let (live, aside, bytes, pending) = files_left(&mut files, &held);
    assert_eq!((live, aside, bytes, pending), (json!([[], []]), json!([[], []]), 0, false));
}

/// Ported from old test/account-delete-finishes-by-alarm.test.mjs, "a store whose policy owner already completed its
/// erasure empties itself and stops, instead of retrying forever". Here the one kept deletion row is the policy owner's
/// answer: once complete, asking again runs no step (the old `asked` stays) and a new deletion is refused
/// `account_erasure_complete`, however often it is asked.
#[test]
fn old_account_delete_finishes_by_alarm_a_completed_erasure_stops_and_never_asks_to_erase_again() {
    let memory = rows_memory();
    let store = Store::new(&memory);
    begin(&store, ACCOUNT, 1).unwrap();
    let (mut runs, mut files, mut records) = (Scripted::done(), Scripted::done(), Scripted::done());
    {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step), (FILES, &mut files), (RECORDS, &mut records)] };
        assert!(matches!(advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap(), Progress::Complete { .. }));
    }
    assert!(!deleting(&store, ACCOUNT).unwrap(), "the account emptied itself");
    let asked = runs.asked.len() + files.asked.len() + records.asked.len();
    assert!(asked >= 1, "it asked its owners");
    for _ in 0..3 {
        let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step), (FILES, &mut files), (RECORDS, &mut records)] };
        assert!(matches!(advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap(), Progress::Complete { .. }));
        assert_eq!(begin(&store, ACCOUNT, 2).unwrap_err().code_and_words().0, "account_erasure_complete");
    }
    assert_eq!(runs.asked.len() + files.asked.len() + records.asked.len(), asked, "and once empty it never asks to erase again");
}

/// Ported from old test/account-delete-resumes.test.mjs, "deleting an account empties its store a bounded slice per
/// call, and ends where one call does". Each call takes at most `pages_per_call` pages of at most `rows_per_page` rows
/// (the old 25-row slice and its statement and byte caps), the first leaves files for the next, a cold reopening of the
/// sign-in store still sees the deletion, and the sliced deletion ends in the state one unbounded run of the same step
/// reaches, with every row erased once across the calls. The old bucket's release count (2 x files, its chunks) is
/// the byte port being empty here: a file keeps no separate chunk row. The rows-per-page bound holds for the step's row
/// pages; its byte release removes objects until the call's time ends, as its owner bounds it (erase/settings.json
/// "or files, or runs as the step's owner bounds it"; account_files/release.rs `release_gone_bytes`).
#[test]
fn old_account_delete_resumes_a_deletion_empties_a_bounded_slice_per_call_and_ends_where_one_run_does() {
    let memory = rows_memory();
    let (mut sliced, sliced_held) = account_files_with(OLD_FILES);
    begin(&Store::new(&memory), ACCOUNT, now_ms()).unwrap();
    let mut calls = Vec::new();
    for call in 1.. {
        assert!(call <= 50, "every call erases rows, so deletion finishes");
        let store = Store::new(&memory);
        let (mut runs, mut records) = (Scripted::done(), Scripted::done());
        let mut step = FilesStep { files: &mut sliced, pages: 0, largest: 0 };
        let progress = {
            let mut steps = Steps { given: vec![(TOOL_RUNS, &mut runs as &mut dyn Step), (FILES, &mut step), (RECORDS, &mut records)] };
            advance(&store, ACCOUNT, &mut steps, later(), &yes).unwrap()
        };
        calls.push((step.pages, step.largest));
        if matches!(progress, Progress::Complete { .. }) {
            break;
        }
        assert!(deleting(&store, ACCOUNT).unwrap(), "every other operation is refused from the first call on");
        if call == 1 {
            assert!(!sliced.list_files(Some("/"), None, None).unwrap()["names"].as_array().unwrap().is_empty(), "the first call leaves files for the next");
            let cold = Store::new(&memory);
            assert!(deleting(&cold, ACCOUNT).unwrap(), "a cold start still sees the deletion in progress");
        }
    }
    assert!(calls.len() > 1, "an account larger than one call takes more than one call");
    for (index, (pages, largest)) in calls.iter().enumerate() {
        assert!(*pages <= settings().pages_per_call, "call {} took {pages} pages", index + 1);
        assert!(*largest <= settings().rows_per_page as u64, "call {} erased {largest} rows in one page", index + 1);
    }
    let store = Store::new(&memory);
    assert!(!deleting(&store, ACCOUNT).unwrap());
    let kept = kept(&store, ACCOUNT).unwrap().unwrap().value;
    assert!(kept.erased_at.is_some(), "the finished deletion is terminal");

    let (mut whole, whole_held) = account_files_with(OLD_FILES);
    let (mut cursor, mut pages, mut erased) = (String::new(), 0, 0);
    loop {
        let page = files_page(&mut whole, &cursor).unwrap();
        pages += 1;
        erased += page.erased;
        match page.next {
            Some(next) => cursor = next,
            None => break,
        }
    }
    assert!(pages > settings().pages_per_call, "one unbounded run does more than one call is allowed to");
    assert_eq!(files_left(&mut sliced, &sliced_held), files_left(&mut whole, &whole_held), "the sliced deletion ends in the state one run reaches");
    assert_eq!(files_left(&mut sliced, &sliced_held), (json!([[], []]), json!([[], []]), 0, false));
    assert_eq!(kept.erased[FILES], erased, "every row was erased once across the calls");
}

/// Ported from old test/account-erasure-cold-source.test.mjs, "a cold store answers its erasure source as plain values,
/// the same as a warm one". The erasure source is the account's kept deletion row in its own rows database
/// (`rows::open`, SQLite): read warm, and read again from the file opened anew, it answers the same plain values, its
/// account the deleting user and `erased_at` empty. The old `generation: "initial"` has no owner: one row is the deletion.
#[test]
fn old_account_erasure_cold_source_a_cold_store_answers_its_erasure_source_the_same_as_a_warm_one() {
    let folder = tempfile::tempdir().unwrap();
    let warm_storage = crate::account::rows::open(folder.path()).unwrap();
    let warm_store = Store::new(&*warm_storage);
    begin(&warm_store, "user-cold-erasure", 1).unwrap();
    let warm = (state(&warm_store, "user-cold-erasure").unwrap(), kept(&warm_store, "user-cold-erasure").unwrap().unwrap());
    drop(warm_store);
    drop(warm_storage);
    let cold_storage = crate::account::rows::open(folder.path()).unwrap();
    let cold_store = Store::new(&*cold_storage);
    let cold = (state(&cold_store, "user-cold-erasure").unwrap(), kept(&cold_store, "user-cold-erasure").unwrap().unwrap());
    assert_eq!(cold.0, warm.0);
    assert_eq!(cold.1.value, warm.1.value);
    assert_eq!(cold.1.account, "user-cold-erasure");
    assert_eq!(cold.1.value.erased_at, None);
    assert_eq!(cold.0["erased_at"], Value::Null);
}
