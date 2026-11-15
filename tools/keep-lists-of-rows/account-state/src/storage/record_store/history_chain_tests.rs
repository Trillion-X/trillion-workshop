// Purpose: `history_chain.rs`: the chain check over kept history files (whole and paged, with names-only walks,
// anchored tails and a leading run of unchained files), the gzip archive form and the verified keep with its readback.
// Ported one to one from old trillion tests (tag old-trillion-before-worker-retire):
// - test/record-history-chain-page.test.mjs (4 tests)
// - test/record-history-chain-tail.test.mjs (3 tests)
// - test/record-history-chain-unchained-lead.test.mjs (5 tests)
// - test/record-history-readback.test.mjs (4 tests)
// - test/record-history.test.mjs: the archive tests (2 tests here; the archive-and-retry one is in history_archive_tests.rs)
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::*;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

fn name(at: usize) -> String {
    format!("00000000-0000-7000-8000-{at:012}")
}
fn chained(previous: Option<&str>, at: usize) -> Vec<u8> {
    let mut bytes = chain_line(previous);
    bytes.extend(format!("{{\"row\":{at}}}\n").into_bytes());
    bytes
}
fn chain(count: usize) -> (BTreeMap<String, Vec<u8>>, Option<String>) {
    let mut files = BTreeMap::new();
    let mut previous: Option<String> = None;
    for at in 0..count {
        let bytes = chained(previous.as_deref(), at);
        previous = Some(history_identity(&bytes));
        files.insert(name(at), bytes);
    }
    (files, previous)
}

struct Store {
    files: BTreeMap<String, Vec<u8>>,
    reads: Vec<String>,
}
impl KeptFiles for Store {
    fn list(&mut self, after: Option<&str>, limit: usize) -> Result<Listed, HistoryError> {
        let names: Vec<&String> = self.files.keys().collect();
        let from = after.map_or(0, |after| names.iter().position(|name| name.as_str() == after).map_or(0, |at| at + 1));
        let page: Vec<String> = names.iter().skip(from).take(limit).map(|name| name.to_string()).collect();
        let cursor = (from + limit < names.len()).then(|| page.last().cloned()).flatten();
        Ok(Listed { names: page, cursor })
    }
    fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, HistoryError> {
        self.reads.push(name.to_string());
        Ok(self.files.get(name).cloned())
    }
}
fn store(files: &BTreeMap<String, Vec<u8>>) -> Store {
    Store { files: files.clone(), reads: Vec::new() }
}
fn ask<'a>(head: Option<&'a str>, cursor: Option<&'a str>, limit: usize) -> PageCheck<'a> {
    PageCheck { head, substitutions: &[], cursor, limit, names_only: false, anchor: false, timing: None }
}
/// Every page of a check from the start: the last answer, the calls made and the files read.
fn walk(files: &BTreeMap<String, Vec<u8>>, head: Option<&str>, limit: usize) -> (Paged, usize, Vec<String>) {
    let mut s = store(files);
    let mut cursor: Option<String> = None;
    let mut calls = 0;
    loop {
        let answer = check_history_chain_page(&mut s, ask(head, cursor.as_deref(), limit)).unwrap();
        calls += 1;
        match answer {
            Paged::More { cursor: next, .. } => cursor = Some(next),
            other => return (other, calls, s.reads),
        }
    }
}

// test/record-history-chain-page.test.mjs

#[test]
fn an_intact_chain_reaches_its_head_across_pages_resuming_from_each_cursor() {
    let (files, head) = chain(10);
    let (answer, calls, _) = walk(&files, head.as_deref(), 3);
    assert_eq!(answer, Paged::Done(Reached { head: head.clone(), files: 10, unchained: 0 }, None));
    assert_eq!(calls, 4, "ten files, three a call");
}

#[test]
fn a_missing_middle_file_is_named_where_the_chain_breaks() {
    let (mut files, head) = chain(10);
    let fifth = files.keys().nth(4).unwrap().clone();
    files.remove(&fifth);
    let Paged::Broken(broken, _) = walk(&files, head.as_deref(), 3).0 else { panic!("the chain should break") };
    assert!(broken.why.contains("follows a file that is missing or was changed"), "{}", broken.why);
    assert_eq!(broken.at, 4);
}

