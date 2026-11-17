// tests/account_files_folder.rs
//
// Purpose: What a native folder on a device asks of the person's files (account-files-routes.json `_folder`), over rows in SQLite and in
// a real Postgres server: the change feed after a cursor with its wait, stable items across a rename, a move and Recently Deleted, the
// compare-and-set of every write by the version read, pin rules, and thumbnails. Synthetic data only.

mod account_files_common;
mod rows_in_both;

use account_files_common::{origin, Held, Port, ACCOUNT, ORIGIN};
use live_namespace::{
    account_files::{AccountFiles, AccountFilesError, ORIGINS},
    store::{Error, Mutation, SqlStore, Store},
};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// Account files over `store` with one loopback stand-in byte store.
fn files_over(store: SqlStore) -> (AccountFiles, Store) {
    let store: Store = Arc::new(store);
    store.mutate(ORIGINS, Mutation { id: ORIGIN.into(), expected_version: 0, request_key: "origin".into(), deleted: false, value: origin(true) }).unwrap();
    let files = AccountFiles::with_objects(store.clone(), ACCOUNT, Box::new(Port(Arc::new(Held::default()))));
    (files, store)
}

/// The account files over each database.
fn both() -> Vec<(&'static str, AccountFiles, Store)> {
    rows_in_both::both().into_iter().map(|(database, store)| {
        let (files, rows) = files_over(store);
        (database, files, rows)
    }).collect()
}

fn call(files: &mut AccountFiles, tool: &str, input: Value) -> Result<Value, AccountFilesError> {
    files.call(tool, &input).expect("an account files tool")
}

fn conflict(answer: Result<Value, AccountFilesError>) -> bool {
    matches!(answer, Err(AccountFilesError::Records(Error::Conflict(_), _)))
}

/// The one name row `list_files` answers for `name`.
fn listed(files: &mut AccountFiles, name: &str) -> Value {
    let folder = name.rsplit_once('/').map(|(folder, _)| if folder.is_empty() { "/" } else { folder }).unwrap();
    let page = call(files, "list_files", json!({ "folder": folder })).unwrap();
    page["names"].as_array().unwrap().iter().find(|row| row["name"] == name).cloned().unwrap_or_else(|| panic!("{name} in {page}"))
}

fn changes_after(files: &mut AccountFiles, cursor: &str) -> (Vec<Value>, String) {
    let answer = call(files, "list_changes", json!({ "after": cursor })).unwrap();
    (answer["changes"].as_array().unwrap().clone(), answer["next"].as_str().unwrap().to_owned())
}

