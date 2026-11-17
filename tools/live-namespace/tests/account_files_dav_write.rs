// tests/account_files_dav_write.rs
//
// Purpose: The writable half of the person's WebDAV folder (src/account_files/dav_write.rs), answered by the account
// files over a record store in memory: PUT a new and a replaced file (read back by GET), the entity-tag
// preconditions, MKCOL and its conflicts, DELETE as a set-aside that put_back recovers, MOVE and COPY of names and
// folders with Overwrite, and the `dav_write` operation as the door's /dav route calls it. The sign-in and its route
// are tested in src/mcp/carried.rs. Synthetic data only.

mod account_files_common;

use account_files_common::*;
use live_namespace::account_files::{
    dav::{Request, Response},
    dav_write::WriteRequest,
    AccountFiles,
};
use live_namespace::storage::memory::Memory;

fn read(files: &AccountFiles<Memory>, method: &str, path: &str) -> Response {
    files.dav("/dav", &Request { method, path, depth: Some("1"), range: None }).unwrap()
}

fn put(files: &mut AccountFiles<Memory>, path: &str, body: &[u8]) -> Response {
    files.dav_write("/dav", &WriteRequest { method: "PUT", path, body, content_type: Some("text/plain"), ..Default::default() }).unwrap()
}

fn carry(files: &mut AccountFiles<Memory>, method: &str, path: &str, destination: &str, overwrite: Option<&str>) -> Response {
    files.dav_write("/dav", &WriteRequest { method, path, destination: Some(destination), overwrite, ..Default::default() }).unwrap()
}

fn write_method(files: &mut AccountFiles<Memory>, method: &str, path: &str) -> Response {
    files.dav_write("/dav", &WriteRequest { method, path, ..Default::default() }).unwrap()
}

fn listing(files: &AccountFiles<Memory>, path: &str) -> String {
    String::from_utf8(read(files, "PROPFIND", path).body).unwrap()
}

#[test]
fn a_put_keeps_new_bytes_and_a_second_put_replaces_them_with_its_entity_tag() {
    let (mut files, _, _) = account_files();
    let made = put(&mut files, "/a%20b.txt", b"first");
    assert_eq!(made.status, 201);
    let first = made.header("etag").unwrap().to_owned();
    let got = read(&files, "GET", "/a%20b.txt");
    assert_eq!((got.status, got.body.as_slice(), got.header("etag")), (200, b"first".as_slice(), Some(first.as_str())));
    assert_eq!(got.header("content-type"), Some("text/plain"));
    let replaced = put(&mut files, "/a%20b.txt", b"second");
    assert_eq!(replaced.status, 204);
    assert_ne!(replaced.header("etag"), Some(first.as_str()));
    assert_eq!(read(&files, "GET", "/a%20b.txt").body, b"second");
    // An empty file is a stored file too.
    assert_eq!(put(&mut files, "/empty", b"").status, 201);
    assert_eq!(read(&files, "GET", "/empty").status, 200);
}

#[test]
fn a_put_is_refused_where_there_is_no_folder_a_folder_or_too_many_bytes() {
    let (mut files, _, _) = account_files();
    assert_eq!(put(&mut files, "/Missing/a.txt", b"x").status, 409, "the parent folder must exist");
    assert_eq!(read(&files, "PROPFIND", "/Missing").status, 404, "a refused put makes no folder");
    assert_eq!(write_method(&mut files, "MKCOL", "/Notes").status, 201);
    assert_eq!(put(&mut files, "/Notes", b"x").status, 405, "a folder is not a file");
    assert_eq!(put(&mut files, "/Notes/", b"x").status, 405);
    assert_eq!(put(&mut files, "/", b"x").status, 405);
    let too_many = vec![0u8; 16 * 1024 * 1024 + 1];
    assert_eq!(put(&mut files, "/Notes/big.bin", &too_many).status, 413);
    assert_eq!(put(&mut files, "/Notes/%FF", b"x").status, 404);
}