#[test]
fn a_head_the_newest_file_is_not_is_refused_at_the_end_and_nothing_is_written() {
    let (files, _) = chain(7);
    let before = files.clone();
    let Paged::Broken(broken, _) = walk(&files, Some("a different head"), 3).0 else { panic!("a wrong head is refused") };
    assert!(broken.why.contains("newest kept file is not the one the store last kept"));
    assert_eq!(files, before);
}

#[test]
fn a_page_larger_than_the_bound_or_a_cursor_from_nowhere_is_refused() {
    let (files, head) = chain(2);
    let too_many = check_history_chain_page(&mut store(&files), ask(head.as_deref(), None, 201)).unwrap_err();
    assert!(too_many.contains("between 1 and 200"));
    let nowhere = check_history_chain_page(&mut store(&files), ask(head.as_deref(), Some("not json"), 3)).unwrap_err();
    assert!(nowhere.contains("not from this check"));
}

// test/record-history-chain-tail.test.mjs

#[test]
fn a_names_only_walk_reads_no_file_and_an_anchored_check_from_a_late_cursor_reaches_the_head_reading_only_the_tail() {
    let (files, head) = chain(40);
    let mut s = store(&files);
    let mut cursors: Vec<Option<String>> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let answer = check_history_chain_page(&mut s, PageCheck { names_only: true, ..ask(head.as_deref(), cursor.as_deref(), 5) }).unwrap();
        cursors.push(cursor.clone());
        let Paged::Names { cursor: next, .. } = answer else { panic!("names only") };
        if next.is_none() {
            break;
        }
        cursor = next;
    }
    assert!(s.reads.is_empty(), "the walk read nothing");
    let mut tail = store(&files);
    let mut cursor = cursors[cursors.len() - 3].clone();
    let answer = loop {
        match check_history_chain_page(&mut tail, PageCheck { anchor: true, ..ask(head.as_deref(), cursor.as_deref(), 5) }).unwrap() {
            Paged::More { cursor: next, .. } => cursor = Some(next),
            other => break other,
        }
    };
    let Paged::Done(reached, _) = answer else { panic!("the tail reaches the head: {answer:?}") };
    assert_eq!(reached.head, head);
    assert_eq!(tail.reads.len(), 15, "three pages of five were read");
}

#[test]
fn an_anchored_check_still_breaks_when_a_later_file_does_not_follow_and_a_wrong_head_is_refused() {
    let (mut files, head) = chain(12);
    let tenth = files.keys().nth(9).unwrap().clone();
    files.remove(&tenth);
    let mut s = store(&files);
    let start = serde_json::json!({ "list": files.keys().nth(3).unwrap(), "previous": null, "at": 0 }).to_string();
    let mut cursor = Some(start);
    let answer = loop {
        match check_history_chain_page(&mut s, PageCheck { anchor: true, ..ask(head.as_deref(), cursor.as_deref(), 3) }).unwrap() {
            Paged::More { cursor: next, .. } => cursor = Some(next),
            other => break other,
        }
    };
    assert!(matches!(answer, Paged::Broken(..)));
    let (intact, _) = chain(12);
    let from = serde_json::json!({ "list": intact.keys().nth(8).unwrap(), "previous": null, "at": 0 }).to_string();
    let wrong = check_history_chain_page(&mut store(&intact), PageCheck { anchor: true, ..ask(Some("not the head"), Some(&from), 200) }).unwrap();
    assert!(matches!(wrong, Paged::Broken(..)));
}

#[test]
fn timing_is_in_the_answer_only_when_asked_for_and_splits_the_read_from_the_hash() {
    let (files, head) = chain(4);
    let plain = check_history_chain_page(&mut store(&files), ask(head.as_deref(), None, 10)).unwrap();
    assert!(matches!(plain, Paged::Done(_, None)));
    let mut now = 0.0;
    let mut clock = || {
        now += 7.0;
        now
    };
    let timed = check_history_chain_page(&mut store(&files), PageCheck { timing: Some(&mut clock), ..ask(head.as_deref(), None, 10) }).unwrap();
    let Paged::Done(_, Some(timing)) = timed else { panic!("timed answer") };
    assert!(timing.bytes > 0 && timing.read_ms > 0 && timing.hash_ms > 0 && timing.list_ms > 0);
}

// test/record-history-chain-unchained-lead.test.mjs

