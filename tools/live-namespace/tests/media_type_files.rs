// tests/media_type_files.rs
//
// Purpose: What type a file is recorded with (src/account_files/media_type.rs): a file that arrives with no type, or as
// application/octet-stream, is recorded with the type its first bytes or its name's ending say; a type the caller states is kept; a
// pieced upload decides from the head its first piece kept; and `retype_files` corrects the records that kept no type, a page at a
// time, touching only those, and changes nothing when it runs again. Synthetic data only.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

mod account_files_common;

use account_files_common::account_files;
use live_namespace::{
    account_files::{AccountFiles, FILES},
    store::{Mutation, Store},
};
use serde_json::json;
use std::sync::Arc;

/// The start of an ISO-BMFF file: a size, `ftyp`, the major brand and a minor version, then some bytes of the body.
fn ftyp(brand: &str) -> Vec<u8> {
    let mut head = vec![0, 0, 0, 0x18];
    head.extend_from_slice(b"ftyp");
    head.extend_from_slice(brand.as_bytes());
    head.extend_from_slice(&[0, 0, 0, 0]);
    head.extend_from_slice(b"mdat camera bytes");
    head
}

/// The media type a file's record kept, by identity.
fn kept_type(files: &AccountFiles, identity: &str) -> String {
    files.store.get(FILES, identity).unwrap().record.unwrap().value["media_type"].as_str().unwrap_or_default().to_owned()
}

/// Write `bytes` under `name` as `media_type`; the identity the write answered.
fn written(files: &mut AccountFiles, name: &str, bytes: &[u8], media_type: &str) -> String {
    let origins = files.origins().unwrap();
    files.write_file(name, bytes, media_type, &origins).unwrap()["identity"].as_str().unwrap().to_owned()
}

/// Set a file record's type to `stored` the way a row kept before this rule was made says it: a store write at the record's version.
fn kept_before_the_rule(files: &AccountFiles, identity: &str, stored: &str) {
    let record = files.store.get(FILES, identity).unwrap().record.unwrap();
    let mut value = record.value.clone();
    value["media_type"] = json!(stored);
    files.store.mutate(FILES, Mutation { id: identity.to_owned(), expected_version: record.version, request_key: format!("kept-before:{identity}:{stored}"), deleted: false, value }).unwrap();
}

#[test]
fn a_nameless_mp4_signature_arriving_as_octet_stream_is_recorded_as_mp4() {
    let (mut files, _, _) = account_files();
    let identity = written(&mut files, "/Camera/clip", &ftyp("isom"), "application/octet-stream");
    assert_eq!(kept_type(&files, &identity), "video/mp4");
}

#[test]
fn a_mov_with_a_quicktime_brand_is_recorded_as_quicktime() {
    let (mut files, _, _) = account_files();
    let identity = written(&mut files, "/Recordings/C9058.MOV", &ftyp("qt  "), "");
    assert_eq!(kept_type(&files, &identity), "video/quicktime");
}

#[test]
fn an_unknown_blob_stays_octet_stream_and_a_type_the_caller_states_is_kept() {
    let (mut files, _, _) = account_files();
    let blob = written(&mut files, "/Blobs/a.qqq", &[0x13, 0x37, 0x00, 0x42, 0x99, 0x01], "application/octet-stream");
    assert_eq!(kept_type(&files, &blob), "application/octet-stream");
    let stated = written(&mut files, "/Notes/clip.txt", &ftyp("isom"), "text/plain");
    assert_eq!(kept_type(&files, &stated), "text/plain", "a stated type is kept whatever the bytes say");
}

#[test]
fn a_pieced_upload_records_the_type_its_first_piece_says() {
    let (mut files, _, _) = account_files();
    let upload = "c".repeat(32);
    let bytes = ftyp("qt  ");
    let name = "/Recordings/piece.MOV";
    files.write_file_start(&upload, name, bytes.len() as u64, "application/octet-stream", None).unwrap();
    files.write_file_piece(&upload, name, 0, &bytes).unwrap();
    let answer = files.write_file_finish(&upload, name).unwrap();
    assert_eq!(kept_type(&files, answer["identity"].as_str().unwrap()), "video/quicktime");
}

