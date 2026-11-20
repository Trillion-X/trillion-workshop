// tests/account_files_route.rs
//
// Purpose: The account files end to end over synthetic rows: the tool contract (list_files with folders and paging, find_file by name, identity and alias, files_summary, read_file
// across a chunk boundary, write_file of new and already-kept content), and the generic name operations (find_names,
// move_names and copy_names of a name or a whole folder in bounded pages, set_aside, list_set_aside and put_back)
// over a record store in memory and an in-memory byte port that serves only exact ranges.
// Invariants: the byte port refuses any read outside an object, so a test passes only if every read asks for the
// exact range it needs.
// Key concepts: `live_namespace::account_files::{migrate, AccountFiles}`.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use content_crypto::advanced::blake3;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier, Mutex,
    },
};
use live_namespace::{
    account_files::{
        folders_scope, names_scope,
        objects::{Body, Listing, ObjectError, Objects, Origin, Stat},
        AccountFiles,
    },
    store::{Mutation, SqlStore, Store},
};

const ACCOUNT: &str = "account-a";

/// Objects in memory: (origin, key) -> bytes. Every read and write is logged.
#[derive(Default)]
struct Held {
    objects: Mutex<HashMap<(String, String), Vec<u8>>>,
    reads: Mutex<Vec<(String, u64, u64)>>,
    refuse: Mutex<Vec<String>>,
    revoke_after_write: Mutex<Option<Arc<AtomicBool>>>,
    write_barrier: Mutex<Option<Arc<Barrier>>>,
}
struct Port(Arc<Held>);
impl Objects for Port {
    /// A stand-in in memory sends no request, so it only keeps the control.
    fn set_control(&mut self, _: live_namespace::account_files::CallControl) {}
    fn read(
        &self,
        origin: &str,
        key: &str,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, ObjectError> {
        let objects = self.0.objects.lock().unwrap();
        let bytes = objects
            .get(&(origin.to_owned(), key.to_owned()))
            .ok_or(ObjectError::Refused(404, live_namespace::cause!()))?;
        if length == 0 || offset + length > bytes.len() as u64 {
            return Err(ObjectError::Refused(416, live_namespace::cause!()));
        }
        self.0
            .reads
            .lock()
            .unwrap()
            .push((key.to_owned(), offset, length));
        Ok(bytes[offset as usize..(offset + length) as usize].to_vec())
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], _: &str) -> Result<(), ObjectError> {
        if self
            .0
            .refuse
            .lock()
            .unwrap()
            .iter()
            .any(|refused| refused == origin)
        {
            return Err(ObjectError::Refused(403, live_namespace::cause!()));
        }
        self.0
            .objects
            .lock()
            .unwrap()
            .insert((origin.to_owned(), key.to_owned()), bytes.to_vec());
        if let Some(current) = self.0.revoke_after_write.lock().unwrap().as_ref() {
            current.store(false, Ordering::SeqCst);
        }
        let barrier = self.0.write_barrier.lock().unwrap().clone();
        if let Some(barrier) = barrier {
            barrier.wait();
        }
        Ok(())
    }
    fn write_stream(
        &self,
        origin: &str,
        key: &str,
        body: Body<'_>,
        media_type: &str,
    ) -> Result<(), ObjectError> {
        let mut bytes = Vec::new();
        body.bytes
            .take(body.length)
            .read_to_end(&mut bytes)
            .map_err(|error| ObjectError::Unavailable(error.to_string(), live_namespace::cause!()))?;
        self.write(origin, key, &bytes, media_type)
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        Ok(self
            .0
            .objects
            .lock()
            .unwrap()
            .get(&(origin.to_owned(), key.to_owned()))
            .map(|bytes| Stat {
                length: bytes.len() as u64,
                media_type: None,
            }))
    }
    fn list(&self, _: &str, _: &str, _: &str, _: usize) -> Result<Listing, ObjectError> {
        Ok(Listing::default())
    }
}

fn id(bytes: &[u8]) -> String {
    format!("1f:{}", blake3::hash(bytes).to_hex())
}

/// Put `rows` (id, value) into `scope` as new rows.
fn seed(store: &Store, scope: &str, rows: Vec<(String, Value)>) {
    for (id, value) in rows {
        store.mutate(scope, Mutation { id: id.clone(), expected_version: 0, request_key: format!("seed:{id}"), deleted: false, value }).unwrap();
    }
}

/// The person's files with: a whole file in R2 under two names, a chunked file in B2 (two chunks) named through an alias, a deep
/// folder whose ancestors hold no names, one upload in progress and two origins; its bytes in `Held`.
fn kept() -> (AccountFiles, Arc<Held>, Vec<u8>) {
    let held = Arc::new(Held::default());
    let store: Store = Arc::new(SqlStore::memory().unwrap());
    let origin = |rank: u32, bucket: Value, endpoint: Value, region: Value, id: &str| json!({
        "kind": "namespace-origin", "rank": rank, "takes_new_bytes": true, "file_key_prefix": "people/p/files/",
        "reach": { "key_id": {"held": format!("held-{id}-key-id")}, "secret": {"held": format!("held-{id}-application-key")},
                   "bucket": bucket, "endpoint": endpoint, "region": region },
    });
    seed(&store, "@namespace/origins", vec![
        ("backblaze-b2".into(), origin(2, json!({"held": "held-backblaze-b2-bucket"}), json!({"value": "https://s3.example.test"}), json!({"value": "r-1"}), "backblaze-b2")),
        ("cloudflare-r2".into(), origin(1, json!({"value": "landing"}), json!({"held": "held-cloudflare-r2-endpoint"}), json!({"held": "held-cloudflare-r2-region"}), "cloudflare-r2")),
    ]);

    let note = b"a note kept in the landing store".to_vec();
    let note_id = id(&note);
    let note_key = format!("people/p/files/{note_id}");
    held.objects.lock().unwrap().insert(("cloudflare-r2".into(), note_key.clone()), note.clone());

    let first: Vec<u8> = (0..1000u32).map(|n| (n % 251) as u8).collect();
    let second: Vec<u8> = (0..700u32).map(|n| (n % 241) as u8).collect();
    let video: Vec<u8> = [first.clone(), second.clone()].concat();
    let video_id = id(&video);
    let alias = format!("12:{}", "a".repeat(64));
    let (mut chunks, mut spans) = (Vec::new(), Vec::new());
    for (offset, piece) in [(0usize, &first), (1000usize, &second)] {
        let chunk = id(piece);
        let key = format!("people/p/chunks/{chunk}");
        chunks.push((chunk.clone(), json!({"kind": "namespace-chunk", "byte_length": piece.len(), "origin": "backblaze-b2", "key": key, "stored_at": "2026-09-28T02:50:00.000Z"})));
        spans.push(json!({"offset": offset, "length": piece.len(), "chunk": chunk}));
        held.objects.lock().unwrap().insert(("backblaze-b2".into(), key), piece.clone());
    }
    seed(&store, "@namespace/chunks", chunks);
    seed(&store, "@namespace/spans", vec![(video_id.clone(), json!({"kind": "namespace-spans", "spans": spans}))]);
    seed(&store, "@namespace/aliases", vec![(alias.clone(), json!({"kind": "namespace-alias", "identity": video_id, "grade": "checked", "added_at": "2026-09-28T03:00:00.000Z"}))]);
    seed(&store, "@namespace/files", vec![
        (note_id.clone(), json!({"kind": "namespace-file", "byte_length": note.len(), "media_type": "text/plain", "origin": "cloudflare-r2", "key": note_key,
            "part_bytes": 33554432, "stored_at": "2026-09-27T05:02:28.064Z", "checked_at": "2026-09-27T05:02:28.064Z", "spans": 0,
            "aliases": [], "names": ["/Notes/a.txt", "/Notes/b.txt"]})),
        (video_id.clone(), json!({"kind": "namespace-file", "byte_length": video.len(), "media_type": "application/octet-stream", "origin": "backblaze-b2", "key": "",
            "part_bytes": 0, "stored_at": "2026-09-28T02:56:01.898Z", "checked_at": "2026-09-28T02:56:01.898Z", "spans": 2,
            "aliases": [{"alias": alias, "grade": "checked"}], "names": ["/Recordings/club/player/day/C6637.MP4"]})),
    ]);
    let name = |name: &str, identity: &str, file: &str, size: usize| (name.to_owned(), json!({"kind": "namespace-name", "name": name, "identity": identity,
        "file": file, "byte_length": size, "modified_at_ms": null, "named_at": "2026-09-28T03:22:52.307Z"}));
    seed(&store, &names_scope("/Notes"), vec![name("/Notes/a.txt", &note_id, &note_id, note.len()), name("/Notes/b.txt", &note_id, &note_id, note.len())]);
    seed(&store, &names_scope("/Recordings/club/player/day"), vec![name("/Recordings/club/player/day/C6637.MP4", &alias, &video_id, video.len())]);
    for (parent_folder, folders) in [("/", vec!["/Notes", "/Recordings"]), ("/Recordings", vec!["/Recordings/club"]), ("/Recordings/club", vec!["/Recordings/club/player"]),
        ("/Recordings/club/player", vec!["/Recordings/club/player/day"])] {
        seed(&store, &folders_scope(parent_folder), folders.into_iter().map(|folder| (folder.to_owned(), json!({"kind": "namespace-folder", "folder": folder}))).collect());
    }
    seed(&store, "@namespace/uploads", vec![("up:1".into(), json!({"kind": "namespace-upload", "byte_length": 5000, "media_type": null, "origin": "cloudflare-r2",
        "started_at": "2026-10-22T00:00:00.000Z", "bytes_held": 0, "app": null}))]);
    (AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone()))), held, video)
}