#[test]
fn the_feed_starts_at_now_and_answers_a_write_a_rename_and_recently_deleted_by_item_in_order() {
    for (database, mut files, _) in both() {
        let start = call(&mut files, "list_changes", json!({})).unwrap();
        assert_eq!(start["changes"], json!([]), "{database}: no cursor, no changes");
        let cursor = start["next"].as_str().unwrap().to_owned();

        call(&mut files, "write_file", json!({ "name": "/Notes/a.txt", "text": "one" })).unwrap();
        let (changes, cursor) = changes_after(&mut files, &cursor);
        let ops: Vec<(String, String, String)> = changes.iter().map(|change| (change["op"].as_str().unwrap().into(), change["kind"].as_str().unwrap().into(), change["name"].as_str().unwrap_or_default().into())).collect();
        assert_eq!(ops, [("put".into(), "name".into(), "/Notes/a.txt".into()), ("put".into(), "folder".into(), "/Notes".into())], "{database}");
        let item = changes[0]["item"].as_str().unwrap().to_owned();
        let generation = changes[0]["generation"].as_i64().unwrap();
        assert_eq!(listed(&mut files, "/Notes/a.txt")["item"], item.as_str(), "{database}: list_files and the feed name one item");

        // A rename is one put of the same item, never a remove.
        call(&mut files, "move_names", json!({ "from": "/Notes/a.txt", "to": "/Notes/b.txt" })).unwrap();
        let (changes, cursor) = changes_after(&mut files, &cursor);
        assert_eq!(changes.len(), 1, "{database}: {changes:?}");
        assert_eq!((changes[0]["op"].as_str(), changes[0]["name"].as_str(), changes[0]["item"].as_str()), (Some("put"), Some("/Notes/b.txt"), Some(item.as_str())), "{database}");
        assert!(changes[0]["generation"].as_i64().unwrap() > generation, "{database}: the generation grows across a rename");

        // New bytes under the same name keep the item; the identity is the content version.
        let before = listed(&mut files, "/Notes/b.txt");
        call(&mut files, "write_file", json!({ "name": "/Notes/b.txt", "text": "two" })).unwrap();
        let after = listed(&mut files, "/Notes/b.txt");
        assert_eq!(after["item"], before["item"], "{database}");
        assert_ne!(after["identity"], before["identity"], "{database}");
        let (_, cursor) = changes_after(&mut files, &cursor);

        // Recently Deleted: the item is in no live name, so it is removed; putting it back puts the same item.
        call(&mut files, "set_aside", json!({ "name": "/Notes/b.txt" })).unwrap();
        let (changes, cursor) = changes_after(&mut files, &cursor);
        assert_eq!(changes, [json!({ "op": "remove", "item": item, "generation": changes[0]["generation"] })], "{database}");
        call(&mut files, "put_back", json!({ "name": "/Notes/b.txt" })).unwrap();
        let (changes, _) = changes_after(&mut files, &cursor);
        assert_eq!((changes[0]["op"].as_str(), changes[0]["item"].as_str()), (Some("put"), Some(item.as_str())), "{database}");
        let shown = call(&mut files, "show_item", json!({ "item": item })).unwrap();
        assert_eq!(shown["name"], "/Notes/b.txt", "{database}");
    }
}

#[test]
fn a_copy_gets_its_own_item_and_a_moved_folder_keeps_its_item_and_its_names_items() {
    for (database, mut files, _) in both() {
        call(&mut files, "write_file", json!({ "name": "/Work/Draft/a.txt", "text": "a" })).unwrap();
        call(&mut files, "copy_names", json!({ "from": "/Work/Draft/a.txt", "to": "/Work/Draft/copy.txt" })).unwrap();
        let (original, copy) = (listed(&mut files, "/Work/Draft/a.txt"), listed(&mut files, "/Work/Draft/copy.txt"));
        assert_ne!(original["item"], copy["item"], "{database}: a copy is a new item");
        let folder_item = call(&mut files, "list_files", json!({ "folder": "/Work" })).unwrap()["folder_items"]["/Work/Draft"]["item"].clone();
        assert!(folder_item.is_string(), "{database}");

        call(&mut files, "move_names", json!({ "from": "/Work/Draft", "to": "/Work/Final" })).unwrap();
        let moved = call(&mut files, "list_files", json!({ "folder": "/Work" })).unwrap();
        assert_eq!(moved["folders"], json!(["/Work/Final"]), "{database}");
        assert_eq!(moved["folder_items"]["/Work/Final"]["item"], folder_item, "{database}: the folder kept its item");
        assert_eq!(listed(&mut files, "/Work/Final/a.txt")["item"], original["item"], "{database}");
        assert_eq!(call(&mut files, "show_item", json!({ "item": folder_item })).unwrap()["name"], "/Work/Final", "{database}");
        assert!(matches!(call(&mut files, "show_item", json!({ "item": "999999" })), Err(AccountFilesError::NotFound(_))), "{database}");
    }
}