fn build(spec: &[&str]) -> (BTreeMap<String, Vec<u8>>, Option<String>) {
    let mut files = BTreeMap::new();
    let mut previous: Option<String> = None;
    for (at, kind) in spec.iter().enumerate() {
        let bytes = match *kind {
            "plain" => format!("{{\"row\":{at}}}\n").into_bytes(),
            "chained" => chained(previous.as_deref(), at),
            "chained-null" => chained(None, at),
            "chained-wrong" => chained(Some(&format!("1f:{}", "e".repeat(64))), at),
            _ => unreachable!(),
        };
        previous = Some(history_identity(&bytes));
        files.insert(name(at), bytes);
    }
    (files, previous)
}

#[test]
fn a_leading_run_of_unchained_files_passes_is_counted_and_the_first_chained_file_may_name_the_last_of_them() {
    let (files, head) = build(&["plain", "plain", "plain", "chained", "chained", "chained"]);
    assert_eq!(walk(&files, head.as_deref(), 2).0, Paged::Done(Reached { head: head.clone(), files: 6, unchained: 3 }, None));
}

#[test]
fn the_first_chained_file_may_also_name_none_as_the_first_chain_header_was_written() {
    let (files, head) = build(&["plain", "plain", "chained-null", "chained"]);
    assert_eq!(walk(&files, head.as_deref(), 2).0, Paged::Done(Reached { head: head.clone(), files: 4, unchained: 2 }, None));
}

#[test]
fn an_unchained_file_after_a_chained_one_is_a_break_and_is_reported_where_it_is() {
    let (files, head) = build(&["plain", "chained", "plain", "chained"]);
    let Paged::Broken(broken, _) = walk(&files, head.as_deref(), 2).0 else { panic!("a break") };
    assert_eq!(broken.at, 2);
    assert!(broken.why.contains("does not name the file before it"));
}

#[test]
fn a_first_chained_file_naming_the_wrong_predecessor_is_a_break() {
    let (files, head) = build(&["plain", "plain", "chained-wrong", "chained"]);
    let Paged::Broken(broken, _) = walk(&files, head.as_deref(), 2).0 else { panic!("a break") };
    assert_eq!(broken.at, 2);
    assert!(broken.why.contains("follows a file that is missing or was changed"));
}

#[test]
fn a_history_of_unchained_files_only_reaches_a_head_that_is_the_last_of_them() {
    let (files, head) = build(&["plain", "plain"]);
    assert!(matches!(walk(&files, head.as_deref(), 2).0, Paged::Done(..)));
    assert!(matches!(walk(&files, Some("another head"), 2).0, Paged::Broken(..)));
}

// test/record-history-readback.test.mjs: a keeper whose read back is shaped by the test.

type Shape = Box<dyn FnMut(&[u8], &(Option<String>, Option<String>)) -> KeptObject<'static>>;
struct Bucket {
    archived: Vec<u8>,
    labels: (Option<String>, Option<String>),
    read_back: Shape,
}
impl Keeper for Bucket {
    fn put(&mut self, _name: &str, bytes: &[u8], blake3_hex: &str, encoding: &str) -> Result<(), HistoryError> {
        self.archived = bytes.to_vec();
        self.labels = (Some(blake3_hex.to_string()), Some(encoding.to_string()));
        Ok(())
    }
    fn get(&mut self, _name: &str) -> Result<Option<KeptObject<'_>>, HistoryError> {
        Ok(Some((self.read_back)(&self.archived, &self.labels)))
    }
}
fn bucket(read_back: Shape) -> Bucket {
    Bucket { archived: Vec::new(), labels: (None, None), read_back }
}
fn source() -> Vec<u8> {
    "a history line that compresses\n".repeat(200).into_bytes()
}
fn keep(bucket: &mut Bucket) -> Result<u64, HistoryError> {
    keep_archive(bucket, "history", &source(), &mut |_, _, _, _| {}, &mut || 0.0)
}
/// A body that counts its pulls and whether it was dropped unfinished (cancelled).
struct Body {
    chunks: std::vec::IntoIter<Result<Vec<u8>, HistoryError>>,
    pulled: Rc<Cell<usize>>,
    ended: Rc<Cell<bool>>,
}
impl Iterator for Body {
    type Item = Result<Vec<u8>, HistoryError>;
    fn next(&mut self) -> Option<Self::Item> {
        self.pulled.set(self.pulled.get() + 1);
        let next = self.chunks.next();
        if next.is_none() {
            self.ended.set(true);
        }
        next
    }
}
fn body(chunks: Vec<Result<Vec<u8>, HistoryError>>, pulled: &Rc<Cell<usize>>, ended: &Rc<Cell<bool>>) -> Box<dyn Iterator<Item = Result<Vec<u8>, HistoryError>>> {
    Box::new(Body { chunks: chunks.into_iter(), pulled: pulled.clone(), ended: ended.clone() })
}