#[test]
fn list_files_pages_a_folder_and_shows_child_folders_on_the_first_page() {
    let (account_files, ..) = kept();
    let root = account_files.list_files(Some("/"), None, None, None).unwrap();
    assert_eq!(root["names"], json!([]));
    assert_eq!(root["folders"], json!(["/Notes", "/Recordings"]));
    assert!(root["folder_revisions"]["/Notes"]
        .as_str()
        .unwrap()
        .starts_with("folder:"));
    let first = account_files
        .list_files(Some("/Notes/"), None, Some(1), None)
        .unwrap();
    assert_eq!(first["collection"], "/Notes");
    assert_eq!(first["names"][0]["name"], "/Notes/a.txt");
    assert_eq!(first["names"][0]["stored"], true);
    assert_eq!(first["names"][0]["media_type"], "text/plain");
    assert_eq!(first["names"][0]["also_named"], 1);
    assert_eq!(first["names"][0]["also_at"], json!(["/Notes/b.txt"]));
    assert_eq!(first["next_after"], "/Notes/a.txt");
    let second = account_files
        .list_files(Some("/Notes"), Some("/Notes/a.txt"), Some(1), None)
        .unwrap();
    assert_eq!(second["names"][0]["name"], "/Notes/b.txt");
    assert_eq!(second["next_after"], Value::Null);
    assert_eq!(
        second["folders"],
        json!([]),
        "folders come on the first page only"
    );
    let deep = account_files
        .list_files(Some("/Recordings/club"), None, None, None)
        .unwrap();
    assert_eq!(deep["folders"], json!(["/Recordings/club/player"]));
}

#[test]
fn find_file_resolves_names_identities_and_aliases() {
    let (account_files, _, video) = kept();
    let by_name = account_files
        .find_file("/Recordings/club/player/day/C6637.MP4")
        .unwrap();
    assert_eq!(by_name["identity"], json!(id(&video)));
    assert_eq!(by_name["origin"], "backblaze-b2");
    assert_eq!(by_name["spans"], 2);
    assert_eq!(by_name["aliases"][0]["grade"], "checked");
    assert_eq!(
        by_name["names"],
        json!(["/Recordings/club/player/day/C6637.MP4"])
    );
    let by_alias = account_files
        .find_file(&format!("12:{}", "a".repeat(64)))
        .unwrap();
    assert_eq!(by_alias["identity"], by_name["identity"]);
    assert!(matches!(
        account_files.find_file("/Notes/missing.txt"),
        Err(live_namespace::account_files::AccountFilesError::NotFound(_))
    ));
}