#[test]
fn every_write_and_move_is_made_only_at_the_version_the_caller_read() {
    for (database, mut files, _) in both() {
        assert!(conflict(call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "x", "expected_version": 3 }))), "{database}: a name that is not there is not version 3");
        call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "one", "expected_version": 0 })).unwrap();
        assert!(conflict(call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "two", "expected_version": 0 }))), "{database}: 0 means not there");
        let version = listed(&mut files, "/a.txt")["version"].as_i64().unwrap();
        call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "two", "expected_version": version })).unwrap();
        assert!(conflict(call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "three", "expected_version": version }))), "{database}: the other device's save is not lost");
        assert_eq!(call(&mut files, "read_file", json!({ "name_or_identity": "/a.txt" })).unwrap()["content"], "two", "{database}");

        // A large write: the start checks the version, and the finish writes at the version the start kept.
        let current = listed(&mut files, "/a.txt")["version"].as_i64().unwrap();
        let upload = "0123456789abcdef0123456789abcdef";
        assert!(conflict(call(&mut files, "write_file_start", json!({ "upload_id": upload, "name": "/a.txt", "byte_length": 4, "expected_version": current - 1 }))), "{database}");
        call(&mut files, "write_file_start", json!({ "upload_id": upload, "name": "/a.txt", "byte_length": 4, "expected_version": current })).unwrap();
        call(&mut files, "write_file_piece", json!({ "upload_id": upload, "name": "/a.txt", "offset": 0, "content_base64": "Zm91cg==" })).unwrap();
        call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "meanwhile" })).unwrap();
        assert!(call(&mut files, "write_file_finish", json!({ "upload_id": upload, "name": "/a.txt" })).is_err(), "{database}: changed while uploading");
        assert_eq!(call(&mut files, "read_file", json!({ "name_or_identity": "/a.txt" })).unwrap()["content"], "meanwhile", "{database}");

        // A move, a set-aside and a put-back: refused at another version, nothing of the name changed.
        let version = listed(&mut files, "/a.txt")["version"].as_i64().unwrap();
        assert!(conflict(call(&mut files, "move_names", json!({ "from": "/a.txt", "to": "/b.txt", "expected_version": version + 1 }))), "{database}");
        assert!(conflict(call(&mut files, "set_aside", json!({ "name": "/a.txt", "expected_version": version + 1 }))), "{database}");
        assert_eq!(listed(&mut files, "/a.txt")["version"], version, "{database}");
        call(&mut files, "move_names", json!({ "from": "/a.txt", "to": "/b.txt", "expected_version": version })).unwrap();
        let moved = listed(&mut files, "/b.txt")["version"].as_i64().unwrap();
        call(&mut files, "set_aside", json!({ "name": "/b.txt", "expected_version": moved })).unwrap();
        let aside = call(&mut files, "list_set_aside", json!({ "folder": "/" })).unwrap()["names"][0]["version"].as_i64().unwrap();
        assert!(conflict(call(&mut files, "put_back", json!({ "name": "/b.txt", "expected_version": aside + 1 }))), "{database}");
        call(&mut files, "put_back", json!({ "name": "/b.txt", "expected_version": aside })).unwrap();
    }
}

#[test]
fn a_wait_holds_until_another_writer_changes_a_name_and_ends_at_the_calls_time_when_none_does() {
    for (database, files, store) in both() {
        let cursor = files.store.order().unwrap().to_string();
        let started = Instant::now();
        let waiting = files.until(started + Duration::from_millis(300));
        let quiet = waiting.list_changes(Some(&cursor), None, true, None).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(300) && quiet["changes"] == json!([]), "{database}");

        let mut writer = AccountFiles::with_objects(store.clone(), ACCOUNT, Box::new(Port(Arc::new(Held::default()))));
        let wrote = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            writer.call("write_file", &json!({ "name": "/late.txt", "text": "late" })).unwrap().unwrap();
        });
        let started = Instant::now();
        let waiting = waiting.until(started + Duration::from_secs(60));
        let heard = waiting.list_changes(Some(&cursor), None, true, None).unwrap();
        wrote.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(30), "{database}: woken by the write");
        assert_eq!(heard["changes"][0]["name"], "/late.txt", "{database}");
    }
}

