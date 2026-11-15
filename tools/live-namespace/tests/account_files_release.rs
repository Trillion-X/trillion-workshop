// tests/account_files_release.rs
//
// Purpose: Giving back the storage of files deleted for good and retiring temporary names, end to end over the
// account files in memory: the port of old trillion's byte release test (ports/account-files-byte-release.json)
// and test/native-result-cleanup.test.mjs. A set-aside name forgotten for good notes its file; a page of noted files
// turns each file nothing holds into release rows and forgets its records; the release removes each claimed object
// and reports it; an upload of the same bytes cancels an unclaimed release and is sent again while one is claimed or
// just finished. Synthetic data only.

mod account_files_common;

use account_files_common::*;
use serde_json::{json, Value};
use trillion_local::{account_files::{AccountFilesError, FILES, CHUNKS}, records::Records};

fn identity(files: &trillion_local::account_files::AccountFiles<trillion_local::storage::memory::Memory>, name: &str) -> Option<Value> {
    files.find_file(name).ok().map(|file| file["identity"].clone())
}

#[test]
fn a_deleted_file_is_noted_only_when_its_set_aside_name_is_forgotten_and_only_then_gives_back_its_object() {
    let (mut files, held, _) = account_files();
    let one = write(&mut files, "/a.txt", b"first file bytes");
    let two = write(&mut files, "/b.txt", b"second file bytes");
    call(&mut files, "set_aside", json!({"name": "/a.txt"})).unwrap();
    assert!(!files.release_pending().unwrap(), "a name set aside holds its file: nothing is noted");
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["files"], 0);
    let forgot = call(&mut files, "forget_set_aside", json!({"name": "/a.txt"})).unwrap();
    assert_eq!(forgot["noted"], json!([one]));
    assert!(files.release_pending().unwrap());
    assert!(files.release_noted(&one).unwrap());
    let queued = call(&mut files, "queue_release", json!({})).unwrap();
    assert_eq!(queued, json!({"files": 1, "kept": 0, "keys": 1, "kept_chunks": 0, "more": false}));
    assert!(files.find_file(&one).is_err(), "the file's records go at once");
    assert!(keys(&held).contains(&format!("{PREFIX}{one}")), "its object stays until it is removed");
    let done = call(&mut files, "release_gone_bytes", json!({})).unwrap();
    assert_eq!(done, json!({"released": 1, "bytes": 16, "more": false}));
    assert_eq!(keys(&held), vec![format!("{PREFIX}{two}")], "the other file stays");
    assert!(!files.release_pending().unwrap());
    let given = call(&mut files, "list_released", json!({})).unwrap();
    assert_eq!(given["released"][0]["key"], format!("{PREFIX}{one}"));
    assert_eq!(given["released"][0]["byte_length"], 16);
    assert!(given["released"][0]["released_at"].as_u64().is_some(), "what was released, how big and when, stays readable");
    assert!(identity(&files, "/b.txt").is_some());
}

#[test]
fn a_file_still_named_elsewhere_or_set_aside_under_another_name_is_held_and_keeps_its_bytes() {
    let (mut files, held, _) = account_files();
    let shared = write(&mut files, "/kept.txt", b"named twice");
    write(&mut files, "/copy.txt", b"named twice");
    write(&mut files, "/aside.txt", b"named twice");
    call(&mut files, "set_aside", json!({"name": "/copy.txt"})).unwrap();
    call(&mut files, "set_aside", json!({"name": "/aside.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/copy.txt"})).unwrap();
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["kept"], 1, "a live name holds it");
    call(&mut files, "move_names", json!({"from": "/kept.txt", "to": "/elsewhere.txt"})).unwrap();
    call(&mut files, "set_aside", json!({"name": "/elsewhere.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/elsewhere.txt"})).unwrap();
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["kept"], 1, "a name still set aside holds it");
    call(&mut files, "forget_set_aside", json!({"name": "/aside.txt"})).unwrap();
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["files"], 1, "the last name that kept it gone, it goes");
    assert_eq!(files.release_gone_bytes(None).unwrap()["released"], 1);
    assert!(!keys(&held).contains(&format!("{PREFIX}{shared}")));
}