/// One question over the file names (old trillion src/search.mjs:1364 `words-in-names`): every asked word must start
/// a word of the last part of a name; a folder's word alone finds nothing; a file written later is found at once,
/// and each hit answers the `find_file` call that opens it.
#[test]
fn search_finds_files_by_the_words_of_their_names_and_answers_the_call_that_opens_them() {
    let (mut account_files, _, video) = kept();
    let found = account_files
        .call("search", &json!({"question": "C6637 mp4"}))
        .unwrap()
        .unwrap();
    let results = found["results"].as_array().unwrap();
    assert_eq!(results.len(), 1, "{found}");
    assert_eq!(results[0]["identity"], json!(id(&video)));
    assert_eq!(results[0]["path"], "/Recordings/club/player/day/C6637.MP4");
    assert_eq!(results[0]["name"], "C6637.MP4");
    assert_eq!(results[0]["found_in"], json!(["name"]));
    assert_eq!(
        results[0]["address"],
        json!({"resource": "@namespace", "operation": "find_file",
        "input": {"name_or_identity": "/Recordings/club/player/day/C6637.MP4"}})
    );
    let opened = account_files
        .find_file(
            results[0]["address"]["input"]["name_or_identity"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(opened["identity"], results[0]["identity"]);
    // A word only a folder holds is not a name's word; a word nothing holds finds nothing.
    assert_eq!(
        account_files.search("recordings", None).unwrap()["results"],
        json!([])
    );
    assert_eq!(
        account_files.search("c6637 wav", None).unwrap()["results"],
        json!([])
    );
    // A file written now is found by its name's words.
    let origins = account_files.origins().unwrap();
    account_files
        .write_file(
            "/Downloads/Invoice March 2026.pdf",
            b"an invoice",
            "application/pdf",
            &origins,
        )
        .unwrap();
    let invoice = account_files.search("invoice march", None).unwrap();
    assert_eq!(
        invoice["results"][0]["path"], "/Downloads/Invoice March 2026.pdf",
        "{invoice}"
    );
    // The question is required and the limit bounded.
    assert!(account_files.search(" ", None).is_err());
    assert!(account_files.search("invoice", Some(0)).is_err());
}

#[test]
fn files_summary_counts_from_declared_totals() {
    let (account_files, ..) = kept();
    let summary = account_files.files_summary().unwrap();
    assert_eq!(summary["files"], 2);
    assert_eq!(summary["bytes"], 1700 + 32);
    assert_eq!(
        summary["by_origin"]["backblaze-b2"],
        json!({ "files": 1, "bytes": 1700 })
    );
    assert_eq!(
        summary["by_origin"]["cloudflare-r2"],
        json!({ "files": 1, "bytes": 32 })
    );
    assert_eq!(summary["names"], 3);
    assert_eq!(summary["chunks"], 2);
    assert_eq!(summary["chunk_bytes"], 1700);
    assert_eq!(summary["uploads_in_progress"], 1);
    assert_eq!(summary["bytes_in_progress"], 5000);
}

#[test]
fn read_file_asks_each_chunk_for_exactly_the_crossed_range() {
    let (account_files, held, video) = kept();
    let read = account_files
        .read_file("/Recordings/club/player/day/C6637.MP4", 990, Some(20))
        .unwrap();
    assert_eq!(read["bytes_returned"], 20);
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(read["content"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, video[990..1010]);
    // The two chunks' reads are in flight together, so the order they reach the store in is not fixed.
    let mut asked: Vec<(u64, u64)> = held
        .reads
        .lock()
        .unwrap()
        .iter()
        .map(|(_, offset, length)| (*offset, *length))
        .collect();
    asked.sort_unstable();
    assert_eq!(asked, [(0, 10), (990, 10)]);
    let text = account_files.read_file("/Notes/a.txt", 2, Some(4)).unwrap();
    assert_eq!(text["encoding"], "utf-8");
    assert_eq!(text["content"], "note");
}

/// A span is one answer of exactly the bytes asked, across chunks, with the same ranged reads `read_file` makes; a span
/// outside the file, or of no bytes, is refused before any byte is read.
#[test]
fn read_file_span_answers_the_whole_span_in_one_call_and_refuses_one_outside_the_file() {
    let (account_files, held, video) = kept();
    let name = "/Recordings/club/player/day/C6637.MP4";
    let read = account_files.read_file_span(name, 990, 20).unwrap();
    assert_eq!((read["bytes_returned"].as_u64(), read["encoding"].as_str()), (Some(20), Some("base64")));
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(read["content"].as_str().unwrap()).unwrap();
    assert_eq!(bytes, video[990..1010]);
    // The two chunks' reads are in flight together, so the order they reach the store in is not fixed.
    let mut asked: Vec<(u64, u64)> = held.reads.lock().unwrap().iter().map(|(_, offset, length)| (*offset, *length)).collect();
    asked.sort_unstable();
    assert_eq!(asked, [(0, 10), (990, 10)]);
    held.reads.lock().unwrap().clear();
    let size = video.len() as u64;
    for (offset, length) in [(0, 0), (size, 1), (size - 1, 2), (u64::MAX, 2)] {
        assert!(account_files.read_file_span(name, offset, length).is_err(), "{offset}+{length}");
    }
    assert!(held.reads.lock().unwrap().is_empty(), "a refused span reads no bytes");
    let last = account_files.read_file_span(name, size - 1, 1).unwrap();
    assert_eq!(last["bytes_returned"], 1);
}

#[test]
fn write_file_keeps_bytes_first_then_records_and_reuses_kept_content() {
    let (mut account_files, held, _) = kept();
    held.refuse.lock().unwrap().push("cloudflare-r2".into());
    let origins = account_files.origins().unwrap();
    let wrote = account_files
        .write_file(
            "/Made by tools/2026/cut.txt",
            b"a new cut",
            "text/plain",
            &origins,
        )
        .unwrap();
    assert_eq!(wrote["already_kept"], false);
    let identity = wrote["identity"].as_str().unwrap().to_owned();
    assert!(
        held.objects.lock().unwrap().contains_key(&(
            "backblaze-b2".to_owned(),
            format!("people/p/files/{identity}")
        )),
        "a refused landing store passes the bytes to the next rank"
    );
    let found = account_files
        .find_file("/Made by tools/2026/cut.txt")
        .unwrap();
    assert_eq!(found["origin"], "backblaze-b2");
    assert_eq!(
        account_files.list_files(Some("/"), None, None, None).unwrap()["folders"],
        json!(["/Made by tools", "/Notes", "/Recordings"])
    );
    assert_eq!(
        account_files
            .list_files(Some("/Made by tools"), None, None, None)
            .unwrap()["folders"],
        json!(["/Made by tools/2026"])
    );
    let again = account_files
        .write_file("/Notes/c.txt", b"a new cut", "text/plain", &origins)
        .unwrap();
    assert_eq!(again["already_kept"], true);
    assert_eq!(
        account_files.find_file(&identity).unwrap()["names"],
        json!(["/Made by tools/2026/cut.txt", "/Notes/c.txt"])
    );
    let summary = account_files.files_summary().unwrap();
    assert_eq!(summary["files"], 3);
    assert_eq!(summary["names"], 5);
    assert_eq!(summary["by_origin"]["backblaze-b2"]["files"], 2);
    assert_eq!(
        account_files.read_file("/Notes/c.txt", 0, None).unwrap()["content"],
        "a new cut"
    );
}

#[test]
fn resumable_upload_reuses_legacy_identity_and_finish_replay_is_stable() {
    use base64::Engine as _;
    use live_namespace::account_files::{CHUNKS, FILES};
        let (mut account_files, _, _) = kept();
    let bytes = b"a note kept in the landing store";
    let upload_id = "a".repeat(32);
    let name = "/Notes/copied.txt";
    let app = "tool:hear-for-a-device";
    let started = call(
        &mut account_files,
        "write_file_start",
        json!({"upload_id":upload_id,"name":name,
        "byte_length":bytes.len(),"media_type":"text/plain","app":app}),
    )
    .unwrap();
    assert_eq!(started["byte_length"], bytes.len());
    let again = call(
        &mut account_files,
        "write_file_start",
        json!({"upload_id":upload_id,"name":name,
        "byte_length":bytes.len(),"media_type":"text/plain","app":app}),
    )
    .unwrap();
    assert_eq!(again["byte_length"], bytes.len());
    assert_eq!(again["next_offset"], 0);
    call(&mut account_files, "write_file_piece", json!({"upload_id":upload_id,"name":name,"offset":0,"content_base64":base64::engine::general_purpose::STANDARD.encode(bytes)})).unwrap();
    let finished = call(
        &mut account_files,
        "write_file_finish",
        json!({"upload_id":upload_id,"name":name}),
    )
    .unwrap();
    let replay = call(
        &mut account_files,
        "write_file_finish",
        json!({"upload_id":upload_id,"name":name}),
    )
    .unwrap();
    assert_eq!(finished, replay);
    assert_eq!(replay["byte_length"], bytes.len());
    assert_eq!(
        call(
            &mut account_files,
            "write_file_start",
            json!({"upload_id":upload_id,"name":name,
        "byte_length":bytes.len(),"media_type":"text/plain","app":app})
        )
        .unwrap()["byte_length"],
        bytes.len()
    );
    let identity = id(bytes);
    assert_eq!(replay["identity"], identity);
    let file = account_files
        .store
        .get(FILES, &identity)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(
        file.value.get("span_layout"),
        None,
        "reusing a legacy file must preserve its original layout"
    );
    assert_eq!(
        account_files
            .store
            .get(CHUNKS, &identity)
            .unwrap()
            .record
            .unwrap()
            .value["key"],
        "people/p/files/".to_owned() + &identity
    );
    assert_eq!(
        account_files.read_file(name, 0, None).unwrap()["content"],
        String::from_utf8_lossy(bytes).as_ref()
    );
}

#[test]
fn upload_finish_refuses_a_changed_name_but_cancel_still_retires_the_token() {
    let (mut account_files, _, _) = kept();
    let upload_id = "b".repeat(32);
    let name = "/Notes/a.txt";
    account_files
        .write_file_start(&upload_id, name, 7, "text/plain", None)
        .unwrap();
    account_files
        .write_file_piece(&upload_id, name, 0, b"staged!")
        .unwrap();
    let origins = account_files.origins().unwrap();
    account_files
        .write_file(name, b"replacement", "text/plain", &origins)
        .unwrap();
    assert!(
        account_files.write_file_finish(&upload_id, name).is_err(),
        "finish must not overwrite a name changed after start"
    );
    assert_eq!(
        account_files.write_file_cancel(&upload_id, name).unwrap()["state"],
        "cancelled"
    );
    assert_eq!(
        account_files.write_file_cancel(&upload_id, name).unwrap()["state"],
        "cancelled"
    );
    assert_eq!(
        account_files
            .write_file_start(&upload_id, name, 7, "text/plain", None)
            .unwrap()["state"],
        "cancelled"
    );
}

#[test]
fn finish_retry_repairs_prior_file_names_after_a_crash_at_name_binding() {
    use live_namespace::{
        account_files::{names_scope, parent, FILES, FILE_KIND, UPLOADS},
        store::Mutation,
    };
    let (mut account_files, _, _) = kept();
    let old_identity = id(b"a note kept in the landing store");
    let upload_id = "f".repeat(32);
    let name = "/Notes/a.txt";
    let bytes = b"replacement after name binding";
    account_files
        .write_file_start(&upload_id, name, bytes.len() as u64, "text/plain", None)
        .unwrap();
    account_files
        .write_file_piece(&upload_id, name, 0, bytes)
        .unwrap();
    let identity = id(bytes);
    let upload = account_files
        .store
        .get(UPLOADS, &upload_id)
        .unwrap()
        .record
        .unwrap();
    let origin = upload.value["origin"].as_str().unwrap();
    account_files.store.mutate(FILES, Mutation {
        id: identity.clone(), expected_version: 0, request_key: "test-crash-file-before-name".into(), deleted: false,
        value: json!({"kind":FILE_KIND,"byte_length":bytes.len(),"media_type":"text/plain","origin":origin,"key":"",
            "stored_at":"2026-01-01T00:00:00Z","checked_at":"2026-01-01T00:00:00Z","spans":1,
            "span_layout":"pages-32k-v1","span_set":upload_id,"aliases":[],"names":[]}),
    }).unwrap();
    let name_scope = names_scope(parent(name));
    let name_record = account_files
        .store
        .get(&name_scope, name)
        .unwrap()
        .record
        .unwrap();
    let mut bound = name_record.value.clone();
    bound["identity"] = json!(identity);
    bound["file"] = json!(identity);
    bound["byte_length"] = json!(bytes.len());
    account_files
        .store
        .mutate(
            &name_scope,
            Mutation {
                id: name.to_owned(),
                expected_version: name_record.version,
                request_key: "test-crash-after-name-binding".into(),
                deleted: false,
                value: bound,
            },
        )
        .unwrap();

    // Model the durable state after the name mutation but before the previous
    // file's names index and terminal upload marker were committed. The old
    // migrated file still lists this name, while the upload remains open.
    let replay = account_files.write_file_finish(&upload_id, name).unwrap();
    assert_eq!(replay["identity"], identity);
    let old = account_files
        .store
        .get(FILES, &old_identity)
        .unwrap()
        .record
        .unwrap();
    assert!(!old.value["names"]
        .as_array()
        .unwrap()
        .iter()
        .any(|held| held.as_str() == Some(name)));
    assert_eq!(account_files.find_file(name).unwrap()["identity"], identity);
}

#[test]
fn upload_pages_cross_a_page_boundary_and_unknown_layout_fails_closed() {
    use live_namespace::{
        account_files::{FILES, UPLOADS},
        store::Mutation,
    };
    let (mut account_files, held, _) = kept();
    let upload_id = "c".repeat(32);
    let name = "/Upload/large.bin";
    let piece = vec![b'x'; 32 * 1024];
    let total_pieces = 257u64;
    account_files
        .write_file_start(
            &upload_id,
            name,
            total_pieces * piece.len() as u64,
            "application/octet-stream",
            None,
        )
        .unwrap();
    // An upload opened before chunks-v1 keeps the fixed 32 KiB layout: this one is opened as such.
    let upload = account_files.store.get(UPLOADS, &upload_id).unwrap().record.unwrap();
    let mut fixed = upload.value.clone();
    fixed["span_layout"] = json!("pages-32k-v1");
    account_files
        .store
        .mutate(
            UPLOADS,
            Mutation {
                id: upload_id.clone(),
                expected_version: upload.version,
                request_key: "test-fixed-layout".into(),
                deleted: false,
                value: fixed,
            },
        )
        .unwrap();
    for ordinal in 0..total_pieces {
        account_files
            .write_file_piece(&upload_id, name, ordinal * piece.len() as u64, &piece)
            .unwrap();
    }
    let finished = account_files.write_file_finish(&upload_id, name).unwrap();
    let file_id = finished["identity"].as_str().unwrap();
    let file = account_files
        .store
        .get(FILES, file_id)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(file.value["span_layout"], "pages-32k-v1");
    assert_eq!(file.value["spans"], 257);
    let boundary = (256 * 32 * 1024 - 5) as u64;
    let read = account_files.read_file(name, boundary, Some(20)).unwrap();
    assert_eq!(read["encoding"], "utf-8");
    assert_eq!(read["content"], "x".repeat(20));
    let asks: Vec<(u64, u64)> = held
        .reads
        .lock()
        .unwrap()
        .iter()
        .map(|(_, offset, length)| (*offset, *length))
        .collect();
    assert_eq!(asks, [(32 * 1024 - 5, 5), (0, 15)]);

    let mut unknown = file.value.clone();
    unknown["span_layout"] = json!("future-layout");
    account_files
        .store
        .mutate(
            FILES,
            Mutation {
                id: file_id.to_owned(),
                expected_version: file.version,
                request_key: "test-unknown-span-layout".into(),
                deleted: false,
                value: unknown,
            },
        )
        .unwrap();
    assert!(
        account_files.read_file(name, boundary, Some(20)).is_err(),
        "unknown layout cannot be mistaken for a legacy array"
    );
}

#[test]
fn upload_stops_after_custody_is_lost_during_the_piece_put() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use live_namespace::account_files::CHUNKS;
        let (account_files, held, _) = kept();
    let current = Arc::new(AtomicBool::new(true));
    *held.revoke_after_write.lock().unwrap() = Some(current.clone());
    let mut account_files = account_files.while_current({
        let current = current.clone();
        Arc::new(move || current.load(Ordering::SeqCst))
    });
    let upload_id = "d".repeat(32);
    let name = "/Notes/revoked.bin";
    account_files
        .write_file_start(&upload_id, name, 8, "application/octet-stream", None)
        .unwrap();
    assert!(account_files
        .write_file_piece(&upload_id, name, 0, b"accepted")
        .is_err());
    assert!(!current.load(Ordering::SeqCst));
    assert_eq!(
        held.objects.lock().unwrap().len(),
        4,
        "the already accepted object PUT remains"
    );
    assert!(
        account_files
            .store
            .get(CHUNKS, &id(b"accepted"))
            .unwrap()
            .record
            .is_none(),
        "no chunk record follows lost custody"
    );
    assert!(
        account_files.find_file(name).is_err(),
        "no file name is exposed"
    );
}

#[test]
fn each_piece_record_commit_is_checked_and_the_piece_replays_after_loss() {
    use live_namespace::{
        account_files::{CHUNKS, SPANS, UPLOADS},
    };
    let piece = b"accepted";
    for target in 1..=3 {
        let (store, applied) = counted_rows(format!("piece-origin-{target}"));
        let held = Arc::new(Held::default());
        let mut account_files =
            AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone())));
        let upload_id = format!("{target:032x}");
        let name = "/piece.bin";
        account_files
            .write_file_start(
                &upload_id,
                name,
                piece.len() as u64,
                "application/octet-stream",
                None,
            )
            .unwrap();
        let (current, checker) = revoke_on_account_files_commit(applied, target);
        account_files = account_files.while_current(checker);
        assert!(
            account_files
                .write_file_piece(&upload_id, name, 0, piece)
                .is_err(),
            "the selected effect {target} must stop"
        );
        assert!(!current.load(Ordering::SeqCst));
        let chunk = account_files
            .store
            .get(CHUNKS, &id(piece))
            .unwrap()
            .record;
        let page_id = format!("{upload_id}:p0000000000000000");
        let page = account_files
            .store
            .get(SPANS, &page_id)
            .unwrap()
            .record;
        let upload = account_files
            .store
            .get(UPLOADS, &upload_id)
            .unwrap()
            .record
            .unwrap();
        assert_eq!(chunk.is_some(), target >= 2);
        assert_eq!(page.is_some(), target >= 3);
        assert_eq!(upload.value["next_offset"], 0);

        account_files = account_files.while_current(Arc::new(|| true));
        account_files
            .write_file_piece(&upload_id, name, 0, piece)
            .unwrap();
        let finished = account_files.write_file_finish(&upload_id, name).unwrap();
        assert_eq!(finished["identity"], id(piece));
    }
}

