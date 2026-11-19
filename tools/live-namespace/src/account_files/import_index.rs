// src/account_files/import_index.rs
//
// Purpose: Bring the index an earlier store of the person's files kept (its tables exported as NDJSON, one file per
// `<table>__<NNNNNN>.ndjson`, each line one row) into this store's rows, so every name the person had opens again here,
// read from the same bytes where they already lie. Nothing is copied or read back: the earlier store's chunks are objects
// in the person's own byte store under the keys its chunk rows name, and those keys are carried as they are (a chunk row
// keeps its own key and its origin, src/account_files/write.rs), so a read of an imported file fetches exactly the
// objects the earlier store would have fetched. The rows go in through the store's own `add_new` (src/store/mod.rs): a
// row this store holds already, or removed, is left as it is, so the import may run again and changes nothing the second
// time.
//
// Non-Negotiable Invariants:
// - A file comes in only when its spans prove it: ordinals 0..n with no gap, each span starting where the one before
//   ended, the last ending at the file's length, each span between 1 byte and the chunk layout's most bytes, and each
//   span's chunk a row of the export of exactly the span's length. A file with no spans comes in only with an object key
//   of its own (or with no bytes at all). Any other file, and every name of it, is left out and counted with its reason.
// - A name comes in only when it is a valid name here (write.rs `validate_name`) and its file comes in.
// - Rows are added in the order chunks, span pages, files, folders, names, each batch in its own transaction, so a name
//   is never visible before everything it reads is there, even if the import stops midway.
// - Only `origin`, the id of an origin row of this store (`@namespace/origins`), is written as where the bytes are. The
//   earlier store's own origin labels are not this store's origin rows and are never carried.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{folders_scope, names_scope, paged_spans, parent, CHUNKS, CHUNK_KIND, FILES, FILE_KIND, FOLDER_KIND, NAME_KIND, SPANS, SPANS_KIND};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::BufRead,
    path::Path,
};

/// The earlier store's tables this reads, by the name their export files start with.
const CHUNK_TABLE: &str = "namespace_chunks";
const SPAN_TABLE: &str = "namespace_spans";
const FILE_TABLE: &str = "namespace_files";
const NAME_TABLE: &str = "namespace_names";

/// What an import found: how many of each kind of row it makes, and what it left out and why (each reason with how many).
#[derive(Debug, Default, serde::Serialize)]
pub struct Found {
    pub names: u64,
    pub files: u64,
    pub chunks: u64,
    pub span_pages: u64,
    pub folders: u64,
    pub bytes: u64,
    pub left_out: BTreeMap<String, u64>,
}

struct OldFile {
    byte_length: u64,
    media_type: Value,
    key: String,
    stored_at: Value,
    checked_at: Value,
}

/// Every row of `table` in the export `folder`, in file order.
fn each_row(folder: &Path, table: &str, mut take: impl FnMut(Value)) -> Result<(), String> {
    let mut files: Vec<_> = std::fs::read_dir(folder)
        .map_err(|_| "the export folder cannot be read".to_owned())?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(&format!("{table}__")) && name.ends_with(".ndjson"))
        .collect();
    files.sort();
    for name in files {
        let file = std::fs::File::open(folder.join(&name)).map_err(|_| format!("{name} cannot be read"))?;
        for line in std::io::BufReader::new(file).lines() {
            let line = line.map_err(|_| format!("{name} cannot be read"))?;
            if line.trim().is_empty() {
                continue;
            }
            take(serde_json::from_str(&line).map_err(|_| format!("a line of {name} is not JSON"))?);
        }
    }
    Ok(())
}