#[test]
fn a_pin_rule_of_a_device_keeps_its_items_and_everything_under_a_pinned_folder_through_renames() {
    for (database, mut files, _) in both() {
        call(&mut files, "write_file", json!({ "name": "/Clips/a.mp4", "text": "a" })).unwrap();
        call(&mut files, "write_file", json!({ "name": "/Clips/b.mp4", "text": "b" })).unwrap();
        call(&mut files, "write_file", json!({ "name": "/Project/Footage/c.mp4", "text": "c" })).unwrap();
        let item = listed(&mut files, "/Clips/a.mp4")["item"].as_str().unwrap().to_owned();
        let project = call(&mut files, "list_files", json!({ "folder": "/" })).unwrap()["folder_items"]["/Project"]["item"].as_str().unwrap().to_owned();
        assert!(matches!(
            call(&mut files, "set_pin_rule", json!({ "id": "bad", "device": "laptop", "items": ["/Clips/a.mp4"], "expected_version": 0 })),
            Err(AccountFilesError::Invalid(..))
        ), "{database}: a pin names items, never names");
        let kept = call(&mut files, "set_pin_rule", json!({ "id": "keep", "device": "laptop", "items": [item, project], "label": "for the edit", "expected_version": 0 })).unwrap();
        assert_eq!(kept["version"], 1, "{database}");
        assert!(conflict(call(&mut files, "set_pin_rule", json!({ "id": "keep", "device": "laptop", "items": [item], "expected_version": 0 }))), "{database}");

        let page = call(&mut files, "list_files", json!({ "folder": "/Clips", "device": "laptop" })).unwrap();
        let marks: Vec<(&str, bool)> = page["names"].as_array().unwrap().iter().map(|row| (row["name"].as_str().unwrap(), row["kept"].as_bool().unwrap())).collect();
        assert_eq!(marks, [("/Clips/a.mp4", true), ("/Clips/b.mp4", false)], "{database}");
        assert_eq!(listed_kept(&mut files, "/Project/Footage", "/Project/Footage/c.mp4"), Some(true), "{database}: under a pinned folder");
        let other = call(&mut files, "list_files", json!({ "folder": "/Clips", "device": "phone" })).unwrap();
        assert!(other["names"].as_array().unwrap().iter().all(|row| row["kept"] == false), "{database}: another device keeps nothing");
        assert!(call(&mut files, "list_files", json!({ "folder": "/Clips" })).unwrap()["names"][0].get("kept").is_none(), "{database}");

        let cursor = call(&mut files, "list_changes", json!({})).unwrap()["next"].as_str().unwrap().to_owned();
        call(&mut files, "move_names", json!({ "from": "/Clips/a.mp4", "to": "/Clips/renamed.mp4" })).unwrap();
        call(&mut files, "move_names", json!({ "from": "/Project", "to": "/Edit" })).unwrap();
        let changes = call(&mut files, "list_changes", json!({ "after": cursor, "device": "laptop" })).unwrap();
        let kept: Vec<(&str, bool)> = changes["changes"].as_array().unwrap().iter().filter(|change| change["kind"] == "name").map(|change| (change["name"].as_str().unwrap(), change["kept"].as_bool().unwrap())).collect();
        assert_eq!(kept, [("/Clips/renamed.mp4", true), ("/Edit/Footage/c.mp4", true)], "{database}: the pins follow their items");

        let rules = call(&mut files, "list_pin_rules", json!({ "device": "laptop" })).unwrap();
        assert_eq!(rules["rules"].as_array().unwrap().len(), 1, "{database}");
        assert!(call(&mut files, "list_pin_rules", json!({ "device": "phone" })).unwrap()["rules"].as_array().unwrap().is_empty(), "{database}");
        call(&mut files, "remove_pin_rule", json!({ "id": "keep", "expected_version": 1 })).unwrap();
        assert_eq!(listed_kept(&mut files, "/Clips", "/Clips/renamed.mp4"), Some(false), "{database}");
    }
}

