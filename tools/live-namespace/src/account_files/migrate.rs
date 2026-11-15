// src/account_files/migrate.rs
//
// Purpose: The one-way move of an account's files' file list from the hosted Worker's RecordBook tables (a restored SQLite
// copy) into record store records, in the layout `mod.rs` describes. The bytes stay where they are: every record keeps the
// store (`origin`) and key the Worker wrote.
//
// Non-Negotiable Invariants:
// - The source is a quiescent clone opened read-only and immutable through the storage boundary
//   (`sqlite::open_pinned` over the `worker_namespace` families, `families.json` here); nothing here writes it and no
//   SQL is written here.
// - Every source family is read in key pages (`READ_PAGE` rows a scan), never in one read.
// - Records are written with `RecordStore::import`, one write scope per batch, into a new store; an id that already exists
//   refuses its batch (a migration never overwrites).
// - The report compares every migrated count with the source's own counts, and the digest of every record as it was
//   built from the source with the digest of every record read back from the store (BLAKE3 over the sorted hashes of
//   scope, id and value); any mismatch is a failed migration.
//
// Key Concepts:
// - `Plan`: the account, its stores (the app's origin settings rows and the credential-name prefix of this host), and
//   the clone to read.
// - Aliases, and each file's names, are gathered first in memory (63,700 aliases and 182,797 names on the largest
//   account), so each file record is written once with its aliases and names.
//
// Security Considerations:
// - No credential value is read: origin records hold vault names only.
// - The report holds counts and timings, never a name or an identity.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    folders_scope, names_scope, objects::{Origin, Reach, Source}, parent, ALIASES, ALIAS_KIND, CHUNKS, CHUNK_KIND, FILES,
    FILE_KIND, FOLDER_KIND, NAME_KIND, ORIGINS, ORIGIN_KIND, SPANS, SPANS_KIND, UPLOADS, UPLOAD_KIND,
};
use content_crypto::advanced::blake3;
use crate::{
    records::Records,
    storage::{
        record_store::RecordStore,
        sqlite::{self, Spend},
        Bound, Order, Range, Read as Field, Storage, Value as Stored,
    },
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    time::{Duration, Instant},
};

/// The schema of a restored Worker account files book (`families.json`).
pub const SOURCE_SCHEMA: &str = "worker_namespace";
/// Rows one source scan reads.
const READ_PAGE: usize = 2000;
/// Records one import call writes (one record store write scope).
const WRITE_BATCH: usize = 1000;

type Failure = Box<dyn std::error::Error>;

/// What to migrate.
pub struct Plan {
    pub account: String,
    /// The app's origin settings records (`kind: cloud-files.origin-settings`: `origin_id`, `rank`, `settings`).
    pub origin_settings: Vec<Value>,
    /// The prefix of the vault names the account's store keys are held under: `<prefix><origin id>-<fact>` (fact =
    /// key-id, application-key, bucket, endpoint, region) for each fact the origin settings do not hold.
    pub credential_prefix: String,
}

/// Source and migrated counts, and how long each step took.
#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub source: BTreeMap<&'static str, u64>,
    pub migrated: BTreeMap<&'static str, u64>,
    pub seconds: BTreeMap<&'static str, f64>,
    /// BLAKE3 over the sorted record hashes of every record as the migration built it from the source.
    pub written_digest: String,
    /// The same digest over every record read back from the store, scope by scope.
    pub readback_digest: String,
    pub readback_records: u64,
}
impl Report {
    /// Every migrated count equals its source count, and every record reads back equal to what was written.
    pub fn proved(&self) -> bool {
        !self.source.is_empty()
            && self.source.iter().all(|(what, count)| self.migrated.get(what) == Some(count))
            && !self.written_digest.is_empty()
            && self.written_digest == self.readback_digest
    }
}

/// Open a restored Worker account files book (a clone) through the storage boundary: read-only and immutable, no journal,
/// no write.
pub fn open_source(path: &Path) -> Result<impl Storage, Failure> {
    let bounds = sqlite::Bounds {
        value_bytes: 64 * 1024 * 1024,
        work: u64::MAX / 2,
        deadline: Duration::MAX,
        spend: Spend::EachOperation,
        cancel: None,
        busy: Duration::from_secs(5),
    };
    Ok(sqlite::open_pinned(path, SOURCE_SCHEMA, bounds)?)
}