#[test]
fn a_whole_folder_set_aside_is_forgotten_in_bounded_pages_and_resumes() {
    let (mut files, _, _) = account_files();
    for n in 0..3 {
        write(&mut files, &format!("/Old/{n}.txt"), format!("old file {n}").as_bytes());
    }
    call(&mut files, "set_aside", json!({"name": "/Old"})).unwrap();
    let first = call(&mut files, "forget_set_aside", json!({"name": "/Old", "limit": 2})).unwrap();
    assert_eq!(first["names"], 2);
    let next = first["next_after"].as_str().unwrap().to_owned();
    let rest = call(&mut files, "forget_set_aside", json!({"name": "/Old", "after": next})).unwrap();
    assert_eq!((rest["names"].as_u64(), rest["folders"].as_u64(), rest["next_after"].clone()), (Some(1), Some(1), Value::Null));
    assert_eq!(call(&mut files, "list_set_aside", json!({})).unwrap()["folders"], json!([]));
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["files"], 3);
    assert!(matches!(call(&mut files, "forget_set_aside", json!({"name": "/Old"})), Err(AccountFilesError::NotFound(_))));
    assert!(matches!(call(&mut files, "forget_set_aside", json!({"name": "/"})), Err(AccountFilesError::Invalid(_, _))));
}