#[test]
fn each_finish_record_commit_is_checked_and_finish_replays_to_completion() {
    use live_namespace::{
        account_files::{names_scope, FILES, UPLOADS},
    };
    let piece = b"finish me";
    let name = "/finish.bin";
    for target in 1..=4 {
        let (store, applied) = counted_rows(format!("finish-origin-{target}"));
        let held = Arc::new(Held::default());
        let mut account_files = AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held)));
        let upload_id = format!("{target:032x}");
        account_files
            .write_file_start(
                &upload_id,
                name,
                piece.len() as u64,
                "application/octet-stream",
                None,
            )
            .unwrap();
        account_files
            .write_file_piece(&upload_id, name, 0, piece)
            .unwrap();
        let identity = id(piece);

        let (current, checker) = revoke_on_account_files_commit(applied, target);
        account_files = account_files.while_current(checker);
        assert!(
            account_files.write_file_finish(&upload_id, name).is_err(),
            "the selected effect {target} must stop"
        );
        assert!(!current.load(Ordering::SeqCst));
        let file = account_files
            .store
            .get(FILES, &identity)
            .unwrap()
            .record;
        let named = account_files
            .store
            .get(&names_scope("/"), name)
            .unwrap()
            .record;
        let upload = account_files
            .store
            .get(UPLOADS, &upload_id)
            .unwrap()
            .record
            .unwrap();
        assert_eq!(file.is_some(), target >= 2);
        assert_eq!(named.is_some(), target >= 3);
        if target == 2 || target == 3 {
            assert_eq!(file.as_ref().unwrap().value["names"], json!([]));
        } else if target == 4 {
            assert_eq!(file.as_ref().unwrap().value["names"], json!([name]));
        }
        assert_eq!(upload.value["status"], "open");

        account_files = account_files.while_current(Arc::new(|| true));
        assert_eq!(
            account_files.write_file_finish(&upload_id, name).unwrap()["identity"],
            identity
        );
        assert_eq!(
            account_files
                .store
                .get(UPLOADS, &upload_id)
                .unwrap()
                .record
                .unwrap()
                .value["status"],
            "finished"
        );
    }
}