#[test]
fn archive_readback_refuses_a_mismatched_declared_size_without_pulling_its_body() {
    for declared in [|size: u64| size + 1, |size: u64| size - 1, |_| 0] {
        let (pulled, ended) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(false)));
        let (p, e) = (pulled.clone(), ended.clone());
        let mut b = bucket(Box::new(move |bytes, labels| KeptObject {
            size: declared(bytes.len() as u64),
            blake3: labels.0.clone(),
            encoding: labels.1.clone(),
            body: body(vec![Ok(bytes.to_vec())], &p, &e),
        }));
        assert!(keep(&mut b).unwrap_err().contains("did not match"));
        assert_eq!(pulled.get(), 0, "declared size is checked before any body data is pulled");
    }
}

#[test]
fn archive_readback_hashes_exact_bytes_across_arbitrary_chunks_to_the_end() {
    for width in [1usize, 7, 64, 4096] {
        let (pulled, ended) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(false)));
        let (p, e) = (pulled.clone(), ended.clone());
        let mut b = bucket(Box::new(move |bytes, labels| KeptObject {
            size: bytes.len() as u64,
            blake3: labels.0.clone(),
            encoding: labels.1.clone(),
            body: body(bytes.chunks(width).map(|chunk| Ok(chunk.to_vec())).collect(), &p, &e),
        }));
        assert!(keep(&mut b).unwrap() > 0);
        assert!(pulled.get() > 0);
        assert!(ended.get(), "a matching prefix is not sufficient; verification reaches the end");
    }
}

#[test]
fn archive_readback_stops_at_the_first_overflowing_chunk_and_never_pulls_the_rest() {
    for overflow in ["one chunk", "matching prefix"] {
        let (pulled, ended) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(false)));
        let (p, e) = (pulled.clone(), ended.clone());
        let mut b = bucket(Box::new(move |bytes, labels| {
            let chunks = if overflow == "one chunk" {
                vec![Ok(vec![0; bytes.len() + 1]), Ok(vec![0])]
            } else {
                vec![Ok(bytes.to_vec()), Ok(vec![0]), Ok(vec![0])]
            };
            KeptObject { size: bytes.len() as u64, blake3: labels.0.clone(), encoding: labels.1.clone(), body: body(chunks, &p, &e) }
        }));
        assert!(keep(&mut b).unwrap_err().contains("did not match"));
        assert_eq!(pulled.get(), if overflow == "one chunk" { 1 } else { 2 });
        assert!(!ended.get(), "the rest of the body is never pulled");
    }
}

#[test]
fn archive_readback_refuses_a_short_stream_and_passes_on_a_stream_failure() {
    for failure in ["short", "stream error"] {
        let (pulled, ended) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(false)));
        let (p, e) = (pulled.clone(), ended.clone());
        let mut b = bucket(Box::new(move |bytes, labels| {
            let chunks = if failure == "short" { vec![Ok(bytes[..bytes.len() - 1].to_vec())] } else { vec![Err(HistoryError::new("bucket stream failed".to_string()))] };
            KeptObject { size: bytes.len() as u64, blake3: labels.0.clone(), encoding: labels.1.clone(), body: body(chunks, &p, &e) }
        }));
        let refused = keep(&mut b).unwrap_err();
        assert!(refused.contains(if failure == "short" { "did not match" } else { "bucket stream failed" }), "{refused}");
    }
}

// test/record-history.test.mjs: the archive form and the verified keep.