/// The store records of the account's origins: every fact the app's settings hold is a value, every other fact is a
/// vault name; new whole files are kept beside the account's newest chunk (`people/<person>/files/`, from
/// `newest_chunk_key`).
pub fn origin_records(plan: &Plan, newest_chunk_key: &str) -> Result<Vec<(String, Value)>, Failure> {
    let person = newest_chunk_key.rsplit_once("/chunks/").map(|(person, _)| person).ok_or(crate::refusal_cause::CodedError::new("a chunk key without a chunks folder"))?;
    let file_key_prefix = format!("{person}/files/");
    plan.origin_settings
        .iter()
        .map(|row| {
            let id = row["origin_id"].as_str().ok_or(crate::refusal_cause::CodedError::new("origin settings without origin_id"))?.to_owned();
            let rank = row["rank"].as_u64().ok_or(crate::refusal_cause::CodedError::new("origin settings without rank"))? as u32;
            let settings = &row["settings"];
            let fact = |field: &str, credential: &str| match settings.get(field).and_then(Value::as_str) {
                Some(value) => Source::Value(value.into()),
                None => Source::Held(format!("{}{id}-{credential}", plan.credential_prefix)),
            };
            let origin = Origin {
                kind: ORIGIN_KIND.into(),
                rank,
                // An origin the app's settings mark as taking no new files takes no new bytes here either.
                takes_new_bytes: row.get("takes_new_bytes").and_then(Value::as_bool).unwrap_or(true),
                file_key_prefix: file_key_prefix.clone(),
                bound_to: None,
                reach: Reach {
                    key_id: Source::Held(format!("{}{id}-key-id", plan.credential_prefix)),
                    secret: Source::Held(format!("{}{id}-application-key", plan.credential_prefix)),
                    bucket: fact("bucket", "bucket"),
                    endpoint: fact("endpoint", "endpoint"),
                    region: fact("region", "region"),
                },
            };
            Ok((id, serde_json::to_value(origin).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?))
        })
        .collect()
}

/// What the migration wrote: one BLAKE3 hash per record (scope, id and the value's JSON bytes) and every scope it
/// wrote, so the store can be read back and compared.
#[derive(Default)]
struct Ledger {
    hashes: Vec<[u8; 32]>,
    scopes: BTreeSet<String>,
}
fn record_hash(resource: &str, id: &str, value: &Value) -> Result<[u8; 32], Failure> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(resource.as_bytes()).update(&[0]).update(id.as_bytes()).update(&[0]).update(&serde_json::to_vec(value).map_err(|error| { let cause = crate::refusal_cause::Caused::cause(&error); crate::refusal_cause::CodedError::with_cause(error, cause) })?);
    Ok(*hasher.finalize().as_bytes())
}
fn digest(mut hashes: Vec<[u8; 32]>) -> String {
    hashes.sort_unstable();
    let mut hasher = blake3::Hasher::new();
    for hash in &hashes {
        hasher.update(hash);
    }
    hasher.finalize().to_hex().to_string()
}

/// Import records into one scope in write batches; answers how many were written.
fn import<S: Storage>(store: &mut RecordStore<S>, ledger: &mut Ledger, account: &str, resource: &str, records: &mut Vec<(String, Value)>) -> Result<u64, Failure> {
    let mut written = 0u64;
    for batch in records.chunks(WRITE_BATCH) {
        written += store.import(account, resource, batch)? as u64;
    }
    for (id, value) in records.iter() {
        ledger.hashes.push(record_hash(resource, id, value)?);
    }
    if !records.is_empty() {
        ledger.scopes.insert(resource.to_owned());
    }
    records.clear();
    Ok(written)
}

