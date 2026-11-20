// tests/share_batch.rs
//
// Purpose: A share of many files resolves all of its files in a constant number of store reads, not several per file. A store
// that counts every read it is asked for shares 50 items with 2 forms each (150 files over 2 folders, the way a footage share
// names them) and must answer in a small bound; the same share by identity must answer in the same bound. Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::{account_files_over, write};
use live_namespace::{
    account_files::AccountFiles,
    store::{Change, Changed, Error, Mutation, Page, Read, Record, Rows, SqlStore, Total},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Instant,
};

const ORIGIN: &str = "https://shares.example.test";

/// A record store that counts each read (one `get`, `get_many` or `held_record_with_version` is one round trip).
struct Counting {
    rows: SqlStore,
    reads: AtomicUsize,
}
impl Counting {
    fn count(&self) {
        self.reads.fetch_add(1, Ordering::SeqCst);
    }
}
impl Rows for Counting {
    fn get(&self, scope: &str, id: &str) -> Result<Read, Error> {
        self.count();
        self.rows.get(scope, id)
    }
    fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<Record>>, Error> {
        self.count();
        self.rows.get_many(scope, ids)
    }
    fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<Record>), Error> {
        self.count();
        self.rows.held_record_with_version(scope, id)
    }
    fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<Page<Record, String>, Error> {
        self.count();
        self.rows.list_page(scope, after, limit)
    }
    fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), Error> {
        self.count();
        self.rows.ids(scope, after, limit)
    }
    fn mutate(&self, scope: &str, input: Mutation) -> Result<Change, Error> {
        self.rows.mutate(scope, input)
    }
    fn stamp(&self, scope: &str) -> Result<i64, Error> {
        self.rows.stamp(scope)
    }
    fn totals(&self) -> Result<Vec<Total>, Error> {
        self.rows.totals()
    }
    fn search(&self, words: &[String], hits: usize) -> Result<Vec<Record>, Error> {
        self.count();
        self.rows.search(words, hits)
    }
    fn place(&self) -> String {
        self.rows.place()
    }
    fn order(&self) -> Result<i64, Error> {
        self.rows.order()
    }
    fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<Page<Changed, i64>, Error> {
        self.rows.changes(prefixes, after, limit)
    }
    fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, Record)>, Error> {
        self.rows.minted(prefixes, minted)
    }
    fn wait_for_order(&self, after: i64, until: Instant) -> Result<i64, Error> {
        self.rows.wait_for_order(after, until)
    }
}

/// Fifty footage items, each with a play copy and a poster, written under two folders.
/// The share items by name, and the same items by identity (each file's identity as its write answered it).
type Items = Vec<(String, BTreeMap<String, String>)>;

fn footage() -> (AccountFiles, Arc<Counting>, Items, Items) {
    let store = Arc::new(Counting { rows: SqlStore::memory().unwrap(), reads: AtomicUsize::new(0) });
    let (mut files, _, _) = account_files_over(store.clone());
    let origins = files.origins().unwrap();
    let (mut asked, mut by_identity) = (Vec::new(), Vec::new());
    for n in 0..50 {
        let clip = format!("/Recordings/clip-{n:02}.mp4");
        let play = format!("/Shared/previews/clip-{n:02} 1080p.mp4");
        let poster = format!("/Shared/previews/clip-{n:02}.jpg");
        let mut made = |name: &str, media_type: &str| files.write_file(name, format!("bytes of {name}").as_bytes(), media_type, &origins).unwrap()["identity"].as_str().unwrap().to_owned();
        let identity = made(&clip, "video/mp4");
        let forms = [("play", made(&play, "video/mp4")), ("poster", made(&poster, "image/jpeg"))];
        by_identity.push((identity, forms.iter().map(|(form, id)| (form.to_string(), id.clone())).collect()));
        asked.push((clip, forms.iter().map(|(form, id)| (form.to_string(), id.clone())).collect()));
    }
    write(&mut files, "/Notes/a.txt", b"words");
    (files.with_share_origin(ORIGIN), store, asked, by_identity)
}

#[test]
fn sharing_fifty_items_with_two_forms_each_reads_the_store_a_constant_number_of_times() {
    let (mut files, store, asked, _) = footage();
    let before = store.reads.load(Ordering::SeqCst);
    let answer = files.share_files(&asked, Some("Footage"), 3600).unwrap();
    let reads = store.reads.load(Ordering::SeqCst) - before;
    assert_eq!(answer["items"], json!(50));
    assert!(reads <= 8, "sharing 50 items with 2 forms made {reads} store reads; the bound is 8 (a constant, not per file)");
    println!("share_files of 50 items x 2 forms (by name): {reads} store reads");
}

#[test]
fn sharing_the_same_files_by_identity_is_as_small() {
    let (mut files, store, _, by_identity) = footage();
    let before = store.reads.load(Ordering::SeqCst);
    let answer = files.share_files(&by_identity, None, 3600).unwrap();
    let reads = store.reads.load(Ordering::SeqCst) - before;
    assert_eq!(answer["items"], json!(50));
    assert!(reads <= 8, "sharing 50 items by identity made {reads} store reads; the bound is 8");
    println!("share_files of 50 items x 2 forms (by identity): {reads} store reads");
}

#[test]
fn a_missing_file_refuses_the_whole_share_before_anything_is_written() {
    let (mut files, _store, mut asked, _) = footage();
    asked.push(("/Recordings/gone.mp4".to_owned(), BTreeMap::new()));
    assert!(files.share_files(&asked, None, 60).is_err());
    assert_eq!(files.call("list_shares", &json!({})).unwrap().unwrap()["shares"], json!([]), "nothing was written");
}

#[test]
fn a_missing_form_refuses_the_whole_share_before_anything_is_written() {
    let (mut files, _store, mut asked, _) = footage();
    asked[7].1.insert("bad".to_owned(), "/Shared/nowhere.mp4".to_owned());
    assert!(files.share_files(&asked, None, 60).is_err());
    assert_eq!(files.call("list_shares", &json!({})).unwrap().unwrap()["shares"], json!([]));
}