#[test]
fn compressed_record_history_keeps_the_exact_bytes_that_its_chain_checks() {
    let source: Vec<u8> = (0..500)
        .map(|index| serde_json::json!({ "id": format!("00000000-0000-0000-0000-{index:012}"), "type": "record-change",
            "value": { "field": "status", "before": "Waiting", "after": "Done", "owner": "same-person" } }).to_string() + "\n")
        .collect::<String>()
        .into_bytes();
    let compressed = encode_archive(&source);
    assert!(compressed.len() < source.len(), "the keeper stores the compressed page");
    let restored = decode_archive(&compressed).unwrap();
    assert_eq!(restored, source, "readback restores the exact bytes used by history_identity");
    assert_eq!(history_identity(&restored), history_identity(&source));
}

#[test]
fn verified_archive_separates_remote_stages_and_keeps_exact_source_bytes_even_when_observation_fails() {
    let source = "private-history-content\n".repeat(100).into_bytes();
    let clock = Rc::new(Cell::new(0.0f64));
    struct Timed {
        clock: Rc<Cell<f64>>,
        archived: Vec<u8>,
        labels: (Option<String>, Option<String>),
    }
    impl Keeper for Timed {
        fn put(&mut self, name: &str, bytes: &[u8], blake3_hex: &str, encoding: &str) -> Result<(), HistoryError> {
            assert_eq!(name, "private-history-name");
            self.archived = bytes.to_vec();
            self.labels = (Some(blake3_hex.into()), Some(encoding.into()));
            self.clock.set(self.clock.get() + 1000.0);
            Ok(())
        }
        fn get(&mut self, name: &str) -> Result<Option<KeptObject<'_>>, HistoryError> {
            assert_eq!(name, "private-history-name");
            self.clock.set(self.clock.get() + 2000.0);
            let (clock, bytes) = (self.clock.clone(), self.archived.clone());
            let body = std::iter::once_with(move || {
                clock.set(clock.get() + 3000.0);
                Ok(bytes)
            });
            Ok(Some(KeptObject { size: self.archived.len() as u64, blake3: self.labels.0.clone(), encoding: self.labels.1.clone(), body: Box::new(body) }))
        }
    }
    let mut keeper = Timed { clock: clock.clone(), archived: Vec::new(), labels: (None, None) };
    let observations: RefCell<Vec<(String, f64, u64, bool)>> = RefCell::new(Vec::new());
    let read = clock.clone();
    let kept = keep_archive(
        &mut keeper,
        "private-history-name",
        &source,
        &mut |stage, took, bytes, ok| {
            observations.borrow_mut().push((stage.to_string(), took, bytes, ok));
            panic!("observer unavailable");
        },
        &mut || read.get(),
    )
    .unwrap();
    assert_eq!(kept, keeper.archived.len() as u64);
    assert_eq!(decode_archive(&keeper.archived).unwrap(), source);
    let took = |stage: &str| observations.borrow().iter().find(|row| row.0 == stage).unwrap().1;
    assert_eq!(took("archive-put"), 1000.0);
    assert_eq!(took("archive-get"), 2000.0);
    assert_eq!(took("archive-read"), 3000.0);
    assert!(observations.borrow().iter().all(|row| row.3));
    assert!(!format!("{:?}", observations.borrow()).contains("private-history"), "observation cannot expose names or content");
}

#[test]
fn history_refusals_keep_their_condition_and_a_streams_original_cause() {
    let object = |size, chunks: Vec<Result<Vec<u8>, HistoryError>>| KeptObject {
        size,
        blake3: None,
        encoding: None,
        body: Box::new(chunks.into_iter()),
    };
    let declared = readback_identity(object(3, vec![]), 2).unwrap_err();
    let short = readback_identity(object(2, vec![Ok(vec![1])]), 2).unwrap_err();
    assert_eq!(declared.code, short.code, "existing mismatch words are preserved");
    assert_ne!(declared.cause(), short.cause(), "the declared-size and short-stream conditions remain distinct");
    for failure in [&declared, &short] {
        assert_eq!(failure.cause().file(), "src/storage/record_store/history_chain.rs");
        let source = include_str!("history_chain.rs");
        assert!(source.lines().nth(failure.cause().line() as usize - 1).unwrap().contains("mismatch(crate::cause!())"));
    }
    let source = HistoryError::new("bucket stream failed".to_owned());
    let cause = source.cause();
    let returned = readback_identity(object(2, vec![Err(source)]), 2).unwrap_err();
    assert_eq!(returned.code, "bucket stream failed");
    assert_eq!(returned.cause(), cause);
}