fn listed_kept(files: &mut AccountFiles, folder: &str, name: &str) -> Option<bool> {
    let page = call(files, "list_files", json!({ "folder": folder, "device": "laptop" })).unwrap();
    page["names"].as_array().unwrap().iter().find(|row| row["name"] == name).and_then(|row| row["kept"].as_bool())
}

/// A picture made by the declared thumbnail program itself.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let made = std::process::Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", &format!("color=red:size={width}x{height}"), "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"])
        .output()
        .expect("ffmpeg, the thumbnail program the routes DATA declares, is on this computer");
    assert!(made.status.success());
    made.stdout
}

/// The width and height a PNG's header says.
fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    (u32::from_be_bytes(bytes[16..20].try_into().unwrap()), u32::from_be_bytes(bytes[20..24].try_into().unwrap()))
}

#[test]
fn a_thumbnail_is_made_once_by_reading_the_file_by_range_and_kept_under_its_identity() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    for (database, mut files, _) in both() {
        let origins = files.origins().unwrap();
        let wrote = files.write_file("/Pictures/wide.png", &picture(64, 32), "image/png", &origins).unwrap();
        let mut timed = files.until(Instant::now() + Duration::from_secs(60));
        let made = call(&mut timed, "thumbnail", json!({ "name_or_identity": "/Pictures/wide.png", "size": 16 })).unwrap();
        assert_eq!((made["identity"].clone(), made["media_type"].as_str()), (wrote["identity"].clone(), Some("image/png")), "{database}");
        let bytes = STANDARD.decode(made["content_base64"].as_str().unwrap()).unwrap();
        assert_eq!(png_size(&bytes), (16, 8), "{database}: at most the size asked on the longer edge, its shape kept");

        let kept = call(&mut timed, "read_file_results", json!({ "identity": wrote["identity"], "kind": "thumbnail" })).unwrap();
        assert_eq!(kept["results"][0]["value"]["size_16"], made["content_base64"], "{database}: kept as the file's result");
        let again = call(&mut timed, "thumbnail", json!({ "name_or_identity": wrote["identity"], "size": 16 })).unwrap();
        assert_eq!(again["content_base64"], made["content_base64"], "{database}");

        call(&mut timed, "write_file", json!({ "name": "/notes.txt", "text": "words" })).unwrap();
        let none = call(&mut timed, "thumbnail", json!({ "name_or_identity": "/notes.txt", "size": 16 })).unwrap();
        assert_eq!((none["thumbnail"].clone(), none["reason"].is_string()), (Value::Null, true), "{database}: no maker takes text");
        assert!(matches!(call(&mut timed, "thumbnail", json!({ "name_or_identity": "/notes.txt", "size": 0 })), Err(AccountFilesError::Invalid(..))), "{database}");
    }
}

#[test]
fn make_folder_makes_one_folder_in_a_folder_that_exists_only_when_nothing_is_at_that_name() {
    for (database, mut files, _) in both() {
        let made = call(&mut files, "make_folder", json!({ "name": "/Projects", "expected_version": 0 })).unwrap();
        assert_eq!((made["kind"].as_str(), made["name"].as_str(), made["version"].as_i64()), (Some("folder"), Some("/Projects"), Some(1)), "{database}");
        assert!(made["item"].is_string(), "{database}");
        let listed = call(&mut files, "list_files", json!({ "folder": "/" })).unwrap();
        assert_eq!(listed["folder_items"]["/Projects"]["item"], made["item"], "{database}");
        assert!(conflict(call(&mut files, "make_folder", json!({ "name": "/Projects", "expected_version": 0 }))), "{database}: already there");
        call(&mut files, "write_file", json!({ "name": "/notes.txt", "text": "n" })).unwrap();
        assert!(conflict(call(&mut files, "make_folder", json!({ "name": "/notes.txt", "expected_version": 0 }))), "{database}: a name is there");
        assert!(matches!(call(&mut files, "make_folder", json!({ "name": "/Missing/Child", "expected_version": 0 })), Err(AccountFilesError::NotFound(_))), "{database}: no folder above");
        call(&mut files, "make_folder", json!({ "name": "/Projects/2026", "expected_version": 0 })).unwrap();
        // A folder set aside and made again is a new folder with its own item.
        call(&mut files, "set_aside", json!({ "name": "/Projects/2026" })).unwrap();
        let again = call(&mut files, "make_folder", json!({ "name": "/Projects/2026", "expected_version": 0 })).unwrap();
        assert_ne!(again["item"], made["item"], "{database}");
    }
}

