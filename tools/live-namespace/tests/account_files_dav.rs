// tests/account_files_dav.rs
//
// Purpose: The person's files as a read-only WebDAV folder (old trillion's WebDAV module, ports/account-files-dav.json),
// answered by the account files over a record store in memory: OPTIONS, PROPFIND at depth 0 and 1 (stored names only), GET and HEAD of
// whole files and byte ranges, and the refusals (a folder read, a write, a missing name, a range outside the file).
// The sign-in and its /dav route are tested in src/mcp/carried.rs; here, the account files' `dav`
// operation answers the same request as data. Synthetic data only.

mod account_files_common;

use account_files_common::*;
use live_namespace::account_files::dav::{Request, Response};

fn ask(files: &live_namespace::account_files::AccountFiles, method: &str, path: &str, depth: Option<&str>, range: Option<&str>) -> Response {
    files.dav("/files", &Request { method, path, depth, range }).unwrap()
}

#[test]
fn a_folder_lists_its_child_folders_and_stored_names_and_depth_zero_lists_it_alone() {
    let (mut files, _, _) = account_files();
    let note = write(&mut files, "/Notes/a b.txt", b"hello there");
    write(&mut files, "/Notes/Deep/c.txt", b"deep");
    let root = ask(&files, "PROPFIND", "/", Some("1"), None);
    assert_eq!(root.status, 207);
    assert_eq!(root.header("dav"), Some("1, 2"));
    let body = String::from_utf8(root.body).unwrap();
    assert!(body.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?><D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/files/</D:href>"), "{body}");
    assert!(body.contains("<D:href>/files/Notes/</D:href>"));
    let folder = String::from_utf8(ask(&files, "PROPFIND", "/Notes/", None, None).body).unwrap();
    assert!(folder.contains("<D:href>/files/Notes/Deep/</D:href>"));
    assert!(folder.contains("<D:href>/files/Notes/a%20b.txt</D:href>"));
    assert!(folder.contains(&format!("<D:getcontentlength>11</D:getcontentlength><D:getetag>\"{note}\"</D:getetag>")));
    let alone = String::from_utf8(ask(&files, "PROPFIND", "/Notes", Some("0"), None).body).unwrap();
    assert_eq!(alone.matches("<D:response>").count(), 1);
    let file = String::from_utf8(ask(&files, "PROPFIND", "/Notes/a%20b.txt", None, None).body).unwrap();
    assert_eq!(file.matches("<D:response>").count(), 1);
}

#[test]
fn a_file_is_read_whole_or_by_range_and_head_answers_its_size_alone() {
    let (mut files, _, _) = account_files();
    write(&mut files, "/a.txt", b"0123456789");
    let whole = ask(&files, "GET", "/a.txt", None, None);
    assert_eq!((whole.status, whole.body.as_slice()), (200, b"0123456789".as_slice()));
    assert_eq!(whole.header("accept-ranges"), Some("bytes"));
    let part = ask(&files, "GET", "/a.txt", None, Some("bytes=2-4"));
    assert_eq!((part.status, part.body.as_slice()), (206, b"234".as_slice()));
    assert_eq!(part.header("content-range"), Some("bytes 2-4/10"));
    let tail = ask(&files, "get", "/a.txt", None, Some("bytes=-2"));
    assert_eq!(tail.body, b"89");
    let head = ask(&files, "HEAD", "/a.txt", None, None);
    assert_eq!((head.status, head.header("content-length"), head.body.len()), (200, Some("10"), 0));
    let outside = ask(&files, "GET", "/a.txt", None, Some("bytes=10-"));
    assert_eq!((outside.status, outside.header("content-range")), (416, Some("bytes */10")));
}

#[test]
fn the_read_operation_is_read_only_and_answers_what_it_does_not_hold_as_not_found() {
    let (mut files, _, _) = account_files();
    write(&mut files, "/Notes/a.txt", b"x");
    let options = ask(&files, "OPTIONS", "/anything", None, None);
    // OPTIONS names the writes too: they are the separate `dav_write` operation (tests/account_files_dav_write.rs).
    assert_eq!((options.status, options.header("allow")), (200, Some("OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK")));
    assert_eq!(ask(&files, "PUT", "/Notes/a.txt", None, None).status, 405);
    assert_eq!(ask(&files, "DELETE", "/Notes/a.txt", None, None).status, 405);
    let folder = ask(&files, "GET", "/Notes", None, None);
    assert_eq!((folder.status, folder.header("allow")), (405, Some("OPTIONS, PROPFIND")));
    assert_eq!(ask(&files, "PROPFIND", "/Missing", None, None).status, 404);
    assert_eq!(ask(&files, "GET", "/%FF", None, None).status, 404);
    assert_eq!(live_namespace::account_files::dav::sign_in().status, 401);
}

#[test]
fn the_dav_operation_answers_the_same_request_as_data_for_the_dav_route() {
    use base64::prelude::{BASE64_STANDARD as BASE64, *};
    let (mut files, _, _) = account_files();
    write(&mut files, "/a.txt", b"0123456789");
    let input = serde_json::json!({"prefix": "/dav", "method": "GET", "path": "/a.txt", "range": "bytes=2-4"});
    let answer = files.call("dav", &input).unwrap().unwrap();
    assert_eq!(answer["status"], 206);
    assert_eq!(BASE64.decode(answer["body_base64"].as_str().unwrap()).unwrap(), b"234");
    assert!(answer["headers"].as_array().unwrap().iter().any(|pair| pair[0] == "content-range" && pair[1] == "bytes 2-4/10"));
    let listing = files.call("dav", &serde_json::json!({"prefix": "/dav", "method": "PROPFIND", "path": "/", "depth": "1"})).unwrap().unwrap();
    assert_eq!(listing["status"], 207);
    let body = String::from_utf8(BASE64.decode(listing["body_base64"].as_str().unwrap()).unwrap()).unwrap();
    assert!(body.contains("<D:href>/dav/a.txt</D:href>"), "{body}");
    assert!(files.call("dav", &serde_json::json!({"path": "/a.txt"})).unwrap().is_err(), "a request names its method");
}
