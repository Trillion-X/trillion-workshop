// examples/account_files_prove.rs
//
// Purpose: Prove the local account files route on a migrated store: the contract's reads (list_files at the root and in a
// deep folder with a second page, find_file by name and by identity, files_summary) and ranged reads of real bytes
// from each store, with the reads every call made.
// Invariants: reads only. Byte reads are ranged and small: a whole small object whose BLAKE3 must equal its identity,
// one small chunk whose BLAKE3 must equal its chunk id, the 16-byte header of a large video and a 64 KiB window across
// its first chunk boundary; never a whole large object (B2 egress costs money). The clone is opened read-only only to
// choose those small objects.
// Key concepts: `account_files::AccountFiles`, `account_files::objects::{Objects, S3Objects}`, the secrets vault
// (`secrets`), record store `work()` counters.
// Security: requests are signed through the secrets vault, which keeps the secret (it answers SigV4 day keys
// only); output holds names, identities, sizes and counts.
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
//
// Usage: account_files_prove RECORD_STORE_SQLITE CLONE_SQLITE ACCOUNT DEEP_NAME

use serde_json::{json, Value};
use content_crypto::advanced::blake3;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc,
    },
    time::Instant,
};
use trillion_local::{
    secrets::{self, SecretsKey, Secrets as Vault, KeychainItem, VaultIdentity},
    account_files::{
        migrate::{open_source, pages, rows_of},
        objects::{Body, Listing, ObjectError, Objects, Origin, S3Objects, Stat},
        parent, AccountFiles, FILES, ORIGINS,
    },
    records::{Records, MAX_PAGE_ITEMS},
    sqlite_work::WorkMeter,
    storage::{record_store_resources, Value as Stored},
};


/// The byte port, counting the store requests and bytes each call makes (shared with the proof, which reads the
/// counts around each call).
struct Counted {
    inner: S3Objects,
    requests: AtomicU64,
    bytes: AtomicU64,
}
struct Shared(Arc<Counted>);
impl Objects for Shared {
    /// The inner port is shared with the proof's counts, and is unmetered by name; this proof sets it no deadline.
    fn set_control(&mut self, _: trillion_local::account_files::CallControl) {}
    fn read(&self, origin: &str, key: &str, offset: u64, length: u64) -> Result<Vec<u8>, ObjectError> {
        self.0.requests.fetch_add(1, Relaxed);
        let bytes = self.0.inner.read(origin, key, offset, length)?;
        self.0.bytes.fetch_add(bytes.len() as u64, Relaxed);
        Ok(bytes)
    }
    fn write(&self, origin: &str, key: &str, bytes: &[u8], media_type: &str) -> Result<(), ObjectError> {
        self.0.requests.fetch_add(1, Relaxed);
        self.0.inner.write(origin, key, bytes, media_type)
    }
    fn write_stream(&self, origin: &str, key: &str, body: Body<'_>, media_type: &str) -> Result<(), ObjectError> {
        self.0.requests.fetch_add(1, Relaxed);
        self.0.inner.write_stream(origin, key, body, media_type)
    }
    fn stat(&self, origin: &str, key: &str) -> Result<Option<Stat>, ObjectError> {
        self.0.requests.fetch_add(1, Relaxed);
        self.0.inner.stat(origin, key)
    }
    fn list(&self, origin: &str, prefix: &str, after: &str, limit: usize) -> Result<Listing, ObjectError> {
        self.0.requests.fetch_add(1, Relaxed);
        self.0.inner.list(origin, prefix, after, limit)
    }
}

type Failure = Box<dyn std::error::Error>;