#[test]
fn bounds_answers_the_numbers_a_caller_sizes_its_calls_by() {
    for (database, mut files, _) in both() {
        let bounds = call(&mut files, "bounds", json!({})).unwrap();
        for field in ["list_default", "list_most", "read_most", "span_most", "chunk_bytes", "write_most", "piece_most", "idle_seconds"] {
            assert!(bounds[field].as_u64().is_some_and(|number| number > 0), "{database}: {field} in {bounds}");
        }
        assert!(bounds["list_default"].as_u64() <= bounds["list_most"].as_u64() && bounds["read_most"].as_u64() <= bounds["span_most"].as_u64(), "{database}");
        // The span bound is what a read of a span is held to.
        let too_long = bounds["span_most"].as_u64().unwrap() + 1;
        call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "a" })).unwrap();
        assert!(call(&mut files, "read_file_span", json!({ "name_or_identity": "/a.txt", "offset": 0, "length": too_long })).is_err(), "{database}");
    }
}

#[test]
fn a_write_answers_the_item_and_version_of_the_name_it_wrote() {
    for (database, mut files, _) in both() {
        let wrote = call(&mut files, "write_file", json!({ "name": "/a.txt", "text": "one" })).unwrap();
        let row = listed(&mut files, "/a.txt");
        assert_eq!((wrote["item"].clone(), wrote["version"].clone(), wrote["generation"].clone()), (row["item"].clone(), row["version"].clone(), row["generation"].clone()), "{database}");
        let upload = "0123456789abcdef0123456789abcdef";
        call(&mut files, "write_file_start", json!({ "upload_id": upload, "name": "/a.txt", "byte_length": 4, "expected_version": row["version"] })).unwrap();
        call(&mut files, "write_file_piece", json!({ "upload_id": upload, "name": "/a.txt", "offset": 0, "content_base64": "Zm91cg==" })).unwrap();
        let finished = call(&mut files, "write_file_finish", json!({ "upload_id": upload, "name": "/a.txt" })).unwrap();
        let after = listed(&mut files, "/a.txt");
        assert_eq!(finished["item"], row["item"], "{database}: new bytes under the same name keep the item");
        assert_eq!((finished["version"].clone(), finished["generation"].clone()), (after["version"].clone(), after["generation"].clone()), "{database}");
        let again = call(&mut files, "write_file_finish", json!({ "upload_id": upload, "name": "/a.txt" })).unwrap();
        assert_eq!(again["item"], row["item"], "{database}: a finish asked again answers the item too");
    }
}