/// Read every record of every scope the migration wrote back from the store, in pages, and digest them.
fn read_back<S: Storage + Send>(store: &RecordStore<S>, account: &str, scopes: &BTreeSet<String>) -> Result<(String, u64), Failure> {
    let mut hashes = Vec::new();
    for resource in scopes {
        let mut after = String::new();
        loop {
            let page = store.list_page(account, resource, &after, crate::records::MAX_PAGE_ITEMS)?;
            for record in &page.items {
                hashes.push(record_hash(resource, &record.id, &record.value)?);
            }
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
    }
    let count = hashes.len() as u64;
    Ok((digest(hashes), count))
}

/// Read a whole source family in key pages through the boundary, `fields` in that order for each row. The family's
/// key fields must be among `fields` (the page cursor is their values).
pub fn pages(source: &dyn Storage, family: &str, fields: &[&str], mut each: impl FnMut(Vec<Stored>) -> Result<(), Failure>) -> Result<u64, Failure> {
    let key = &source.schema().family(family)?.key;
    let at: Vec<usize> = key.iter().map(|name| fields.iter().position(|field| field == name).ok_or(crate::refusal_cause::CodedError::new("a page cursor field is not read"))).collect::<Result<_, _>>()?;
    let read: Vec<Field<'_>> = fields.iter().map(|field| Field::whole(field)).collect();
    let (mut after, mut total): (Option<Vec<Stored>>, u64) = (None, 0);
    loop {
        let range = Range { order: Order::Key, from: after.take().map_or(Bound::Unbounded, Bound::Excluded), to: Bound::Unbounded, reverse: false, limit: Some(READ_PAGE) };
        let rows = source.scan(family, &range, &read)?;
        let seen = rows.len();
        for row in rows {
            after = Some(at.iter().map(|at| row.0[*at].clone()).collect());
            each(row.0)?;
        }
        total += seen as u64;
        if seen < READ_PAGE {
            return Ok(total);
        }
    }
}

/// The rows of one key prefix of a source family (all ordinals of a file's spans, for example).
pub fn rows_of(source: &dyn Storage, family: &str, from: &[Stored], to: &[Stored], fields: &[&str]) -> Result<Vec<Vec<Stored>>, Failure> {
    let read: Vec<Field<'_>> = fields.iter().map(|field| Field::whole(field)).collect();
    let range = Range { order: Order::Key, from: Bound::Included(from.to_vec()), to: Bound::Included(to.to_vec()), reverse: false, limit: None };
    Ok(source.scan(family, &range, &read)?.into_iter().map(|row| row.0).collect())
}

/// A source value as JSON.
pub fn json_of(value: &Stored) -> Value {
    match value {
        Stored::Integer(number) => json!(number),
        Stored::Real(number) => json!(number),
        Stored::Text(text) => json!(text),
        Stored::Null | Stored::Blob(_) | Stored::Oversized(_) => Value::Null,
    }
}
/// A source value's text.
pub fn text_of(value: &Stored) -> Option<String> {
    value.as_text().map(str::to_owned)
}

/// Migrate the account files of `plan.account` from `source` into `store` and prove the counts.
pub fn migrate<S: Storage + Send>(
    source: &dyn Storage,
    store: &mut RecordStore<S>,
    plan: &Plan,
    mut progress: impl FnMut(&str, u64),
) -> Result<Report, Failure> {
    let account = plan.account.as_str();
    let mut report = Report::default();
    let mut ledger = Ledger::default();
    let count = |family: &str| -> Result<u64, Failure> { Ok(source.count(family, &Range::all())?) };
    report.source.insert("origins", plan.origin_settings.len() as u64);
    report.source.insert("chunks", count("namespace_chunks")?);
    report.source.insert("aliases", count("namespace_aliases")?);
    report.source.insert("names", count("namespace_names")?);
    report.source.insert("files", count("namespace_files")?);
    // Span lists and uploads in progress are counted on the source rows as they are read (a file with spans, an
    // upload not finished); folders have no source family: every collection and its ancestors.

    // Chunks: one record per chunk, its store and key; the newest chunk's key names where new files are kept.
    let started = Instant::now();
    let (mut batch, mut written) = (Vec::new(), 0);
    let mut newest: Option<(String, String)> = None;
    pages(source, "namespace_chunks", &["chunk", "byte_length", "origin", "key", "stored_at"], |row| {
        if let (Some(stored_at), Some(key)) = (text_of(&row[4]), text_of(&row[3])) {
            if newest.as_ref().is_none_or(|(held, _)| *held < stored_at) {
                newest = Some((stored_at, key));
            }
        }
        batch.push((text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("chunk id"))?, json!({
            "kind": CHUNK_KIND, "byte_length": json_of(&row[1]), "origin": json_of(&row[2]), "key": json_of(&row[3]), "stored_at": json_of(&row[4]),
        })));
        if batch.len() >= WRITE_BATCH {
            written += import(store, &mut ledger, account, CHUNKS, &mut batch)?;
        }
        Ok(())
    })?;
    written += import(store, &mut ledger, account, CHUNKS, &mut batch)?;
    progress("chunks", written);
    report.migrated.insert("chunks", written);
    report.seconds.insert("chunks", started.elapsed().as_secs_f64());

    // Origins.
    let started = Instant::now();
    let (_, newest_key) = newest.ok_or(crate::refusal_cause::CodedError::new("the source holds no chunk to place new files beside"))?;
    let mut origins = origin_records(plan, &newest_key)?;
    report.migrated.insert("origins", import(store, &mut ledger, account, ORIGINS, &mut origins)?);
    report.seconds.insert("origins", started.elapsed().as_secs_f64());

    // Aliases: records, and in memory alias -> file and file -> aliases.
    let started = Instant::now();
    let mut written = 0;
    let mut alias_of: HashMap<String, String> = HashMap::new();
    let mut aliases_of: HashMap<String, Vec<Value>> = HashMap::new();
    pages(source, "namespace_aliases", &["alias", "identity", "grade", "added_at"], |row| {
        let alias = text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("alias id"))?;
        let identity = text_of(&row[1]).ok_or(crate::refusal_cause::CodedError::new("alias identity"))?;
        aliases_of.entry(identity.clone()).or_default().push(json!({ "alias": alias, "grade": json_of(&row[2]) }));
        batch.push((alias.clone(), json!({ "kind": ALIAS_KIND, "identity": identity, "grade": json_of(&row[2]), "added_at": json_of(&row[3]) })));
        alias_of.insert(alias, identity);
        if batch.len() >= WRITE_BATCH {
            written += import(store, &mut ledger, account, ALIASES, &mut batch)?;
        }
        Ok(())
    })?;
    written += import(store, &mut ledger, account, ALIASES, &mut batch)?;
    progress("aliases", written);
    report.migrated.insert("aliases", written);
    report.seconds.insert("aliases", started.elapsed().as_secs_f64());

    // Names: grouped by folder (one scope per folder), and in memory file -> names, and every folder with its
    // ancestors.
    let started = Instant::now();
    let mut names_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_folder: BTreeMap<String, Vec<(String, Value)>> = BTreeMap::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    let mut written = 0;
    pages(source, "namespace_names", &["name", "collection", "identity", "byte_length", "modified_at_ms", "named_at"], |row| {
        let name = text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("name"))?;
        let collection = text_of(&row[1]).ok_or(crate::refusal_cause::CodedError::new("collection"))?;
        if collection != parent(&name) {
            return Err(crate::refusal_cause::CodedError::new("a name whose collection is not its parent folder").into());
        }
        let identity = text_of(&row[2]);
        let file = identity.as_ref().map(|identity| alias_of.get(identity).cloned().unwrap_or_else(|| identity.clone()));
        if let Some(file) = &file {
            names_of.entry(file.clone()).or_default().push(name.clone());
        }
        let mut folder = collection.clone();
        while folder != "/" && folders.insert(folder.clone()) {
            folder = parent(&folder).to_owned();
        }
        by_folder.entry(collection).or_default().push((name.clone(), json!({
            "kind": NAME_KIND, "name": name, "identity": json_of(&row[2]), "file": file, "byte_length": json_of(&row[3]),
            "modified_at_ms": json_of(&row[4]), "named_at": json_of(&row[5]),
        })));
        Ok(())
    })?;
    for (folder, records) in &mut by_folder {
        written += import(store, &mut ledger, account, &names_scope(folder), records)?;
    }
    progress("names", written);
    report.migrated.insert("names", written);
    report.seconds.insert("names", started.elapsed().as_secs_f64());

    // Folders: every folder that holds a name or a folder, in its parent's scope.
    let started = Instant::now();
    report.source.insert("folders", folders.len() as u64);
    let mut by_parent: BTreeMap<String, Vec<(String, Value)>> = BTreeMap::new();
    for folder in &folders {
        by_parent.entry(parent(folder).to_owned()).or_default().push((folder.clone(), json!({ "kind": FOLDER_KIND, "folder": folder })));
    }
    let mut written = 0;
    for (parent_folder, records) in &mut by_parent {
        written += import(store, &mut ledger, account, &folders_scope(parent_folder), records)?;
    }
    report.migrated.insert("folders", written);
    report.seconds.insert("folders", started.elapsed().as_secs_f64());

    // Files, with their aliases and names, and the spans of chunked files.
    let started = Instant::now();
    let (mut files, mut spans, mut files_written, mut spans_written, mut chunked) = (Vec::new(), Vec::new(), 0, 0, 0u64);
    let mut page: Vec<(String, Value)> = Vec::new();
    let mut flush = |page: &mut Vec<(String, Value)>, files: &mut Vec<(String, Value)>, spans: &mut Vec<(String, Value)>| -> Result<(), Failure> {
        let (Some(first), Some(last)) = (page.first().map(|(id, _)| id.clone()), page.last().map(|(id, _)| id.clone())) else { return Ok(()) };
        let mut held: HashMap<String, Vec<Value>> = HashMap::new();
        let rows = rows_of(source, "namespace_spans", &[Stored::Text(first)], &[Stored::Text(last)], &["file", "offset", "length", "chunk"])?;
        for row in rows {
            let file = text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("span file"))?;
            held.entry(file).or_default().push(json!({ "offset": json_of(&row[1]), "length": json_of(&row[2]), "chunk": json_of(&row[3]) }));
        }
        for (identity, value) in page.drain(..) {
            let count = value["spans"].as_u64().unwrap_or(0);
            if count > 0 {
                chunked += 1;
                let list = held.remove(&identity).unwrap_or_default();
                if list.len() as u64 != count {
                    return Err(crate::refusal_cause::CodedError::new("a file whose span count differs from its spans").into());
                }
                spans.push((identity.clone(), json!({ "kind": SPANS_KIND, "spans": list })));
            }
            files.push((identity, value));
        }
        Ok(())
    };
    pages(
        source,
        "namespace_files",
        &["identity", "byte_length", "media_type", "origin", "key", "part_bytes", "stored_at", "checked_at", "spans", "prefix_identity"],
        |row| {
            let identity = text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("file identity"))?;
            let mut names = names_of.remove(&identity).unwrap_or_default();
            names.sort_unstable();
            let value = json!({
                "kind": FILE_KIND, "byte_length": json_of(&row[1]), "media_type": json_of(&row[2]), "origin": json_of(&row[3]),
                "key": json_of(&row[4]), "part_bytes": json_of(&row[5]), "stored_at": json_of(&row[6]), "checked_at": json_of(&row[7]),
                "spans": json_of(&row[8]), "prefix_identity": json_of(&row[9]),
                "aliases": aliases_of.remove(&identity).unwrap_or_default(), "names": names,
            });
            page.push((identity, value));
            if page.len() >= READ_PAGE {
                flush(&mut page, &mut files, &mut spans)?;
                files_written += import(store, &mut ledger, account, FILES, &mut files)?;
                spans_written += import(store, &mut ledger, account, SPANS, &mut spans)?;
                progress("files", files_written);
            }
            Ok(())
        },
    )?;
    flush(&mut page, &mut files, &mut spans)?;
    files_written += import(store, &mut ledger, account, FILES, &mut files)?;
    spans_written += import(store, &mut ledger, account, SPANS, &mut spans)?;
    progress("files", files_written);
    report.migrated.insert("files", files_written);
    report.source.insert("spans_records", chunked);
    report.migrated.insert("spans_records", spans_written);
    report.seconds.insert("files", started.elapsed().as_secs_f64());

    // Uploads the Worker was still receiving when it stopped.
    let started = Instant::now();
    let mut unfinished = 0u64;
    pages(
        source,
        "namespace_growing",
        &["growing", "byte_length", "media_type", "origin", "started_at", "bytes_held", "app", "finished"],
        |row| {
            if !matches!(row[7], Stored::Null) {
                return Ok(());
            }
            unfinished += 1;
            batch.push((text_of(&row[0]).ok_or(crate::refusal_cause::CodedError::new("upload id"))?, json!({
                "kind": UPLOAD_KIND, "byte_length": json_of(&row[1]), "media_type": json_of(&row[2]), "origin": json_of(&row[3]),
                "started_at": json_of(&row[4]), "bytes_held": json_of(&row[5]), "app": json_of(&row[6]),
            })));
            Ok(())
        },
    )?;
    let written = import(store, &mut ledger, account, UPLOADS, &mut batch)?;
    report.source.insert("uploads", unfinished);
    report.migrated.insert("uploads", written);
    report.seconds.insert("uploads", started.elapsed().as_secs_f64());

    // Read every written scope back and compare digests.
    let started = Instant::now();
    progress("read back", 0);
    let (readback_digest, readback_records) = read_back(store, account, &ledger.scopes)?;
    report.readback_digest = readback_digest;
    report.readback_records = readback_records;
    report.written_digest = digest(ledger.hashes);
    report.seconds.insert("read_back", started.elapsed().as_secs_f64());
    Ok(report)
}