#[test]
fn if_match_and_if_none_match_refuse_a_write_to_a_name_that_changed() {
    let (mut files, _, _) = account_files();
    let first = put(&mut files, "/a.txt", b"one").header("etag").unwrap().to_owned();
    let ask = |if_match: Option<&'static str>, if_none_match: Option<&'static str>, body: &'static [u8]| WriteRequest {
        method: "PUT", path: "/a.txt", if_match, if_none_match, body, ..Default::default()
    };
    assert_eq!(files.dav_write("/dav", &ask(None, Some("*"), b"two")).unwrap().status, 412, "create-only, but it exists");
    assert_eq!(files.dav_write("/dav", &ask(Some("\"1f:0000\""), None, b"two")).unwrap().status, 412, "another version");
    assert_eq!(read(&files, "GET", "/a.txt").body, b"one", "a refused write changes nothing");
    let leaked: &'static str = Box::leak(first.into_boxed_str());
    assert_eq!(files.dav_write("/dav", &ask(Some(leaked), None, b"two")).unwrap().status, 204);
    assert_eq!(files.dav_write("/dav", &ask(Some(leaked), None, b"three")).unwrap().status, 412, "the tag moved on");
    assert_eq!(read(&files, "GET", "/a.txt").body, b"two");
    let fresh = WriteRequest { method: "PUT", path: "/b.txt", if_none_match: Some("*"), body: b"b", ..Default::default() };
    assert_eq!(files.dav_write("/dav", &fresh).unwrap().status, 201);
}

#[test]
fn mkcol_makes_one_folder_inside_one_that_exists() {
    let (mut files, _, _) = account_files();
    assert_eq!(write_method(&mut files, "MKCOL", "/Photos").status, 201);
    assert!(listing(&files, "/").contains("<D:href>/dav/Photos/</D:href>"));
    assert_eq!(write_method(&mut files, "MKCOL", "/Photos/2026/").status, 201);
    assert_eq!(write_method(&mut files, "MKCOL", "/Photos").status, 405, "it exists");
    assert_eq!(write_method(&mut files, "MKCOL", "/").status, 405);
    assert_eq!(write_method(&mut files, "MKCOL", "/A/B").status, 409, "no folder /A");
    put(&mut files, "/Photos/a.jpg", b"x");
    assert_eq!(write_method(&mut files, "MKCOL", "/Photos/a.jpg").status, 405, "a file has the name");
    let with_body = WriteRequest { method: "MKCOL", path: "/C", body: b"<x/>", ..Default::default() };
    assert_eq!(files.dav_write("/dav", &with_body).unwrap().status, 415);
}

#[test]
fn a_delete_sets_a_name_or_folder_aside_and_put_back_recovers_it() {
    let (mut files, _, _) = account_files();
    write_method(&mut files, "MKCOL", "/Notes");
    put(&mut files, "/Notes/a.txt", b"kept");
    put(&mut files, "/Notes/b.txt", b"also");
    assert_eq!(write_method(&mut files, "DELETE", "/Notes/a.txt").status, 204);
    assert_eq!(read(&files, "GET", "/Notes/a.txt").status, 404);
    let aside = call(&mut files, "list_set_aside", serde_json::json!({"folder": "/Notes"})).unwrap();
    assert_eq!(aside["names"][0]["name"], "/Notes/a.txt", "{aside}");
    call(&mut files, "put_back", serde_json::json!({"name": "/Notes/a.txt"})).unwrap();
    assert_eq!(read(&files, "GET", "/Notes/a.txt").body, b"kept", "the bytes were never forgotten");
    // Deleted again after a change: the newest deletion is the one kept for putting back.
    write_method(&mut files, "DELETE", "/Notes/a.txt");
    put(&mut files, "/Notes/a.txt", b"newer");
    assert_eq!(write_method(&mut files, "DELETE", "/Notes/a.txt").status, 204);
    call(&mut files, "put_back", serde_json::json!({"name": "/Notes/a.txt"})).unwrap();
    assert_eq!(read(&files, "GET", "/Notes/a.txt").body, b"newer");
    // A whole folder.
    assert_eq!(write_method(&mut files, "DELETE", "/Notes").status, 204);
    assert_eq!(read(&files, "PROPFIND", "/Notes").status, 404);
    call(&mut files, "put_back", serde_json::json!({"name": "/Notes"})).unwrap();
    assert_eq!(read(&files, "GET", "/Notes/b.txt").body, b"also");
    assert_eq!(write_method(&mut files, "DELETE", "/Missing").status, 404);
    assert_eq!(write_method(&mut files, "DELETE", "/").status, 403);
}

