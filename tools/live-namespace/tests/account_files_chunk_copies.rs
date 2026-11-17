// tests/account_files_chunk_copies.rs
//
// Purpose: The checked copies of chunks between the byte store and a reader (`src/account_files/chunk_copies.rs`), over the account
// files with a byte port that counts the reads that reach it. Synthetic data only.

mod account_files_common;

use account_files_common::{account_files, upload, Port};
use live_namespace::account_files::{
    chunk_copies::{ChunkCopies, Settings},
    objects::{Body, Listing, ObjectError, Objects, Stat},
    AccountFiles, CallControl, FILES,
};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc};

/// The common port, counting reads (and the bytes) that reach the store.
struct Counting(Port, Arc<AtomicU64>, Arc<AtomicU64>);
impl Objects for Counting {
    fn set_control(&mut self, control: CallControl) { self.0.set_control(control) }
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        self.1.fetch_add(1, Ordering::SeqCst);
        self.2.fetch_add(length, Ordering::SeqCst);
        self.0.read(origin, key, offset, length)
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), ObjectError> { self.0.write(origin, key, bytes, media_type) }
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> { self.0.write_stream(origin, key, body, media_type) }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> { self.0.stat(origin, key) }
    fn list(&self, origin: &str, prefix: &str, after: &str, limit: usize) -> Result<Listing, ObjectError> { self.0.list(origin, prefix, after, limit) }
}

fn settings(touches: u32) -> Settings {
    Settings { folder: "c".into(), keep_percent_of_free: 100, touches_before_fill: touches, touches_kept: 64, fill_bytes_most_per_call: 1 << 30 }
}

/// Account files holding one file of `length` bytes, its reads counted, the copies in `folder`.
fn with_file(length: usize, copies: Option<Arc<ChunkCopies>>) -> (AccountFiles, String, Arc<AtomicU64>, Arc<AtomicU64>, Vec<u8>) {
    let (files, held, _) = account_files();
    let mut files = files;
    let bytes: Vec<u8> = (0..length).map(|n| (n * 7 % 251) as u8).collect();
    let identity = upload(&mut files, 'a', "/big.bin", &bytes);
    let (reads, moved) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    let files = AccountFiles::with_objects(files.store.clone(), "account-a", Box::new(Counting(Port(held), reads.clone(), moved.clone()))).with_chunk_copies(copies);
    (files, identity, reads, moved, bytes)
}

fn file(files: &AccountFiles, identity: &str) -> live_namespace::store::Record {
    files.store.get(FILES, identity).unwrap().record.unwrap()
}

#[test]
fn a_chunk_asked_twice_is_kept_and_the_third_read_makes_no_store_request() {
    let dir = tempfile::tempdir().unwrap();
    let copies = ChunkCopies::open(&dir.path().join("c"), settings(2), 1 << 30).unwrap();
    let (files, identity, reads, moved, bytes) = with_file(30_000, Some(copies));
    let file = file(&files, &identity);
    assert_eq!(files.read_range(&file, 10, 100).unwrap(), &bytes[10..110], "the first ask is read as asked");
    assert_eq!(moved.load(Ordering::SeqCst), 100, "and not widened");
    assert_eq!(files.read_range(&file, 500, 100).unwrap(), &bytes[500..600], "the second ask fills the chunk");
    assert_eq!(moved.load(Ordering::SeqCst), 100 + 30_000, "the whole chunk was fetched once");
    let before = reads.load(Ordering::SeqCst);
    assert_eq!(files.read_range(&file, 1000, 5000).unwrap(), &bytes[1000..6000]);
    assert_eq!(files.read_range(&file, 29_000, 1000).unwrap(), &bytes[29_000..]);
    assert_eq!(reads.load(Ordering::SeqCst), before, "answered from the copy, no request reached the store");
}

#[test]
fn a_read_of_the_whole_chunk_is_kept_as_it_is_read_with_no_extra_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let copies = ChunkCopies::open(&dir.path().join("c"), settings(2), 1 << 30).unwrap();
    let (files, identity, reads, moved, bytes) = with_file(30_000, Some(copies));
    let file = file(&files, &identity);
    assert_eq!(files.read_range(&file, 0, 30_000).unwrap(), bytes);
    assert_eq!(moved.load(Ordering::SeqCst), 30_000);
    let before = reads.load(Ordering::SeqCst);
    assert_eq!(files.read_range(&file, 20, 30).unwrap(), &bytes[20..50]);
    assert_eq!(reads.load(Ordering::SeqCst), before);
}

#[test]
fn a_copy_that_was_changed_is_not_served_and_the_store_answers() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("c");
    let copies = ChunkCopies::open(&folder, settings(1), 1 << 30).unwrap();
    let (files, identity, reads, _, bytes) = with_file(30_000, Some(copies));
    let file = file(&files, &identity);
    assert_eq!(files.read_range(&file, 0, 10).unwrap(), &bytes[..10]);
    let kept: Vec<_> = std::fs::read_dir(&folder).unwrap().flatten().collect();
    assert_eq!(kept.len(), 1, "one chunk kept");
    let length = std::fs::metadata(kept[0].path()).unwrap().len() as usize;
    std::fs::write(kept[0].path(), vec![0u8; length]).unwrap();
    // A new run: the copy is found and hashed on its first read.
    let again = ChunkCopies::open(&folder, settings(1), 1 << 30).unwrap();
    let files = files.with_chunk_copies(Some(again));
    let before = reads.load(Ordering::SeqCst);
    assert_eq!(files.read_range(&file, 0, 10).unwrap(), &bytes[..10], "the bytes are the file's, not the changed copy's");
    assert!(reads.load(Ordering::SeqCst) > before, "the store was asked");
}

#[test]
fn a_file_kept_as_one_object_is_never_copied() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("c");
    let copies = ChunkCopies::open(&folder, settings(1), 1 << 30).unwrap();
    let (files, held, _) = account_files();
    let mut files = files.with_chunk_copies(Some(copies));
    let bytes = vec![5u8; 1000];
    let identity = account_files_common::write(&mut files, "/small.txt", &bytes);
    let file = file(&files, &identity);
    for _ in 0..3 {
        assert_eq!(files.read_range(&file, 0, 1000).unwrap(), bytes);
    }
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0);
    drop(held);
}

#[test]
fn copies_that_cannot_be_kept_never_fail_a_read() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    std::fs::write(&blocker, b"x").unwrap();
    assert!(ChunkCopies::open(&blocker.join("c"), settings(1), 1 << 30).is_none(), "no folder, no copies");
    // No room: the bound is zero bytes, so nothing is kept and every read still answers.
    let copies = ChunkCopies::open(&dir.path().join("none"), settings(1), 0).unwrap();
    let (files, identity, reads, _, bytes) = with_file(40_000, Some(copies));
    let file = file(&files, &identity);
    for _ in 0..3 {
        assert_eq!(files.read_range(&file, 100, 50).unwrap(), &bytes[100..150]);
    }
    assert_eq!(reads.load(Ordering::SeqCst), 3);
}