fn run() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [store_path, clone, account, deep] = args.as_slice() else {
        return Err("usage: account_files_prove RECORD_STORE_SQLITE CLONE_SQLITE ACCOUNT DEEP_NAME".into());
    };
    let store_path = std::fs::canonicalize(store_path)?;
    let store = record_store_resources::open(&store_path, WorkMeter::new())?;
    // The vault is a second record store view of the same store file; it touches only its own resource.
    // The vault exactly as the product opens it (src/main.rs connect-service): the Mac account key named by the
    // product's account-key settings, and the product's identity word (product DATA identity.json) as the vault identity word.
    let kept = KeychainItem::shipped()?;
    let root = SecretsKey::from_keychain(&kept)?;
    let naming = VaultIdentity::new(trillion_local::account_files::identity::word()?)
        .map_err(|error| error.code_string().to_owned())?;
    let vault = Vault::open(secrets::open_store(&store_path)?, account, &root, naming)?;
    let origins: Vec<(String, Origin)> = store
        .list_page(account, ORIGINS, "", MAX_PAGE_ITEMS)?
        .items
        .into_iter()
        .map(|record| Ok((record.id, serde_json::from_value(record.value)?)))
        .collect::<Result<_, serde_json::Error>>()?;
    let inner = S3Objects::unmetered(origins.clone(), Box::new(vault), "operator example account_files_prove")?;
    let present: Vec<Value> =
        origins.iter().map(|(id, _)| json!({ "origin": id, "credentials_held": inner.has_credentials(id).unwrap_or(false) })).collect();
    let counter = Arc::new(Counted { inner, requests: AtomicU64::new(0), bytes: AtomicU64::new(0) });
    let account_files = AccountFiles::with_objects(store, account, Box::new(Shared(counter.clone())));

    let mut proofs = Vec::new();
    let mut step = |label: &str, account_files: &AccountFiles<_>, call: &dyn Fn(&AccountFiles<_>) -> Result<Value, Failure>| {
        let before = account_files.store.work();
        let (requests, bytes) = (counter.requests.load(Relaxed), counter.bytes.load(Relaxed));
        let started = Instant::now();
        let answer = call(account_files);
        let after = account_files.store.work();
        let work = json!({
            "s2h_seeks": after.seeks - before.seeks, "s2h_rows_read": after.rows_read - before.rows_read,
            "store_requests": counter.requests.load(Relaxed) - requests, "store_bytes": counter.bytes.load(Relaxed) - bytes,
            "ms": started.elapsed().as_secs_f64() * 1000.0,
        });
        proofs.push(match answer {
            Ok(answer) => json!({ "step": label, "work": work, "answer": answer }),
            Err(error) => json!({ "step": label, "work": work, "error": error.to_string() }),
        });
    };

    step("list_files / (limit 100)", &account_files, &|ns| {
        let page = ns.list_files(Some("/"), None, Some(100))?;
        Ok(json!({ "names": page["names"].as_array().map(Vec::len), "folders": page["folders"], "next_after": page["next_after"] }))
    });
    step("list_files /Recordings (limit 100)", &account_files, &|ns| {
        let page = ns.list_files(Some("/Recordings"), None, Some(100))?;
        Ok(json!({ "names": page["names"].as_array().map(Vec::len), "folders": page["folders"], "next_after": page["next_after"] }))
    });
    let player = "/Recordings/ethos_school_of_tennis/01_player_swings/Example Player";
    step("list_files player folder, page 1 (limit 100)", &account_files, &|ns| {
        let page = ns.list_files(Some(player), None, Some(100))?;
        Ok(json!({ "names": page["names"].as_array().map(Vec::len), "folders": page["folders"].as_array().map(Vec::len), "first_folders": page["folders"].as_array().map(|folders| folders.iter().take(3).cloned().collect::<Vec<_>>()), "next_after": page["next_after"] }))
    });
    let deep_folder = parent(deep).to_owned();
    step("list_files deep folder, page 1 (limit 100)", &account_files, &|ns| {
        let page = ns.list_files(Some(&deep_folder), None, Some(100))?;
        Ok(json!({ "collection": page["collection"], "names": page["names"].as_array().map(Vec::len), "first": page["names"][0], "next_after": page["next_after"] }))
    });
    let next = account_files.list_files(Some(&deep_folder), None, Some(100))?["next_after"].as_str().map(str::to_owned);
    if let Some(next) = next {
        step("list_files deep folder, page 2 (limit 100)", &account_files, &|ns| {
            let page = ns.list_files(Some(&deep_folder), Some(&next), Some(100))?;
            Ok(json!({ "names": page["names"].as_array().map(Vec::len), "folders": page["folders"], "next_after": page["next_after"] }))
        });
    }
    // The largest folder of the copy (61,486 names in /Documents): pages 1 and 2 of 100, and a page deep inside it.
    for (label, after) in [("page 1", None), ("page 2", Some(1usize)), ("page after 30,000 names", Some(300))] {
        step(&format!("list_files /Documents, {label} (limit 100)"), &account_files, &|ns| {
            let mut cursor: Option<String> = None;
            for _ in 0..after.unwrap_or(0) {
                cursor = ns.list_files(Some("/Documents"), cursor.as_deref(), Some(100))?["next_after"].as_str().map(str::to_owned);
            }
            let before = ns.store.work();
            let page = ns.list_files(Some("/Documents"), cursor.as_deref(), Some(100))?;
            let after = ns.store.work();
            Ok(json!({
                "names": page["names"].as_array().map(Vec::len), "folders": page["folders"].as_array().map(Vec::len),
                "first": page["names"][0]["name"], "next_after": page["next_after"],
                "this_page_only": { "s2h_seeks": after.seeks - before.seeks, "s2h_rows_read": after.rows_read - before.rows_read },
            }))
        });
    }
    step("find_file by name (B2 tennis source)", &account_files, &|ns| Ok(ns.find_file(deep)?));
    let identity = account_files.find_file(deep)?["identity"].as_str().unwrap_or_default().to_owned();
    step("find_file by identity", &account_files, &|ns| {
        let row = ns.find_file(&identity)?;
        Ok(json!({ "identity": row["identity"], "origin": row["origin"], "byte_length": row["byte_length"], "spans": row["spans"], "names": row["names"] }))
    });
    step("files_summary", &account_files, &|ns| Ok(ns.files_summary()?));
    step("read_file tennis video, 16 bytes at 0 (MP4 header)", &account_files, &|ns| {
        let read = ns.read_file(deep, 0, Some(16))?;
        Ok(json!({ "bytes_returned": read["bytes_returned"], "encoding": read["encoding"], "content": read["content"] }))
    });

    // Small real objects chosen from the clone (read-only, through the storage boundary), so the bytes can be checked
    // against their content identity.
    let clone = open_source(&PathBuf::from(clone))?;
    let video = Stored::Text(identity.clone());
    let tennis_spans = rows_of(&clone, "namespace_spans", std::slice::from_ref(&video), std::slice::from_ref(&video), &["file", "offset"])?;
    let span_edge = tennis_spans.get(1).and_then(|row| row[1].as_integer()).ok_or("the video has a second span")?;
    step("read_file tennis video, 64 KiB across the first chunk boundary", &account_files, &|ns| {
        let read = ns.read_file(&identity, span_edge as u64 - 32_768, Some(65_536))?;
        Ok(json!({ "offset": read["offset"], "bytes_returned": read["bytes_returned"] }))
    });
    for origin in ["backblaze-b2", "cloudflare-r2"] {
        // A whole-file object of 200 B to 4 KiB, and a one-span file of 200 B to 64 KiB, both in this store.
        let mut whole: Option<(String, i64)> = None;
        let mut chunked: Option<(String, i64)> = None;
        pages(&clone, "namespace_files", &["identity", "byte_length", "origin", "spans"], |row| {
            let (Some(id), Some(size), Some(store), Some(spans)) = (row[0].as_text(), row[1].as_integer(), row[2].as_text(), row[3].as_integer()) else { return Ok(()) };
            if store == origin && spans == 0 && (200..=4096).contains(&size) && whole.is_none() {
                whole = Some((id.to_owned(), size));
            }
            if store == origin && spans == 1 && (200..=65_536).contains(&size) && chunked.is_none() {
                chunked = Some((id.to_owned(), size));
            }
            Ok(())
        })?;
        if let Some((whole, whole_size)) = whole {
            step(&format!("read whole small {origin} object, BLAKE3 equals identity"), &account_files, &|ns| {
                let file = ns.store.get(account, FILES, &whole)?.record.ok_or("file record")?;
                let bytes = ns.read_range(&file, 0, whole_size as u64)?;
                let computed = format!("1f:{}", blake3::hash(&bytes).to_hex());
                Ok(json!({ "identity": whole, "byte_length": whole_size, "bytes_read": bytes.len(), "blake3_matches_identity": computed == whole }))
            });
        }
        if let Some((file_id, size)) = chunked {
            let key = Stored::Text(file_id.clone());
            let span = rows_of(&clone, "namespace_spans", std::slice::from_ref(&key), std::slice::from_ref(&key), &["file", "chunk"])?;
            let chunk = span.first().and_then(|row| row[1].as_text()).ok_or("the file's span")?.to_owned();
            step(&format!("read one small {origin} chunk (a one-span file), BLAKE3 equals its chunk id"), &account_files, &|ns| {
                let file = ns.store.get(account, FILES, &file_id)?.record.ok_or("file record")?;
                let bytes = ns.read_range(&file, 0, size as u64)?;
                Ok(json!({ "file": file_id, "length": size, "chunk": chunk, "blake3_matches_chunk": format!("1f:{}", blake3::hash(&bytes).to_hex()) == chunk }))
            });
        }
    }
    println!("{}", serde_json::to_string_pretty(&json!({ "origins": present, "proofs": proofs }))?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("account_files_prove: {error}");
        std::process::exit(1);
    }
}