#[test]
fn move_and_copy_carry_names_and_folders_and_overwrite_only_when_asked() {
    let (mut files, _, _) = account_files();
    write_method(&mut files, "MKCOL", "/Notes");
    write_method(&mut files, "MKCOL", "/Notes/Deep");
    put(&mut files, "/Notes/a.txt", b"a");
    put(&mut files, "/Notes/Deep/c.txt", b"c");
    // A rename, by a full URL as clients send it.
    assert_eq!(carry(&mut files, "MOVE", "/Notes/a.txt", "https://door.test/dav/Notes/renamed.txt", None).status, 201);
    assert_eq!(read(&files, "GET", "/Notes/a.txt").status, 404);
    assert_eq!(read(&files, "GET", "/Notes/renamed.txt").body, b"a");
    // A copy is one more name for the same file.
    assert_eq!(carry(&mut files, "COPY", "/Notes/renamed.txt", "/dav/copy.txt", None).status, 201);
    assert_eq!(read(&files, "GET", "/copy.txt").header("etag"), read(&files, "GET", "/Notes/renamed.txt").header("etag"));
    // A whole folder moves; its names and child folders go with it.
    assert_eq!(carry(&mut files, "MOVE", "/Notes", "/dav/Moved", None).status, 201);
    assert_eq!(read(&files, "PROPFIND", "/Notes").status, 404);
    assert_eq!(read(&files, "GET", "/Moved/Deep/c.txt").body, b"c");
    // A copy of a folder at depth 0 is the folder alone.
    let alone = WriteRequest { method: "COPY", path: "/Moved", destination: Some("/dav/Empty"), depth: Some("0"), ..Default::default() };
    assert_eq!(files.dav_write("/dav", &alone).unwrap().status, 201);
    assert!(!listing(&files, "/Empty").contains("c.txt"));
    // Onto an existing name: refused with Overwrite: F, else the old one is set aside first.
    put(&mut files, "/other.txt", b"other");
    assert_eq!(carry(&mut files, "MOVE", "/copy.txt", "/dav/other.txt", Some("F")).status, 412);
    assert_eq!(carry(&mut files, "MOVE", "/copy.txt", "/dav/other.txt", Some("T")).status, 204);
    assert_eq!(read(&files, "GET", "/other.txt").body, b"a");
    let aside = call(&mut files, "list_set_aside", serde_json::json!({"folder": "/"})).unwrap();
    assert!(aside["names"].as_array().unwrap().iter().any(|row| row["name"] == "/other.txt"), "{aside}");
    // The refusals.
    assert_eq!(carry(&mut files, "MOVE", "/Moved", "/dav/Moved/Inside", None).status, 403);
    assert_eq!(carry(&mut files, "MOVE", "/Moved", "/dav/Moved", None).status, 403);
    assert_eq!(carry(&mut files, "MOVE", "/other.txt", "/dav/No/where.txt", None).status, 409);
    assert_eq!(carry(&mut files, "MOVE", "/other.txt", "/elsewhere/x.txt", None).status, 400);
    assert_eq!(carry(&mut files, "COPY", "/missing.txt", "/dav/x.txt", None).status, 404);
    assert_eq!(carry(&mut files, "MOVE", "/", "/dav/x", None).status, 403);
}

#[test]
fn the_reads_stay_read_only_and_the_writes_are_their_own_operation() {
    use base64::prelude::{BASE64_STANDARD as BASE64, *};
    let (mut files, _, _) = account_files();
    // The read operation still refuses every write.
    write(&mut files, "/kept.txt", b"k");
    assert_eq!(read(&files, "PUT", "/kept.txt").status, 405);
    // The write operation refuses a read.
    assert_eq!(write_method(&mut files, "GET", "/a.txt").status, 405);
    // The door's input: the body as base64.
    let input = serde_json::json!({"prefix": "/dav", "method": "PUT", "path": "/a.txt", "content_type": "text/plain",
        "body_base64": BASE64.encode(b"from the door")});
    let answer = files.call("dav_write", &input).unwrap().unwrap();
    assert_eq!(answer["status"], 201, "{answer}");
    assert_eq!(read(&files, "GET", "/a.txt").body, b"from the door");
    let moved = files.call("dav_write", &serde_json::json!({"prefix": "/dav", "method": "MOVE", "path": "/a.txt",
        "destination": "/dav/b.txt"})).unwrap().unwrap();
    assert_eq!(moved["status"], 201, "{moved}");
    assert!(files.call("dav_write", &serde_json::json!({"path": "/a.txt"})).unwrap().is_err(), "a request names its method");
    let bad = files.call("dav_write", &serde_json::json!({"method": "PUT", "path": "/c", "body_base64": "!!"})).unwrap();
    assert!(bad.is_err(), "a body that is not base64");
    // OPTIONS names the writes, so a client mounts the folder writable.
    let options = live_namespace::account_files::dav::options();
    assert_eq!(options.header("allow"), Some("OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK"));
}

