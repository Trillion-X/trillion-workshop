// tests/share_round_trips.rs
//
// Purpose: The store operations one tool call makes through the real names stack: AccountFiles over RowsByCalls, every call answered
// by the names side (`by_calls::answer`) over an in-memory SqlStore, and each call delayed by a fixed wait so the count shows as time.
// The calls go through `AccountFiles::call`, the entry the MCP route uses. Each test counts calls per operation and must not grow with
// the number of identities a call names. Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::account_files_over;
use live_namespace::{
    account_files::AccountFiles,
    store::{by_calls::{answer, RowsByCalls}, SqlStore, Store},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

const WAIT: Duration = Duration::from_millis(50);

type Log = Arc<Mutex<Vec<String>>>;

fn stack() -> (AccountFiles, Log) {
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let server = Arc::new(SqlStore::memory().unwrap());
    let seen = log.clone();
    let send = move |operation: &str, arguments: &Value, _wait: Duration| -> Result<Value, live_namespace::store::Error> {
        seen.lock().unwrap().push(operation.to_owned());
        std::thread::sleep(WAIT);
        Ok(answer(&*server, operation, arguments))
    };
    let store: Store = Arc::new(RowsByCalls::new(Box::new(send)));
    let (files, _, _) = account_files_over(store);
    (files, log)
}

type Items = Vec<(String, BTreeMap<String, String>)>;

/// `clips` clips, each written with a play copy and a poster: the identities of the clips, and the share items of them.
fn footage(clips: usize) -> (AccountFiles, Log, Vec<String>, Items) {
    let (mut files, log) = stack();
    let origins = files.origins().unwrap();
    let (mut identities, mut items) = (Vec::new(), Vec::new());
    for n in 0..clips {
        let clip = format!("/Recordings/clip-{n:02}.mp4");
        let play = format!("/Shared/previews/clip-{n:02} 1080p.mp4");
        let poster = format!("/Shared/previews/clip-{n:02}.jpg");
        let mut made = |name: &str, media_type: &str| files.write_file(name, format!("bytes of {name}").as_bytes(), media_type, &origins).unwrap()["identity"].as_str().unwrap().to_owned();
        let identity = made(&clip, "video/mp4");
        let forms = BTreeMap::from([("play".to_owned(), made(&play, "video/mp4")), ("poster".to_owned(), made(&poster, "image/jpeg"))]);
        identities.push(identity.clone());
        items.push((identity, forms));
    }
    (files.with_share_origin("https://shares.example.test"), log, identities, items)
}

fn tally(log: &Log) -> (usize, BTreeMap<String, usize>) {
    let mut counts = BTreeMap::new();
    let calls = log.lock().unwrap().drain(..).inspect(|op| *counts.entry(op.clone()).or_insert(0) += 1).count();
    (calls, counts)
}

#[test]
fn share_file_by_identity_with_forms_makes_the_same_calls_for_three_items_as_for_twenty() {
    let mut totals = Vec::new();
    for clips in [3usize, 20] {
        let (mut files, log, _, items) = footage(clips);
        let input = json!({"seconds": 3600, "title": "Footage", "items": items.iter().map(|(identity, forms)| json!({"name_or_identity": identity, "forms": forms})).collect::<Vec<_>>()});
        log.lock().unwrap().clear();
        let started = std::time::Instant::now();
        let answer = files.call("share_file", &input).unwrap().unwrap();
        let (calls, counts) = tally(&log);
        println!("share_file by identity, {clips} items x 2 forms: {calls} calls in {:?}: {counts:?}", started.elapsed());
        assert_eq!(answer["items"], json!(clips));
        totals.push(calls);
    }
    assert!(totals[1] <= totals[0] + 1, "share_file calls grow with items: {totals:?}");
}

#[test]
fn share_file_of_one_file_repeated_makes_the_same_calls_as_one_item() {
    let (mut files, log, identities, _) = footage(1);
    let items: Vec<Value> = std::iter::repeat_n(json!({"name_or_identity": identities[0]}), 20).collect();
    log.lock().unwrap().clear();
    let started = std::time::Instant::now();
    files.call("share_file", &json!({"seconds": 3600, "items": items})).unwrap().unwrap();
    let (calls, counts) = tally(&log);
    println!("share_file of one identity x 20: {calls} calls in {:?}: {counts:?}", started.elapsed());
    assert!(calls <= 4, "one file named 20 times made {calls} calls: {counts:?}");
}

#[test]
fn read_file_results_many_makes_the_same_calls_for_one_identity_as_for_sixty() {
    let (mut files, log, identities, _) = footage(60);
    for identity in &identities {
        files.call("merge_file_result", &json!({"identity": identity, "kind": "transcript", "value": {"text": "words"}})).unwrap().unwrap();
    }
    let mut totals = Vec::new();
    for count in [1usize, 60] {
        log.lock().unwrap().clear();
        let started = std::time::Instant::now();
        let answer = files.call("read_file_results_many", &json!({"kind": "transcript", "identities": &identities[..count]})).unwrap().unwrap();
        let (calls, counts) = tally(&log);
        println!("read_file_results_many, {count} identities: {calls} calls in {:?}: {counts:?}", started.elapsed());
        assert_eq!(answer["results"].as_object().unwrap().len(), count);
        totals.push(calls);
    }
    assert!(totals[1] <= totals[0] + 1, "read_file_results_many calls grow with identities: {totals:?}");
}