#[test]
fn the_backfill_pages_and_resumes_retypes_only_unknown_rows_and_is_idempotent() {
    let (mut files, _, _) = account_files();
    // Rows as they were kept before the rule: their type is unknown, or was never given.
    let camera = written(&mut files, "/Camera/a.bin", &ftyp("isom"), "application/octet-stream");
    kept_before_the_rule(&files, &camera, "application/octet-stream");
    let quicktime = written(&mut files, "/Camera/b", &ftyp("qt  "), "application/octet-stream");
    kept_before_the_rule(&files, &quicktime, "");
    let ending = written(&mut files, "/Camera/C9058.MP4", b"original camera bytes", "application/octet-stream");
    kept_before_the_rule(&files, &ending, "application/octet-stream");
    let blob = written(&mut files, "/Blobs/d.bin", &[0x13, 0x37, 0x00, 0x42], "application/octet-stream");
    kept_before_the_rule(&files, &blob, "application/octet-stream");
    let stated = written(&mut files, "/Notes/f.txt", &ftyp("mp42"), "text/plain");

    let (mut examined, mut retyped, mut unchanged, mut pages) = (0u64, 0u64, 0u64, 0);
    let mut after: Option<String> = None;
    loop {
        let mut input = json!({"limit": 2});
        if let Some(after) = &after {
            input["after"] = json!(after);
        }
        let answer = files.call("retype_files", &input).unwrap().unwrap();
        pages += 1;
        examined += answer["examined"].as_u64().unwrap();
        retyped += answer["retyped"].as_u64().unwrap();
        unchanged += answer["unchanged"].as_u64().unwrap();
        assert!(pages < 20, "the backfill did not finish");
        if answer["done"] == json!(true) {
            break;
        }
        after = answer["next_after"].as_str().map(str::to_owned);
    }
    assert!(pages >= 3, "five rows at two a page take at least three pages, got {pages}");
    assert_eq!((examined, retyped, unchanged), (5, 3, 1), "the stated row is examined and left as it is; the blob stays unknown and counted");
    assert_eq!(kept_type(&files, &camera), "video/mp4");
    assert_eq!(kept_type(&files, &quicktime), "video/quicktime");
    assert_eq!(kept_type(&files, &ending), "video/mp4", "a name's ending decides a file whose bytes say nothing");
    assert_eq!(kept_type(&files, &blob), "application/octet-stream");
    assert_eq!(kept_type(&files, &stated), "text/plain");

    let again = files.call("retype_files", &json!({})).unwrap().unwrap();
    assert_eq!((again["retyped"].as_u64(), again["unchanged"].as_u64()), (Some(0), Some(1)), "a second pass changes nothing");
}

/// The media type a file record kept in `store`, by identity ("" when there is no record).
fn type_in(store: &Store, identity: &str) -> String {
    store.get(FILES, identity).unwrap().record.map_or_else(String::new, |record| record.value["media_type"].as_str().unwrap_or_default().to_owned())
}

#[test]
fn retype_files_stops_at_its_control_and_resumes_from_next_after() {
    let (mut files, _, _) = account_files();
    let camera = written(&mut files, "/Camera/a.bin", &ftyp("isom"), "application/octet-stream");
    kept_before_the_rule(&files, &camera, "application/octet-stream");
    let quicktime = written(&mut files, "/Camera/b", &ftyp("qt  "), "application/octet-stream");
    kept_before_the_rule(&files, &quicktime, "");
    let ending = written(&mut files, "/Camera/C9058.MP4", b"original camera bytes", "application/octet-stream");
    kept_before_the_rule(&files, &ending, "application/octet-stream");
    let blob = written(&mut files, "/Blobs/d.bin", &[0x13, 0x37, 0x00, 0x42], "application/octet-stream");
    kept_before_the_rule(&files, &blob, "application/octet-stream");
    let stated = written(&mut files, "/Notes/f.txt", &ftyp("mp42"), "text/plain");

    // The call's control stops it once two of the three legacy camera rows are retyped, before the next record is touched.
    let store = files.store.clone();
    let legacy = [camera.clone(), quicktime.clone(), ending.clone()];
    let mut files = files.while_current(Arc::new(move || legacy.iter().filter(|id| matches!(type_in(&store, id).as_str(), "video/mp4" | "video/quicktime")).count() < 2));
    let first = files.call("retype_files", &json!({"limit": 10})).unwrap().unwrap();
    assert_eq!((first["stopped"].clone(), first["done"].clone(), first["retyped"].clone()), (json!(true), json!(false), json!(2)), "stopped with two retyped and not done: {first}");
    let resume = first["next_after"].as_str().expect("a stopped call names where to resume").to_owned();

    // Live again: the next call resumes after the last record done, retypes the last legacy row, and finishes.
    let mut files = files.while_current(Arc::new(|| true));
    let second = files.call("retype_files", &json!({"limit": 10, "after": resume})).unwrap().unwrap();
    assert_eq!((second["stopped"].clone(), second["done"].clone(), second["retyped"].clone()), (json!(false), json!(true), json!(1)), "the rest of the rows: {second}");
    assert_eq!(first["examined"].as_u64().unwrap() + second["examined"].as_u64().unwrap(), 5, "every row is examined once across the two calls");
    assert_eq!(kept_type(&files, &camera), "video/mp4");
    assert_eq!(kept_type(&files, &quicktime), "video/quicktime");
    assert_eq!(kept_type(&files, &ending), "video/mp4");
    assert_eq!(kept_type(&files, &blob), "application/octet-stream");
    assert_eq!(kept_type(&files, &stated), "text/plain");
}