#[test]
fn a_lock_holds_its_name_against_every_write_without_its_token_until_unlocked_or_ended() {
    let (mut files, _, clock) = account_files();
    write_method(&mut files, "MKCOL", "/Notes");
    put(&mut files, "/Notes/a.txt", b"one");
    let lock = |files: &mut AccountFiles<Memory>, path: &'static str, depth: Option<&'static str>| {
        files.dav_write("/dav", &WriteRequest { method: "LOCK", path, depth, timeout: Some("Second-60"), body: b"<D:lockinfo xmlns:D=\"DAV:\"/>", ..Default::default() }).unwrap()
    };
    let held = lock(&mut files, "/Notes/a.txt", Some("0"));
    assert_eq!(held.status, 200);
    let token_header = held.header("lock-token").unwrap().to_owned();
    let token = token_header.trim_matches(['<', '>']).to_owned();
    let body = String::from_utf8(held.body).unwrap();
    assert!(body.contains(&format!("<D:locktoken><D:href>{token}</D:href>")) && body.contains("<D:timeout>Second-60</D:timeout>"), "{body}");
    // A second lock, and every write without the token, is refused while it lasts.
    assert_eq!(lock(&mut files, "/Notes/a.txt", None).status, 423);
    assert_eq!(put(&mut files, "/Notes/a.txt", b"two").status, 423);
    assert_eq!(write_method(&mut files, "DELETE", "/Notes/a.txt").status, 423);
    assert_eq!(carry(&mut files, "MOVE", "/Notes/a.txt", "/dav/b.txt", None).status, 423);
    put(&mut files, "/c.txt", b"c");
    assert_eq!(carry(&mut files, "COPY", "/c.txt", "/dav/Notes/a.txt", None).status, 423, "a locked destination");
    assert_eq!(read(&files, "GET", "/Notes/a.txt").body, b"one");
    // With the token, the write goes through.
    let presented = format!("(<{token}>)");
    let leaked: &'static str = Box::leak(presented.into_boxed_str());
    let with = WriteRequest { method: "PUT", path: "/Notes/a.txt", if_header: Some(leaked), body: b"two", ..Default::default() };
    assert_eq!(files.dav_write("/dav", &with).unwrap().status, 204);
    // A refresh: no body, the token in If.
    let refresh = WriteRequest { method: "LOCK", path: "/Notes/a.txt", if_header: Some(leaked), timeout: Some("Second-120"), ..Default::default() };
    assert_eq!(files.dav_write("/dav", &refresh).unwrap().status, 200);
    // UNLOCK needs the token, then the name is free.
    let wrong = WriteRequest { method: "UNLOCK", path: "/Notes/a.txt", lock_token: Some("<opaquelocktoken:nope>"), ..Default::default() };
    assert_eq!(files.dav_write("/dav", &wrong).unwrap().status, 409);
    let token_leaked: &'static str = Box::leak(token_header.into_boxed_str());
    let unlock = WriteRequest { method: "UNLOCK", path: "/Notes/a.txt", lock_token: Some(token_leaked), ..Default::default() };
    assert_eq!(files.dav_write("/dav", &unlock).unwrap().status, 204);
    assert_eq!(put(&mut files, "/Notes/a.txt", b"three").status, 204);
    // A folder locked at depth infinity holds the names under it; the lock ends on its own.
    assert_eq!(lock(&mut files, "/Notes", None).status, 200);
    assert_eq!(put(&mut files, "/Notes/new.txt", b"x").status, 423);
    clock.later_minutes(2);
    assert_eq!(put(&mut files, "/Notes/new.txt", b"x").status, 201, "an ended lock holds nothing");
    // A lock of a name that does not exist makes it an empty file.
    let made = lock(&mut files, "/fresh.txt", None);
    assert_eq!(made.status, 201);
    assert_eq!(read(&files, "GET", "/fresh.txt").status, 200);
    assert_eq!(lock(&mut files, "/No/where.txt", None).status, 409);
}