#[test]
fn concurrent_different_bytes_at_one_upload_offset_keep_one_consistent_winner() {
    use live_namespace::account_files::SPANS;
    let (rows, _) = counted_rows("prefill-upload-origin".into());
    let held = Arc::new(Held::default());
    *held.write_barrier.lock().unwrap() = Some(Arc::new(Barrier::new(2)));
    let mut left = AccountFiles::with_objects(rows.clone(), ACCOUNT, Box::new(Port(held.clone())));
    let mut right = AccountFiles::with_objects(rows, ACCOUNT, Box::new(Port(held.clone())));
    let upload_id = "e".repeat(32);
    let name = "/Upload/race.bin";
    left.write_file_start(
        &upload_id,
        name,
        32 * 1024,
        "application/octet-stream",
        None,
    )
    .unwrap();
    let left_bytes = vec![0x41; 32 * 1024];
    let right_bytes = vec![0x42; 32 * 1024];
    let (left, left_result, right, right_result) = std::thread::scope(|scope| {
        let left_bytes_for_thread = left_bytes.clone();
        let right_bytes_for_thread = right_bytes.clone();
        let left_upload_id = upload_id.clone();
        let right_upload_id = upload_id.clone();
        let left_name = name.to_owned();
        let right_name = name.to_owned();
        let left_handle = scope.spawn(move || {
            let result =
                left.write_file_piece(&left_upload_id, &left_name, 0, &left_bytes_for_thread);
            (left, result)
        });
        let right_handle = scope.spawn(move || {
            let result =
                right.write_file_piece(&right_upload_id, &right_name, 0, &right_bytes_for_thread);
            (right, result)
        });
        let (left, left_result) = left_handle.join().unwrap();
        let (right, right_result) = right_handle.join().unwrap();
        (left, left_result, right, right_result)
    });
    assert_ne!(
        left_result.is_ok(),
        right_result.is_ok(),
        "different bytes at one offset cannot both be accepted"
    );
    let (mut winner, bytes) = if left_result.is_ok() {
        (left, left_bytes)
    } else {
        (right, right_bytes)
    };
    let finished = winner.write_file_finish(&upload_id, name).unwrap();
    assert_eq!(finished["identity"], id(&bytes));
    let page_id = format!("{upload_id}:p0000000000000000");
    let page = winner
        .store
        .get(SPANS, &page_id)
        .unwrap()
        .record
        .unwrap();
    assert_eq!(page.value["spans"][0]["chunk"], id(&bytes));
    assert_eq!(
        winner.read_file(name, 0, Some(32)).unwrap()["content"],
        String::from_utf8_lossy(&bytes[..32]).as_ref()
    );
}

/// The migrated origins, each bound to the state folder `home` (or left unbound when `home` is None), the landing store
/// declining so the bytes go to the next rank, as in the write test above.
fn origins_bound(
    account_files: &AccountFiles,
    home: Option<&str>,
) -> Vec<(String, live_namespace::account_files::objects::Origin)> {
    let mut origins = account_files.origins().unwrap();
    for (_, origin) in &mut origins {
        origin.bound_to = home.map(str::to_owned);
    }
    origins
}

#[test]
fn a_folder_that_is_not_the_one_a_real_store_was_bound_to_cannot_put_new_bytes_in_it() {
    use live_namespace::account_files::{objects::ObjectError, AccountFilesError};
    let (account_files, held, _) = kept();
    let mut account_files = account_files.at_home("100:1.000000001".into());
    held.refuse.lock().unwrap().push("cloudflare-r2".into());
    let before = held.objects.lock().unwrap().len();
    // Unbound (a copy that was never bound on purpose): refused before any byte is sent.
    let unbound = origins_bound(&account_files, None);
    let refused = account_files
        .write_file("/Notes/new.txt", b"never sent", "text/plain", &unbound)
        .unwrap_err();
    assert!(
        matches!(
            refused,
            AccountFilesError::Objects(ObjectError::NotBound(_, _), _)
        ),
        "{refused:?}"
    );
    // Bound to another folder (the folder it was cloned from): refused the same way.
    let elsewhere = origins_bound(&account_files, Some("200:2.000000002"));
    assert!(matches!(
        account_files.write_file("/Notes/new.txt", b"never sent", "text/plain", &elsewhere),
        Err(AccountFilesError::Objects(ObjectError::NotBound(_, _), _))
    ));
    assert_eq!(
        held.objects.lock().unwrap().len(),
        before,
        "no byte reached any store"
    );
    assert!(
        account_files.find_file("/Notes/new.txt").is_err(),
        "no record was written"
    );
    // Bound to this folder: it writes.
    let bound = origins_bound(&account_files, Some("100:1.000000001"));
    account_files
        .write_file("/Notes/new.txt", b"sent", "text/plain", &bound)
        .unwrap();
    assert_eq!(held.objects.lock().unwrap().len(), before + 1);
    // A deliberate move or rebind: the same store bound to the new folder's identity writes from there.
    let mut moved = account_files.at_home("300:3.000000003".into());
    assert!(moved
        .write_file("/Notes/moved.txt", b"after the move", "text/plain", &bound)
        .is_err());
    let rebound = origins_bound(&moved, Some("300:3.000000003"));
    moved
        .write_file(
            "/Notes/moved.txt",
            b"after the move",
            "text/plain",
            &rebound,
        )
        .unwrap();
}

#[test]
fn a_loopback_store_takes_new_bytes_from_any_folder_and_a_account_files_with_no_folder_is_not_held_to_one(
) {
    let (account_files, held, _) = kept();
    let mut origins = origins_bound(&account_files, None);
    for (_, origin) in &mut origins {
        origin.reach.endpoint =
            live_namespace::account_files::objects::Source::Value("http://127.0.0.1:9".into());
        assert!(origin.is_loopback());
    }
    held.refuse.lock().unwrap().push("cloudflare-r2".into());
    let mut at_home = account_files.at_home("100:1.000000001".into());
    at_home
        .write_file("/Notes/loop.txt", b"on loopback", "text/plain", &origins)
        .unwrap();
    let (free, held, _) = kept();
    let mut free = free;
    held.refuse.lock().unwrap().push("cloudflare-r2".into());
    let real = origins_bound(&free, None);
    assert!(real.iter().all(|(_, origin)| !origin.is_loopback()));
    free.write_file("/Notes/free.txt", b"an operator tool", "text/plain", &real)
        .unwrap();
}

/// One tool call of the contract, answered or refused.
fn call(
    account_files: &mut AccountFiles,
    tool: &str,
    input: Value,
) -> Result<Value, live_namespace::account_files::AccountFilesError> {
    account_files
        .call(tool, &input)
        .expect("an account's files tool")
}