#[test]
fn a_raw_span_is_written_as_a_file_of_exactly_its_bytes_and_the_answer_names_it_never_holding_them() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use live_namespace::account_files::CallControl;
    for (database, files, _) in both() {
        let folder = tempfile::tempdir().unwrap();
        let mut files = files.with_control(CallControl::default().with_byte_results(folder.path().to_path_buf(), "byte-results", Arc::new(|_: &Value| {})));
        call(&mut files, "write_file", json!({ "name": "/clip.bin", "content_base64": STANDARD.encode((0u8..=255).collect::<Vec<_>>()) })).unwrap();
        let answer = call(&mut files, "read_file_span", json!({ "name_or_identity": "/clip.bin", "offset": 10, "length": 100, "raw": true })).unwrap();
        let named = &answer["bytes"];
        assert_eq!((named["total"].clone(), named["offset"].clone(), named["length"].clone()), (json!(256), json!(10), json!(100)), "{database}");
        assert_eq!(named["identity"], answer["identity"], "{database}: the bytes name the version they are of");
        assert!(answer.get("content").is_none(), "{database}: the bytes are never in the answer");
        let written = std::fs::read(folder.path().join(named["file"].as_str().unwrap())).unwrap();
        assert_eq!(written, (10u8..110).collect::<Vec<_>>(), "{database}: the file is exactly the span");
        assert!(named["file"].as_str().unwrap().starts_with("byte-results/"), "{database}");
        // Without a folder for its bytes a raw span is refused; raw false is the span in the answer.
        let (mut plain, _) = files_over(rows_in_both::both().remove(0).1);
        call(&mut plain, "write_file", json!({ "name": "/clip.bin", "text": "abc" })).unwrap();
        assert!(call(&mut plain, "read_file_span", json!({ "name_or_identity": "/clip.bin", "offset": 0, "length": 3, "raw": true })).is_err());
        assert_eq!(call(&mut plain, "read_file_span", json!({ "name_or_identity": "/clip.bin", "offset": 0, "length": 3, "raw": false })).unwrap()["content"], STANDARD.encode("abc"));
    }
}

#[test]
fn a_piece_sent_raw_is_read_from_the_file_the_engine_put_in_the_run_folder_and_the_file_is_removed() {
    use live_namespace::account_files::CallControl;
    for (database, files, _) in both() {
        let folder = tempfile::tempdir().unwrap();
        let mut files = files.with_control(CallControl::default().with_byte_results(folder.path().to_path_buf(), "byte-results", Arc::new(|_: &Value| {})));
        let upload = "0123456789abcdef0123456789abcdef";
        call(&mut files, "write_file_start", json!({ "upload_id": upload, "name": "/raw.txt", "byte_length": 4 })).unwrap();
        std::fs::create_dir_all(folder.path().join("byte-uploads")).unwrap();
        std::fs::write(folder.path().join("byte-uploads/1"), b"four").unwrap();
        let piece = json!({ "upload_id": upload, "name": "/raw.txt", "offset": 0, "content_file": { "path": "byte-uploads/1", "length": 4 } });
        call(&mut files, "write_file_piece", piece).unwrap();
        assert!(!folder.path().join("byte-uploads/1").exists(), "{database}: the piece's file is removed once read");
        call(&mut files, "write_file_finish", json!({ "upload_id": upload, "name": "/raw.txt" })).unwrap();
        assert_eq!(call(&mut files, "read_file", json!({ "name_or_identity": "/raw.txt" })).unwrap()["content"], "four", "{database}");
        // Exactly one of content_base64 and content_file.
        let both_ways = json!({ "upload_id": upload, "name": "/raw.txt", "offset": 0, "content_base64": "Zm91cg==", "content_file": { "path": "byte-uploads/1", "length": 4 } });
        assert!(call(&mut files, "write_file_piece", both_ways).is_err(), "{database}");
        // Without the run's own folder a content_file piece is refused.
        let (mut plain, _) = files_over(rows_in_both::both().remove(0).1);
        call(&mut plain, "write_file_start", json!({ "upload_id": upload, "name": "/raw.txt", "byte_length": 4 })).unwrap();
        assert!(call(&mut plain, "write_file_piece", json!({ "upload_id": upload, "name": "/raw.txt", "offset": 0, "content_file": { "path": "byte-uploads/1", "length": 4 } })).is_err(), "{database}");
    }
}