#[test]
fn a_chunk_another_file_uses_stays_and_only_the_files_own_chunks_go() {
    let (mut files, held, _) = account_files();
    let common: Vec<u8> = (0..32 * 1024).map(|n| (n % 251) as u8).collect();
    let own: Vec<u8> = (0..1000).map(|n| (n % 13) as u8).collect();
    let other_own: Vec<u8> = (0..900).map(|n| (n % 17) as u8).collect();
    upload(&mut files, 'a', "/video-a.bin", &[common.clone(), own.clone()].concat());
    upload(&mut files, 'b', "/video-b.bin", &[common.clone(), other_own].concat());
    let common_id = format!("1f:{}", content_crypto::advanced::blake3::hash(&common).to_hex());
    let own_id = format!("1f:{}", content_crypto::advanced::blake3::hash(&own).to_hex());
    let chunk = files.store.get(ACCOUNT, CHUNKS, &common_id).unwrap().record.unwrap();
    assert_eq!(chunk.value["shared"], true, "the second upload marked the chunk it reused");
    call(&mut files, "set_aside", json!({"name": "/video-a.bin"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/video-a.bin"})).unwrap();
    let queued = call(&mut files, "queue_release", json!({})).unwrap();
    assert_eq!((queued["files"].as_u64(), queued["keys"].as_u64(), queued["kept_chunks"].as_u64()), (Some(1), Some(1), Some(1)));
    files.release_gone_bytes(None).unwrap();
    assert!(!keys(&held).contains(&format!("{PREFIX}{own_id}")));
    assert!(keys(&held).contains(&format!("{PREFIX}{common_id}")), "the shared chunk stays");
    assert!(files.store.get(ACCOUNT, CHUNKS, &own_id).unwrap().record.is_none());
    let b = files.find_file("/video-b.bin").unwrap();
    let length = b["byte_length"].as_u64().unwrap();
    let file = files.store.get(ACCOUNT, FILES, b["identity"].as_str().unwrap()).unwrap().record.unwrap();
    assert_eq!(files.read_range(&file, 0, length).unwrap().len() as u64, length, "the other file still reads whole");
}

#[test]
fn bytes_kept_again_while_their_release_waits_cancel_it_and_once_removal_started_are_sent_again() {
    let (mut files, held, clock) = account_files();
    let one = write(&mut files, "/a.txt", b"bytes wanted again");
    call(&mut files, "set_aside", json!({"name": "/a.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/a.txt"})).unwrap();
    call(&mut files, "queue_release", json!({})).unwrap();
    assert_eq!(write(&mut files, "/again.txt", b"bytes wanted again"), one, "not claimed yet: the release is cancelled");
    assert_eq!(files.claim_release(None).unwrap().len(), 0);
    assert!(keys(&held).contains(&format!("{PREFIX}{one}")));

    let two = write(&mut files, "/b.txt", b"bytes removed under a writer");
    call(&mut files, "set_aside", json!({"name": "/b.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/b.txt"})).unwrap();
    call(&mut files, "queue_release", json!({})).unwrap();
    assert_eq!(files.claim_release(None).unwrap().len(), 1);
    let origins = files.origins().unwrap();
    let refused = files.write_file("/b-again.txt", b"bytes removed under a writer", "text/plain", &origins);
    assert!(matches!(refused, Err(AccountFilesError::Invalid(_, _))), "claimed: it may be removed under the new copy");
    assert!(files.find_file("/b-again.txt").is_err(), "no name points at bytes on their way out");
    files.released(&[(ORIGIN.to_owned(), format!("{PREFIX}{two}"))]).unwrap();
    assert!(files.write_file("/b-again.txt", b"bytes removed under a writer", "text/plain", &origins).is_err(), "removed after the write began");
    clock.later_minutes(10);
    assert_eq!(write(&mut files, "/b-again.txt", b"bytes removed under a writer"), two, "written well after the removal");
}

#[test]
fn a_removal_that_never_reported_back_is_claimed_again_after_its_time_and_a_refused_one_stays_claimed() {
    let (mut files, held, clock) = account_files();
    write(&mut files, "/a.txt", b"a file to give back");
    call(&mut files, "set_aside", json!({"name": "/a.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/a.txt"})).unwrap();
    call(&mut files, "queue_release", json!({})).unwrap();
    assert_eq!(files.claim_release(None).unwrap().len(), 1);
    assert_eq!(files.claim_release(None).unwrap().len(), 0);
    clock.later_minutes(31);
    *held.refuse_removal.lock().unwrap() = true;
    let refused = call(&mut files, "release_gone_bytes", json!({})).unwrap();
    assert_eq!((refused["released"].as_u64(), refused["more"].as_bool()), (Some(0), Some(true)));
    assert!(refused["failed"].is_string());
    assert!(files.release_pending().unwrap(), "the row stays claimed");
    *held.refuse_removal.lock().unwrap() = false;
    assert_eq!(call(&mut files, "release_gone_bytes", json!({})).unwrap()["released"], 0, "inside its claim it waits");
    clock.later_minutes(31);
    assert_eq!(call(&mut files, "release_gone_bytes", json!({})).unwrap()["released"], 1);
    assert!(keys(&held).is_empty());
    assert!(matches!(files.released(&[(String::new(), "k".into())]), Err(AccountFilesError::Invalid(_, _))));
}

#[test]
fn a_store_being_emptied_into_another_holds_its_files() {
    use trillion_local::{account_files::ORIGINS, records::Mutation};
    let (mut files, held, _) = account_files();
    let one = write(&mut files, "/a.txt", b"moving soon");
    let version = files.store.get(ACCOUNT, ORIGINS, ORIGIN).unwrap().record.unwrap().version;
    files.store.mutate(ACCOUNT, ORIGINS, Mutation { id: ORIGIN.into(), expected_version: version, request_key: "drain".into(), deleted: false, value: origin(false) }).unwrap();
    call(&mut files, "set_aside", json!({"name": "/a.txt"})).unwrap();
    call(&mut files, "forget_set_aside", json!({"name": "/a.txt"})).unwrap();
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["kept"], 1);
    assert!(keys(&held).contains(&format!("{PREFIX}{one}")));
}

/// Old trillion test/native-result-cleanup.test.mjs: only the exact temporary name retires, its file is noted, another
/// name keeps the bytes, and a second retirement is a repeat that writes nothing.
#[test]
fn only_the_exact_temporary_name_retires_and_a_name_the_person_kept_holds_the_bytes() {
    let (mut files, held, _) = account_files();
    let name = format!("/Made by tools/Native results/{}.json", "c".repeat(64));
    let kept = write(&mut files, &name, b"{\"result\":1}");
    write(&mut files, "/User kept.json", b"{\"result\":1}");
    let retire = json!({"names": [{"name": name, "expected_identity": kept, "retire": true}]});
    let done = call(&mut files, "retire_names", retire.clone()).unwrap();
    assert_eq!(done["retired"], json!([name]));
    assert!(files.find_file(&name).is_err());
    assert_eq!(identity(&files, "/User kept.json"), Some(json!(kept)));
    assert_eq!(call(&mut files, "list_set_aside", json!({})).unwrap()["names"], json!([]), "nothing waits set aside");
    assert!(files.release_noted(&kept).unwrap());
    assert_eq!(call(&mut files, "queue_release", json!({})).unwrap()["kept"], 1, "the person's name holds the bytes");
    assert_eq!(call(&mut files, "retire_names", retire).unwrap()["repeated"], json!([name]));
    assert!(keys(&held).contains(&format!("{PREFIX}{kept}")));
}

#[test]
fn a_changed_name_a_folder_or_a_malformed_list_refuses_without_touching_any_name() {
    let (mut files, _, _) = account_files();
    let name = "/Made by tools/temp.json";
    let other = write(&mut files, name, b"other bytes");
    let expected = format!("1f:{}", "a".repeat(64));
    let conflict = call(&mut files, "retire_names", json!({"names": [{"name": name, "expected_identity": expected, "retire": true}]})).unwrap();
    assert_eq!(conflict["conflicts"][0]["current_identity"], json!(other));
    assert_eq!(identity(&files, name), Some(json!(other)));
    write(&mut files, "/folder/child.json", b"child");
    let folder = call(&mut files, "retire_names", json!({"names": [{"name": "/folder", "expected_identity": other, "retire": true}]})).unwrap();
    assert_eq!(folder["conflicts"].as_array().unwrap().len(), 1);
    assert!(files.find_file("/folder/child.json").is_ok());
    for refused in [
        json!({"names": []}),
        json!({"names": [{"name": name, "expected_identity": other}]}),
        json!({"names": [{"name": "/", "expected_identity": other, "retire": true}]}),
        json!({"names": [{"name": name, "expected_identity": "12:".to_owned() + &"a".repeat(64), "retire": true}]}),
        json!({"names": [{"name": name, "expected_identity": other, "retire": true}, {"name": name, "expected_identity": other, "retire": true}]}),
    ] {
        assert!(matches!(call(&mut files, "retire_names", refused.clone()), Err(AccountFilesError::Invalid(_, _))), "{refused}");
    }
    assert_eq!(identity(&files, name), Some(json!(other)));
}

#[test]
fn an_unheld_temporary_copy_reaches_the_bounded_release_queue() {
    let (mut files, held, _) = account_files();
    let name = "/Made by tools/transport.json";
    let kept = write(&mut files, name, b"transport copy");
    call(&mut files, "retire_names", json!({"names": [{"name": name, "expected_identity": kept, "retire": true}]})).unwrap();
    assert_eq!(call(&mut files, "queue_release", json!({"limit": 1})).unwrap()["files"], 1);
    let claimed = files.claim_release(Some(10)).unwrap();
    assert_eq!(claimed[0]["key"], format!("{PREFIX}{kept}"));
    assert!(files.find_file(&kept).is_err());
    assert!(keys(&held).contains(&format!("{PREFIX}{kept}")), "claimed, not removed yet");
}