/// Every name in `folder`, in name order.
fn names_in(account_files: &AccountFiles, folder: &str) -> Vec<String> {
    let page = account_files.list_files(Some(folder), None, None, None).unwrap();
    page["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap().to_owned())
        .collect()
}

/// The person's rows, counting every change made through them.
struct Counted {
    rows: Store,
    applied: Arc<std::sync::atomic::AtomicUsize>,
}
impl live_namespace::store::Rows for Counted {
    fn get(&self, scope: &str, id: &str) -> Result<live_namespace::store::Read, live_namespace::store::Error> { self.rows.get(scope, id) }
    fn get_many(&self, scope: &str, ids: &[&str]) -> Result<Vec<Option<live_namespace::store::Record>>, live_namespace::store::Error> { self.rows.get_many(scope, ids) }
    fn get_scoped(&self, pairs: &[(&str, &str)]) -> Result<Vec<Option<live_namespace::store::Record>>, live_namespace::store::Error> { self.rows.get_scoped(pairs) }
    fn held_record_with_version(&self, scope: &str, id: &str) -> Result<(i64, Option<live_namespace::store::Record>), live_namespace::store::Error> { self.rows.held_record_with_version(scope, id) }
    fn list_page(&self, scope: &str, after: &str, limit: usize) -> Result<live_namespace::store::Page<live_namespace::store::Record, String>, live_namespace::store::Error> { self.rows.list_page(scope, after, limit) }
    fn ids(&self, scope: &str, after: Option<&str>, limit: usize) -> Result<(Vec<String>, Option<String>), live_namespace::store::Error> { self.rows.ids(scope, after, limit) }
    fn mutate(&self, scope: &str, input: Mutation) -> Result<live_namespace::store::Change, live_namespace::store::Error> {
        let change = self.rows.mutate(scope, input)?;
        self.applied.fetch_add(1, Ordering::SeqCst);
        Ok(change)
    }
    fn stamp(&self, scope: &str) -> Result<i64, live_namespace::store::Error> { self.rows.stamp(scope) }
    fn totals(&self) -> Result<Vec<live_namespace::store::Total>, live_namespace::store::Error> { self.rows.totals() }
    fn search(&self, words: &[String], hits: usize) -> Result<Vec<live_namespace::store::Record>, live_namespace::store::Error> { self.rows.search(words, hits) }
    fn place(&self) -> String { self.rows.place() }
    fn order(&self) -> Result<i64, live_namespace::store::Error> { self.rows.order() }
    fn changes(&self, prefixes: &[&str], after: i64, limit: usize) -> Result<live_namespace::store::Page<live_namespace::store::Changed, i64>, live_namespace::store::Error> { self.rows.changes(prefixes, after, limit) }
    fn minted(&self, prefixes: &[&str], minted: i64) -> Result<Option<(String, live_namespace::store::Record)>, live_namespace::store::Error> { self.rows.minted(prefixes, minted) }
    fn wait_for_order(&self, after: i64, until: std::time::Instant) -> Result<i64, live_namespace::store::Error> { self.rows.wait_for_order(after, until) }
}

/// Empty rows holding one origin, and the count of the changes made through them since.
fn counted_rows(origin_request: String) -> (Store, Arc<std::sync::atomic::AtomicUsize>) {
    let applied = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let store: Store = Arc::new(Counted { rows: Arc::new(SqlStore::memory().unwrap()), applied: applied.clone() });
    store.mutate("@namespace/origins", Mutation {
        id: "origin".into(), expected_version: 0, request_key: origin_request, deleted: false,
        value: json!({"kind":"namespace-origin","rank":1,"takes_new_bytes":true,"file_key_prefix":"files/",
            "reach":{"key_id":{"value":"synthetic"},"secret":{"held":"synthetic"},"bucket":{"value":"synthetic"},
                "endpoint":{"value":"http://127.0.0.1:9"},"region":{"value":"synthetic"}}}),
    }).unwrap();
    (store, applied)
}

/// A checker that is current until `target - 1` more changes have been made after this call, so the change numbered `target`
/// (counting from the first after the call) is the first one a stopped caller stops.
fn revoke_on_account_files_commit(
    applied: Arc<std::sync::atomic::AtomicUsize>,
    target: usize,
) -> (Arc<AtomicBool>, Arc<dyn Fn() -> bool + Send + Sync>) {
    let current = Arc::new(AtomicBool::new(true));
    let from = applied.load(Ordering::SeqCst);
    let checker = {
        let current = current.clone();
        Arc::new(move || {
            if applied.load(Ordering::SeqCst) - from + 1 >= target {
                current.store(false, Ordering::SeqCst);
            }
            current.load(Ordering::SeqCst)
        })
    };
    (current, checker)
}

#[test]
fn find_names_pages_the_names_of_a_folder_that_start_with_a_prefix() {
    let (mut account_files, ..) = kept();
    let found = call(
        &mut account_files,
        "find_names",
        json!({"prefix": "/Notes/a"}),
    )
    .unwrap();
    assert_eq!(found["names"].as_array().unwrap().len(), 1);
    assert_eq!(found["names"][0]["name"], "/Notes/a.txt");
    assert_eq!(found["names"][0]["media_type"], "text/plain");
    let exact = call(
        &mut account_files,
        "find_names",
        json!({"prefix": "/Notes/a.txt"}),
    )
    .unwrap();
    assert_eq!(
        exact["names"][0]["name"], "/Notes/a.txt",
        "a name equal to the prefix is found"
    );
    let first = call(
        &mut account_files,
        "find_names",
        json!({"prefix": "/Notes/", "limit": 1}),
    )
    .unwrap();
    assert_eq!(first["names"][0]["name"], "/Notes/a.txt");
    assert_eq!(first["next_after"], "/Notes/a.txt");
    let second = call(
        &mut account_files,
        "find_names",
        json!({"prefix": "/Notes/", "after": "/Notes/a.txt", "limit": 1}),
    )
    .unwrap();
    assert_eq!(second["names"][0]["name"], "/Notes/b.txt");
    assert_eq!(second["next_after"], Value::Null);
    assert_eq!(
        call(
            &mut account_files,
            "find_names",
            json!({"prefix": "/Notes/z"})
        )
        .unwrap()["names"],
        json!([])
    );
    assert!(call(&mut account_files, "find_names", json!({"prefix": "Notes"})).is_err());
}

#[test]
fn move_names_carries_a_whole_folder_in_bounded_pages_and_leaves_nothing_behind() {
    let (mut account_files, _, video) = kept();
    let mut pages = Vec::new();
    let mut after = Value::Null;
    loop {
        let moved = call(
            &mut account_files,
            "move_names",
            json!({"from": "/Recordings", "to": "/Archive/Recordings", "after": after, "limit": 2}),
        )
        .unwrap();
        pages.push((
            moved["names"].as_u64().unwrap(),
            moved["folders"].as_u64().unwrap(),
        ));
        after = moved["next_after"].clone();
        if after.is_null() {
            break;
        }
    }
    // The walk: the name, then day, player, club and Recordings themselves, at most two steps a call.
    assert_eq!(pages, [(1, 1), (0, 2), (0, 1)]);
    let moved = "/Archive/Recordings/club/player/day/C6637.MP4";
    assert_eq!(
        names_in(&account_files, "/Archive/Recordings/club/player/day"),
        [moved]
    );
    assert_eq!(
        account_files.find_file(moved).unwrap()["names"],
        json!([moved]),
        "the file lists its new name only"
    );
    assert_eq!(
        account_files.find_file(moved).unwrap()["identity"],
        json!(id(&video))
    );
    assert!(matches!(
        account_files.find_file("/Recordings/club/player/day/C6637.MP4"),
        Err(live_namespace::account_files::AccountFilesError::NotFound(_))
    ));
    assert_eq!(
        account_files.list_files(Some("/"), None, None, None).unwrap()["folders"],
        json!(["/Archive", "/Notes"])
    );
    assert_eq!(
        account_files
            .list_files(Some("/Archive"), None, None, None)
            .unwrap()["folders"],
        json!(["/Archive/Recordings"])
    );
    assert_eq!(
        account_files.read_file(moved, 990, Some(20)).unwrap()["bytes_returned"],
        20,
        "the bytes did not move"
    );
    assert_eq!(account_files.files_summary().unwrap()["names"], 3);
    // A carry that already finished has nothing left to carry.
    assert!(matches!(
        call(
            &mut account_files,
            "move_names",
            json!({"from": "/Recordings", "to": "/Elsewhere"})
        ),
        Err(live_namespace::account_files::AccountFilesError::NotFound(_))
    ));
}

#[test]
fn copy_names_resumes_after_its_last_step_and_keeps_the_source() {
    let (mut account_files, ..) = kept();
    let mut after = Value::Null;
    let mut calls = 0;
    loop {
        let copied = call(
            &mut account_files,
            "copy_names",
            json!({"from": "/Notes", "to": "/Kept/Notes", "after": after, "limit": 1}),
        )
        .unwrap();
        calls += 1;
        after = copied["next_after"].clone();
        if after.is_null() {
            break;
        }
    }
    assert_eq!(calls, 3, "a.txt, b.txt, then the folder");
    assert_eq!(
        names_in(&account_files, "/Notes"),
        ["/Notes/a.txt", "/Notes/b.txt"]
    );
    assert_eq!(
        names_in(&account_files, "/Kept/Notes"),
        ["/Kept/Notes/a.txt", "/Kept/Notes/b.txt"]
    );
    assert_eq!(
        account_files.find_file("/Notes/a.txt").unwrap()["names"],
        json!([
            "/Kept/Notes/a.txt",
            "/Kept/Notes/b.txt",
            "/Notes/a.txt",
            "/Notes/b.txt"
        ])
    );
    assert_eq!(account_files.files_summary().unwrap()["names"], 5);
    assert_eq!(
        account_files.files_summary().unwrap()["files"],
        2,
        "a copy is one more name, not one more file"
    );
    // Copying again changes nothing: every name is already there, naming the same file.
    let again = call(
        &mut account_files,
        "copy_names",
        json!({"from": "/Notes", "to": "/Kept/Notes"}),
    )
    .unwrap();
    assert_eq!(again["names"], 2);
    assert_eq!(account_files.files_summary().unwrap()["names"], 5);
}

#[test]
fn a_carry_never_replaces_a_name_of_another_file_and_never_goes_into_itself() {
    let (mut account_files, ..) = kept();
    let origins = account_files.origins().unwrap();
    account_files
        .write_file("/Other/a.txt", b"another file", "text/plain", &origins)
        .unwrap();
    let refused = call(
        &mut account_files,
        "copy_names",
        json!({"from": "/Notes/a.txt", "to": "/Other/a.txt"}),
    );
    assert!(
        matches!(
            refused,
            Err(live_namespace::account_files::AccountFilesError::Invalid(_, _))
        ),
        "{refused:?}"
    );
    assert_eq!(
        account_files.read_file("/Other/a.txt", 0, None).unwrap()["content"],
        "another file"
    );
    // A name that already names the same file is already carried: the move only removes the source.
    call(
        &mut account_files,
        "move_names",
        json!({"from": "/Notes/a.txt", "to": "/Notes/b.txt"}),
    )
    .unwrap();
    assert_eq!(names_in(&account_files, "/Notes"), ["/Notes/b.txt"]);
    assert_eq!(
        account_files.find_file("/Notes/b.txt").unwrap()["names"],
        json!(["/Notes/b.txt"])
    );
    // The name a move left is free again: writing it names the tombstone the move left.
    account_files
        .write_file(
            "/Notes/a.txt",
            b"written after the move",
            "text/plain",
            &origins,
        )
        .unwrap();
    assert_eq!(
        account_files.read_file("/Notes/a.txt", 0, None).unwrap()["content"],
        "written after the move"
    );
    for (from, to) in [
        ("/Notes", "/Notes/inner"),
        ("/Notes", "/Notes"),
        ("/", "/x"),
        ("/Notes", "Notes2"),
    ] {
        let into = call(
            &mut account_files,
            "move_names",
            json!({"from": from, "to": to}),
        );
        assert!(
            matches!(
                into,
                Err(live_namespace::account_files::AccountFilesError::Invalid(_, _))
            ),
            "{from} -> {to}: {into:?}"
        );
    }
    assert!(matches!(
        call(
            &mut account_files,
            "move_names",
            json!({"from": "/Missing", "to": "/Elsewhere"})
        ),
        Err(live_namespace::account_files::AccountFilesError::NotFound(_))
    ));
}

#[test]
fn set_aside_moves_names_out_of_the_account_files_and_put_back_returns_them() {
    let (mut account_files, ..) = kept();
    call(
        &mut account_files,
        "set_aside",
        json!({"name": "/Notes/a.txt"}),
    )
    .unwrap();
    assert_eq!(names_in(&account_files, "/Notes"), ["/Notes/b.txt"]);
    assert_eq!(
        account_files.find_file("/Notes/b.txt").unwrap()["names"],
        json!(["/Notes/b.txt"]),
        "a name set aside is not listed"
    );
    assert_eq!(account_files.files_summary().unwrap()["names"], 2);
    let aside = call(
        &mut account_files,
        "list_set_aside",
        json!({"folder": "/Notes"}),
    )
    .unwrap();
    assert_eq!(aside["names"][0]["name"], "/Notes/a.txt");
    assert_eq!(aside["names"][0]["stored"], true, "its file is still kept");
    // A whole folder: its names and the folder itself.
    call(
        &mut account_files,
        "set_aside",
        json!({"name": "/Recordings"}),
    )
    .unwrap();
    assert_eq!(
        account_files.list_files(Some("/"), None, None, None).unwrap()["folders"],
        json!(["/Notes"])
    );
    assert_eq!(
        call(&mut account_files, "list_set_aside", json!({})).unwrap()["folders"],
        json!(["/Notes", "/Recordings"])
    );
    call(
        &mut account_files,
        "put_back",
        json!({"name": "/Recordings"}),
    )
    .unwrap();
    call(
        &mut account_files,
        "put_back",
        json!({"name": "/Notes/a.txt"}),
    )
    .unwrap();
    assert_eq!(
        names_in(&account_files, "/Notes"),
        ["/Notes/a.txt", "/Notes/b.txt"]
    );
    assert_eq!(
        names_in(&account_files, "/Recordings/club/player/day"),
        ["/Recordings/club/player/day/C6637.MP4"]
    );
    assert_eq!(
        account_files.find_file("/Notes/a.txt").unwrap()["names"],
        json!(["/Notes/a.txt", "/Notes/b.txt"])
    );
    assert_eq!(account_files.files_summary().unwrap()["names"], 3);
    assert_eq!(
        call(
            &mut account_files,
            "list_set_aside",
            json!({"folder": "/Notes"})
        )
        .unwrap()["names"],
        json!([])
    );
    assert!(
        matches!(
            call(
                &mut account_files,
                "put_back",
                json!({"name": "/Notes/a.txt"})
            ),
            Err(live_namespace::account_files::AccountFilesError::NotFound(_))
        ),
        "nothing is set aside there now"
    );
}

#[test]
fn a_carry_out_of_time_takes_no_step_and_answers_where_to_resume() {
    let (account_files, ..) = kept();
    let mut account_files = account_files.until(std::time::Instant::now());
    let late = call(
        &mut account_files,
        "move_names",
        json!({"from": "/Notes", "to": "/Later"}),
    )
    .unwrap();
    assert_eq!(
        (late["names"].as_u64(), late["folders"].as_u64()),
        (Some(0), Some(0))
    );
    assert_eq!(
        late["next_after"], "",
        "not done: the next call starts where this one was asked to"
    );
    assert_eq!(
        names_in(&account_files, "/Notes"),
        ["/Notes/a.txt", "/Notes/b.txt"]
    );
}

/// The actual SQLite writer lock witnesses the account files record commitment
/// boundary, rather than an admission callback or a guessed callback ordinal.
#[test]
fn account_files_run_lifetime_is_rechecked_before_each_record_commit() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use live_namespace::account_files::{names_scope, FILES};
    for revoke in [false, true] {
        let store: Store = Arc::new(SqlStore::memory().unwrap());
        let bytes = Arc::new(Held::default());
        let capability = Arc::new(AtomicBool::new(true));
        if revoke {
            // The byte store has taken the object; the caller stops being current before the records that name it.
            *bytes.revoke_after_write.lock().unwrap() = Some(capability.clone());
        }
        let checker: Arc<dyn Fn() -> bool + Send + Sync> = {
            let capability = capability.clone();
            Arc::new(move || capability.load(Ordering::SeqCst))
        };
        let mut account_files =
            AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(bytes.clone())))
                .while_current(checker);
        let origins: Vec<(String, Origin)> = serde_json::from_value(json!([["stand-in", {
            "kind":"namespace-origin", "rank":1, "takes_new_bytes":true, "file_key_prefix":"files/",
            "reach":{"key_id":{"value":"synthetic"},"secret":{"held":"synthetic"},
                "bucket":{"value":"synthetic"},"endpoint":{"value":"http://127.0.0.1:1"},"region":{"value":"synthetic"}}
        }]])).unwrap();
        let answer =
            account_files.write_file("/boundary/note.txt", b"kept bytes", "text/plain", &origins);
        assert_eq!(
            bytes.objects.lock().unwrap().len(),
            1,
            "earlier accepted bytes are not undone"
        );
        let files = account_files
            .store
            .list_page(FILES, "", 100)
            .unwrap();
        let names = account_files
            .store
            .list_page(&names_scope("/boundary"), "", 100)
            .unwrap();
        if revoke {
            assert!(answer.is_err());
            assert!(
                files.items.is_empty() && names.items.is_empty(),
                "the refused record step wrote nothing"
            );
        } else {
            assert!(answer.is_ok(), "{answer:?}");
            assert_eq!(files.items.len(), 1);
            assert_eq!(names.items.len(), 1);
        }
    }
}