fn text(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn is_identity(text: &str) -> bool {
    text.len() == 67 && text.starts_with("1f:") && text[3..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The rows the export in `folder` makes in this store, with its bytes at the origin row `origin`, and what was found. With
/// `under`, only names in that folder (or below it) come in, and only what they read.
pub fn rows_of_export(folder: &Path, origin: &str, under: Option<&str>) -> Result<(Vec<(String, String, Value)>, Found), String> {
    let mut found = Found::default();
    let left = |reason: &str, found: &mut Found| *found.left_out.entry(reason.to_owned()).or_default() += 1;

    let mut chunks: HashMap<String, (u64, String, Value)> = HashMap::new();
    each_row(folder, CHUNK_TABLE, |row| {
        if let (Some(chunk), Some(length), Some(key)) = (text(&row, "chunk"), row["byte_length"].as_u64(), text(&row, "key")) {
            chunks.insert(chunk, (length, key, row["stored_at"].clone()));
        }
    })?;
    let mut spans: HashMap<String, Vec<(u64, u64, u64, String)>> = HashMap::new();
    each_row(folder, SPAN_TABLE, |row| {
        if let (Some(file), Some(ordinal), Some(offset), Some(length), Some(chunk)) =
            (text(&row, "file"), row["ordinal"].as_u64(), row["offset"].as_u64(), row["length"].as_u64(), text(&row, "chunk"))
        {
            spans.entry(file).or_default().push((ordinal, offset, length, chunk));
        }
    })?;
    let mut files: HashMap<String, OldFile> = HashMap::new();
    each_row(folder, FILE_TABLE, |row| {
        if let (Some(identity), Some(byte_length)) = (text(&row, "identity"), row["byte_length"].as_u64()) {
            files.insert(identity, OldFile {
                byte_length,
                media_type: row["media_type"].clone(),
                key: text(&row, "key").unwrap_or_default(),
                stored_at: row["stored_at"].clone(),
                checked_at: row["checked_at"].clone(),
            });
        }
    })?;
    let mut names: Vec<Value> = Vec::new();
    each_row(folder, NAME_TABLE, |row| names.push(row))?;

    // Which files their spans prove, each with its spans in order (empty for a file kept as one object).
    let most = paged_spans::most_span_bytes(paged_spans::CHUNKS_LAYOUT);
    let mut proved: HashMap<String, Result<Vec<(u64, u64, u64, String)>, &'static str>> = HashMap::new();
    let prove = |identity: &str| -> Result<Vec<(u64, u64, u64, String)>, &'static str> {
        let file = files.get(identity).ok_or("its file is not in the export")?;
        let mut held = spans.get(identity).cloned().unwrap_or_default();
        if held.is_empty() {
            return if !file.key.is_empty() || file.byte_length == 0 { Ok(held) } else { Err("its file has neither spans nor an object key") };
        }
        held.sort_by_key(|span| span.0);
        let mut next = 0;
        for (at, (ordinal, offset, length, chunk)) in held.iter().enumerate() {
            if *ordinal != at as u64 || *offset != next || *length == 0 || *length > most || !is_identity(chunk) {
                return Err("its file's spans do not cover it in order");
            }
            match chunks.get(chunk) {
                Some((chunk_length, _, _)) if chunk_length == length => {}
                Some(_) => return Err("a chunk of its file is not the length its span says"),
                None => return Err("a chunk of its file is not in the export"),
            }
            next += length;
        }
        if next != file.byte_length {
            return Err("its file's spans do not end at its length");
        }
        Ok(held)
    };

    let mut taken_names: Vec<(String, String, Value)> = Vec::new();
    let mut names_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    let under = under.map(|under| under.trim_end_matches('/').to_owned());
    for row in &names {
        let (Some(name), Some(identity)) = (text(row, "name"), text(row, "identity")) else {
            left("a name row without a name or identity", &mut found);
            continue;
        };
        if under.as_ref().is_some_and(|under| !name.starts_with(&format!("{under}/"))) {
            continue;
        }
        if super::write::validate_name(&name).is_err() {
            left("the name is not a valid name here", &mut found);
            continue;
        }
        if let Err(reason) = proved.entry(identity.clone()).or_insert_with(|| prove(&identity)) {
            left(reason, &mut found);
            continue;
        }
        let byte_length = files.get(&identity).map_or(0, |file| file.byte_length);
        taken_names.push((names_scope(parent(&name)), name.clone(), json!({
            "kind": NAME_KIND, "name": name, "identity": identity, "file": identity, "byte_length": byte_length,
            "modified_at_ms": row["modified_at_ms"], "named_at": row["named_at"],
        })));
        names_of.entry(identity).or_default().push(name.clone());
        let mut folder = parent(&name).to_owned();
        while folder != "/" && folders.insert(folder.clone()) {
            folder = parent(&folder).to_owned();
        }
    }

    let (mut chunk_rows, mut page_rows, mut file_rows) = (Vec::new(), Vec::new(), Vec::new());
    let mut chunks_taken: BTreeSet<String> = BTreeSet::new();
    for (identity, names) in &names_of {
        let Some(Ok(held)) = proved.get(identity) else { continue };
        let file = &files[identity];
        found.files += 1;
        found.bytes += file.byte_length;
        let mut value = json!({
            "kind": FILE_KIND, "byte_length": file.byte_length, "media_type": file.media_type, "origin": origin,
            "key": if held.is_empty() { file.key.clone() } else { String::new() },
            "stored_at": file.stored_at, "checked_at": file.checked_at, "spans": held.len(), "aliases": [], "names": names,
        });
        if !held.is_empty() {
            value["span_layout"] = json!(paged_spans::CHUNKS_LAYOUT);
            value["span_set"] = json!(identity);
        }
        file_rows.push((FILES.to_owned(), identity.clone(), value));
        for (page, group) in held.chunks(paged_spans::SPANS_PER_PAGE as usize).enumerate() {
            let start = group[0].1;
            let end = group.last().map_or(start, |span| span.1 + span.2);
            let listed: Vec<Value> = group.iter().map(|(ordinal, offset, length, chunk)| json!({
                "ordinal": ordinal, "offset": offset, "length": length, "chunk": chunk,
            })).collect();
            page_rows.push((SPANS.to_owned(), paged_spans::page_id(identity, page as u64), json!({
                "kind": SPANS_KIND, "layout": paged_spans::CHUNKS_LAYOUT, "set": identity, "page": page,
                "start_offset": start, "end_offset": end, "spans": listed,
            })));
            for (_, _, _, chunk) in group {
                if chunks_taken.insert(chunk.clone()) {
                    let (length, key, stored_at) = &chunks[chunk];
                    chunk_rows.push((CHUNKS.to_owned(), chunk.clone(), json!({
                        "kind": CHUNK_KIND, "byte_length": length, "origin": origin, "key": key, "stored_at": stored_at,
                    })));
                }
            }
        }
    }
    let folder_rows: Vec<_> = folders.iter().map(|folder| (folders_scope(parent(folder)), folder.clone(), json!({"kind": FOLDER_KIND, "folder": folder}))).collect();
    found.names = taken_names.len() as u64;
    found.chunks = chunk_rows.len() as u64;
    found.span_pages = page_rows.len() as u64;
    found.folders = folder_rows.len() as u64;
    let mut rows = chunk_rows;
    rows.extend(page_rows);
    rows.extend(file_rows);
    rows.extend(folder_rows);
    rows.extend(taken_names);
    Ok((rows, found))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(folder: &Path, table: &str, rows: &[Value]) {
        let text: String = rows.iter().map(|row| format!("{row}\n")).collect();
        std::fs::write(folder.join(format!("{table}__000000.ndjson")), text).unwrap();
    }

    fn id(n: u8) -> String {
        format!("1f:{}", format!("{n:02x}").repeat(32))
    }

    #[test]
    fn a_file_comes_in_only_when_its_spans_prove_it_and_its_names_and_folders_come_with_it() {
        let folder = tempfile::tempdir().unwrap();
        let (good, gap, lone) = (id(1), id(2), id(3));
        write(folder.path(), CHUNK_TABLE, &[
            json!({"chunk": id(10), "byte_length": 5, "key": "old/chunks/a", "stored_at": "t"}),
            json!({"chunk": id(11), "byte_length": 4, "key": "old/chunks/b", "stored_at": "t"}),
        ]);
        write(folder.path(), SPAN_TABLE, &[
            json!({"file": good, "ordinal": 1, "offset": 5, "length": 4, "chunk": id(11)}),
            json!({"file": good, "ordinal": 0, "offset": 0, "length": 5, "chunk": id(10)}),
            json!({"file": gap, "ordinal": 0, "offset": 0, "length": 5, "chunk": id(10)}),
            json!({"file": gap, "ordinal": 2, "offset": 5, "length": 4, "chunk": id(11)}),
        ]);
        write(folder.path(), FILE_TABLE, &[
            json!({"identity": good, "byte_length": 9, "media_type": "video/mp4", "key": "", "stored_at": "t", "checked_at": "t"}),
            json!({"identity": gap, "byte_length": 9, "media_type": "video/mp4", "key": "", "stored_at": "t", "checked_at": "t"}),
            json!({"identity": lone, "byte_length": 3, "media_type": "text/plain", "key": "old/files/lone", "stored_at": "t", "checked_at": "t"}),
        ]);
        write(folder.path(), NAME_TABLE, &[
            json!({"name": "/Tennis/serve.mp4", "identity": good, "modified_at_ms": 7, "named_at": "n"}),
            json!({"name": "/Tennis/Old/broken.mp4", "identity": gap, "named_at": "n"}),
            json!({"name": "/Notes/a.txt", "identity": lone, "named_at": "n"}),
            json!({"name": "/Notes/missing.txt", "identity": id(4), "named_at": "n"}),
        ]);
        let (rows, found) = rows_of_export(folder.path(), "computer", None).unwrap();
        assert_eq!((found.names, found.files, found.chunks, found.span_pages, found.folders, found.bytes), (2, 2, 2, 1, 2, 12));
        assert_eq!(found.left_out["its file's spans do not cover it in order"], 1);
        assert_eq!(found.left_out["its file is not in the export"], 1);
        let row = |scope: &str, id: &str| rows.iter().find(|row| row.0 == scope && row.1 == id).map(|row| row.2.clone());
        let file = row(FILES, &good).unwrap();
        assert_eq!((file["spans"].as_u64(), file["span_set"].as_str(), file["origin"].as_str()), (Some(2), Some(good.as_str()), Some("computer")));
        let page = row(SPANS, &paged_spans::page_id(&good, 0)).unwrap();
        assert_eq!(paged_spans::parse_variable_page(&page, &good, 0).unwrap().len(), 2);
        assert_eq!(row(CHUNKS, &id(11)).unwrap()["key"], "old/chunks/b");
        assert_eq!(row(FILES, &lone).unwrap()["key"], "old/files/lone");
        assert_eq!(row(&names_scope("/Tennis"), "/Tennis/serve.mp4").unwrap()["file"], good.as_str());
        assert!(row(&folders_scope("/"), "/Tennis").is_some());
        assert!(row(&folders_scope("/Tennis"), "/Tennis/Old").is_none());
        let names_at = rows.iter().position(|row| row.0.starts_with("@namespace/names")).unwrap();
        assert!(rows[..names_at].iter().all(|row| !row.0.starts_with("@namespace/names")));
        assert!(rows[names_at..].iter().all(|row| row.0.starts_with("@namespace/names")));
        let (only, found) = rows_of_export(folder.path(), "computer", Some("/Notes")).unwrap();
        assert_eq!((found.names, found.files), (1, 1));
        assert!(only.iter().all(|row| row.0 != SPANS));
    }
}