#[test]
fn account_files_expired_call_sends_no_bytes_and_writes_no_records() {
    use std::time::Instant;
    use live_namespace::account_files::FILES;
    let store: Store = Arc::new(SqlStore::memory().unwrap());
    let held = Arc::new(Held::default());
    let mut account_files =
        AccountFiles::with_objects(store, ACCOUNT, Box::new(Port(held.clone())))
            .until(Instant::now());
    assert!(account_files
        .write_file("/expired.txt", b"secret", "text/plain", &[])
        .is_err());
    assert!(held.objects.lock().unwrap().is_empty());
    assert!(account_files
        .store
        .list_page(FILES, "", 100)
        .unwrap()
        .items
        .is_empty());
}

// Recent files and kept file facts (src/account_files/recent.rs): ported from old trillion src/recent-files.mjs and
// the old results facts merge, on the account's own rows.

#[test]
fn a_use_by_any_name_or_identity_is_one_row_per_file_with_each_kinds_newest_time() {
    let (mut account_files, ..) = kept();
    // Pin the wall clock so this exercises several accepted uses within one millisecond.
    account_files = account_files.with_clock(Arc::new(|| 1_800_000_000_000));
    let note = call(
        &mut account_files,
        "find_file",
        json!({"name_or_identity": "/Notes/a.txt"}),
    )
    .unwrap()["identity"]
        .clone();
    let first = call(
        &mut account_files,
        "record_file_use",
        json!({"file": "/Notes/a.txt", "kind": "opened"}),
    )
    .unwrap();
    assert_eq!(first["recorded"], true);
    assert_eq!(first["file"]["last_words"], "Opened");
    let again = call(
        &mut account_files,
        "record_file_use",
        json!({"file": "/Notes/b.txt", "kind": "sent-to-a-client"}),
    )
    .unwrap();
    assert_eq!(
        again["file"]["identity"], note,
        "two names of one file are one row"
    );
    assert_eq!(
        again["file"]["last_words"], "Sent to a client",
        "a kind with no words row reads as itself"
    );
    let video = format!("12:{}", "a".repeat(64));
    call(
        &mut account_files,
        "record_file_use",
        json!({"file": video, "kind": "watched"}),
    )
    .unwrap();
    let recent = call(&mut account_files, "recent_files", json!({})).unwrap();
    let items = recent["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "{recent}");
    assert_eq!(items[0]["last_kind"], "watched", "newest first");
    assert_ne!(
        items[0]["identity"], video,
        "an alias is kept under the file's own identity"
    );
    assert_eq!(items[1]["identity"], note);
    assert!(
        items[1]["kinds"]["opened"].is_string()
            && items[1]["kinds"]["sent-to-a-client"].is_string(),
        "{recent}"
    );
    assert_eq!(recent["said"], "2 files used, newest first.");
    let page = call(&mut account_files, "recent_files", json!({"limit": 1})).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let older = call(
        &mut account_files,
        "recent_files",
        json!({"limit": 1, "before": page["next_before"]}),
    )
    .unwrap();
    assert_eq!(older["items"][0]["identity"], note, "{older}");
    assert!(
        call(
            &mut account_files,
            "record_file_use",
            json!({"file": "/Notes/none.txt", "kind": "opened"})
        )
        .is_err(),
        "not in the files"
    );
    assert!(
        call(
            &mut account_files,
            "record_file_use",
            json!({"file": "/Notes/a.txt", "kind": "Opened!"})
        )
        .is_err(),
        "a kind is one short word"
    );
    assert!(call(
        &mut account_files,
        "record_file_use",
        json!({"file": "/Notes/a.txt"})
    )
    .is_err());
}

#[test]
fn recent_order_keeps_sequential_uses_newest_first_when_the_clock_moves_backwards() {
    let (account_files, ..) = kept();
    let now = Arc::new(std::sync::atomic::AtomicU64::new(1_800_000_000_000));
    let clock = {
        let now = now.clone();
        Arc::new(move || now.load(Ordering::SeqCst))
    };
    let mut account_files = account_files.with_clock(clock);
    account_files.record_file_use("/Notes/a.txt", "opened").unwrap();
    account_files.record_file_use("/Notes/b.txt", "edited").unwrap();
    now.store(1_799_999_999_000, Ordering::SeqCst);
    account_files
        .record_file_use("/Notes/a.txt", "sent-to-a-client")
        .unwrap();

    let recent = account_files.recent_files(None, None).unwrap();
    assert_eq!(recent["items"][0]["last_kind"], "sent-to-a-client");
    assert_eq!(recent["items"][0]["last_at"], "2027-01-15T07:59:59.000Z");
    assert!(recent["items"][0]["kinds"]["opened"].is_string());
    assert!(recent["items"][0]["kinds"]["edited"].is_string());
}

#[test]
fn a_renamed_file_reads_by_its_name_now_and_the_calls_keep_their_uses() {
    let (mut account_files, ..) = kept();
    let empty = call(&mut account_files, "recent_files", json!({})).unwrap();
    assert_eq!(empty["said"], "No files used yet.");
    let origins = account_files.origins().unwrap();
    let wrote = account_files.write_file("/Made/cut.txt", b"a cut", "text/plain", &origins);
    // `write_file` by its own name keeps no use; the call of that name does.
    assert!(wrote.is_ok());
    assert_eq!(
        call(&mut account_files, "recent_files", json!({})).unwrap()["items"],
        json!([])
    );
    let read = call(
        &mut account_files,
        "read_file",
        json!({"name_or_identity": "/Notes/a.txt", "offset": 3}),
    )
    .unwrap();
    assert!(read.get("recent_use_not_kept").is_none());
    assert_eq!(
        call(&mut account_files, "recent_files", json!({})).unwrap()["items"],
        json!([]),
        "a read past the start keeps no use"
    );
    call(
        &mut account_files,
        "read_file",
        json!({"name_or_identity": "/Notes/a.txt"}),
    )
    .unwrap();
    let recent = call(&mut account_files, "recent_files", json!({})).unwrap();
    assert_eq!(recent["items"][0]["last_kind"], "opened", "{recent}");
    call(
        &mut account_files,
        "move_names",
        json!({"from": "/Notes/a.txt", "to": "/Kept/a.txt"}),
    )
    .unwrap();
    call(
        &mut account_files,
        "move_names",
        json!({"from": "/Notes/b.txt", "to": "/Kept/b.txt"}),
    )
    .unwrap();
    let recent = call(&mut account_files, "recent_files", json!({})).unwrap();
    let name = recent["items"][0]["name"].as_str().unwrap();
    assert!(name.starts_with("/Kept/"), "{recent}");
    assert_eq!(
        recent["items"][0]["title"],
        name.rsplit('/').next().unwrap()
    );
}

#[test]
fn past_keep_files_the_one_used_longest_ago_leaves_first() {
    let (mut account_files, ..) = kept();
    let data: Value = serde_json::from_str(include_str!(
        "../src/account_files/account-files-routes.json"
    ))
    .unwrap();
    let keep = data["recent"]["keep"].as_u64().unwrap() as usize;
    let origins = account_files.origins().unwrap();
    for at in 0..=keep {
        let name = format!("/Many/{at:05}.txt");
        account_files
            .write_file(&name, name.as_bytes(), "text/plain", &origins)
            .unwrap();
        account_files.record_file_use(&name, "opened").unwrap();
    }
    let mut seen = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let page = account_files
            .recent_files(Some(500), before.as_deref())
            .unwrap();
        seen.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["name"].as_str().unwrap().to_owned()),
        );
        match page["next_before"].as_str() {
            Some(next) => before = Some(next.to_owned()),
            None => break,
        }
    }
    assert_eq!(seen.len(), keep, "at most keep files are held");
    assert_eq!(
        seen.first().map(String::as_str),
        Some(format!("/Many/{keep:05}.txt").as_str()),
        "newest first"
    );
    assert!(
        !seen.contains(&"/Many/00000.txt".to_owned()),
        "the one used longest ago left"
    );
}

#[test]
fn facts_are_the_results_merge_of_kind_facts_and_any_identity_of_a_file_reaches_one_result() {
    // Old trillion src/file-tools.mjs:135: set_file_facts is POST /namespace/results/<identity>/merge {kind: 'facts'},
    // and read_file_results with kind facts reads them (src/namespace-results.mjs:424 `merge`).
    let (mut account_files, _, video) = kept();
    let alias = format!("12:{}", "a".repeat(64));
    let set = call(&mut account_files, "set_file_facts", json!({"identity": alias, "facts": {"camera": "Synthetic camera", "duration": 12}, "produced_by": "fixture"})).unwrap();
    assert_eq!(set["changed"], true);
    assert_eq!(set["kind"], "facts");
    assert_eq!(
        set["kept_under"], alias,
        "no result held yet: kept under the asked identity (old `held?.identity ?? identity`)"
    );
    let set = call(
        &mut account_files,
        "set_file_facts",
        json!({"identity": id(&video), "facts": {"duration": null, "client": "Synthetic client"}}),
    )
    .unwrap();
    assert_eq!(
        set["kept_under"], alias,
        "the file's other identity changes the one result already held: {set}"
    );
    assert_eq!(
        set["value"],
        json!({"camera": "Synthetic camera", "client": "Synthetic client"}),
        "{set}"
    );
    let same = call(
        &mut account_files,
        "set_file_facts",
        json!({"identity": alias, "facts": {"client": "Synthetic client"}}),
    )
    .unwrap();
    assert_eq!(
        same["changed"], false,
        "the same facts again change nothing"
    );
    for identity in [alias.clone(), id(&video)] {
        let read = call(
            &mut account_files,
            "read_file_results",
            json!({"identity": identity, "kind": "facts"}),
        )
        .unwrap();
        let results = read["results"].as_array().unwrap();
        assert_eq!(
            results.len(),
            1,
            "one result whichever identity reads it: {read}"
        );
        assert_eq!(
            results[0]["value"],
            json!({"camera": "Synthetic camera", "client": "Synthetic client"})
        );
        assert_eq!(
            results[0]["produced_by"],
            Value::Null,
            "the last merge named no producer"
        );
    }
    let counts = call(&mut account_files, "list_file_results", json!({})).unwrap();
    assert_eq!(
        counts["kinds"]["facts"], 1,
        "one facts result, not one per identity: {counts}"
    );
    let none = call(
        &mut account_files,
        "read_file_results",
        json!({"identity": format!("1f:{}", "b".repeat(64)), "kind": "facts"}),
    )
    .unwrap();
    assert_eq!(
        none["results"],
        json!([]),
        "a file with no facts reads none"
    );
    assert!(
        account_files
            .call("read_file_facts", &json!({"identity": alias}))
            .is_none(),
        "no second read of facts: read_file_results reads them"
    );
    assert!(
        call(
            &mut account_files,
            "set_file_facts",
            json!({"identity": "/Notes/a.txt", "facts": {}})
        )
        .is_err(),
        "an identity, as the old tool took"
    );
    assert!(
        call(
            &mut account_files,
            "set_file_facts",
            json!({"identity": alias, "facts": [1]})
        )
        .is_err(),
        "facts are an object"
    );
}
