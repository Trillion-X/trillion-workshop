// src/account_files/folder.rs
//
// Purpose: What a native folder on a device (the files core, tools/files-on-every-device) needs of the person's files beside the calls
// the account files already answer: the changes after a cursor in the store's own order (`list_changes`, with a wait), the row that holds
// a stable item id now (`show_item`), the person's pin rules and whether a name is kept on a device (`kept`), and a small picture of a
// file (`thumbnail`). account-files-routes.json `_folder` is the contract; this file is its one implementation.
//
// Non-Negotiable Invariants:
// - A change is read from the store's own change order (`Rows::changes`), never from a copy or a log of our own, so a cursor never
//   expires and a change is never seen twice under one cursor.
// - An item is the row's minted column (src/store/tables.json `minted`), never its name: a rename answers one `put` of the same item
//   and no `remove`; `remove` means the item is held by no live name or folder any more.
// - A wait ends at the call's own time (`until`); a call with no time answers at once.
// - A pin rule is the person's own row naming items (a file's, or a folder's for everything under it), the same thing every file browser
//   pins; a rule follows its items through every rename and move because an item never changes.
// - A thumbnail is kept as the file's result of the DATA kind under its content identity, so it is made once and never stale; the
//   program that makes it reads the file by range from a loopback address only it is told, open for that one call.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::{
    folder_name, parent, text, AccountFiles, AccountFilesError, Answer, DEFAULT_LIST_LIMIT, LIVE,
    READ_MAX_BYTES,
};
use crate::store::{Changed, Error, Mutation, Record, MAX_PAGE_ITEMS};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Instant,
};

/// account-files-routes.json `folder`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderSettings {
    pin_rules: PinRules,
    thumbnails: Thumbnails,
    /// The HTTP path every operation is answered at, the operation's name appended (src/serve/dav.rs).
    call_path: String,
    /// The HTTP status of each refusal code (`account_routes::Failure::code`).
    statuses: BTreeMap<String, u16>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PinRules {
    /// The scope the person's pin rules are kept in.
    scope: String,
    /// The `kind` each pin rule row carries.
    kind: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Thumbnails {
    /// The result kind a file's thumbnails are kept as, one field per size.
    result_kind: String,
    /// The media type every maker writes.
    media_type: String,
    makers: Vec<Maker>,
}

/// One program that makes a thumbnail of the files whose media type starts with one of its prefixes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Maker {
    media_type_prefixes: Vec<String>,
    /// The program, found on the run's own path.
    program: String,
    /// Its arguments: `{input}` is the address it reads the file from, `{size}` the longer edge asked for. It writes the picture on
    /// its standard output.
    arguments: Vec<String>,
}

impl FolderSettings {
    /// The HTTP path an operation is answered at: `call_path` and the operation's name.
    pub fn call_path(&self) -> &str {
        &self.call_path
    }
    /// The HTTP status a refusal code is answered with; none for a code the DATA does not name.
    pub fn status_of(&self, code: &str) -> Option<u16> {
        self.statuses.get(code).copied()
    }
    pub fn valid(&self) -> bool {
        self.call_path.starts_with('/')
            && self.call_path.ends_with('/')
            && self.statuses.values().all(|status| (400..600).contains(status))
            && !self.pin_rules.scope.is_empty()
            && !self.pin_rules.kind.is_empty()
            && super::results::is_kind(&self.thumbnails.result_kind)
            && !self.thumbnails.media_type.is_empty()
            && self.thumbnails.makers.iter().all(|maker| {
                !maker.program.is_empty()
                    && !maker.media_type_prefixes.is_empty()
                    && maker.arguments.iter().any(|argument| argument.contains("{input}"))
            })
    }
}

fn folder() -> Answer<&'static FolderSettings> {
    super::account_routes::AccountFilesDoor::shipped()
        .map(|door| door.folder())
        .ok_or(AccountFilesError::Records(crate::cause!(Error::Unavailable), crate::cause!()))
}

/// The scope prefixes of the person's live names and folders: what a native folder shows.
fn live_prefixes() -> [&'static str; 2] {
    [LIVE.names, LIVE.folders]
}

/// A cursor or an item as the contract carries it: a whole number written as text.
fn number(field: &'static str, value: &str) -> Answer<i64> {
    value.parse::<i64>().ok().filter(|number| *number >= 0).ok_or(AccountFilesError::Invalid(field, crate::cause!()))
}

/// The stable fields of a name or folder row: its item, its version and its generation.
pub(super) fn stable_fields(record: &Record, row: &mut Map<String, Value>) {
    row.insert("item".into(), record.value.get("item").and_then(Value::as_i64).map_or(Value::Null, |item| json!(item.to_string())));
    row.insert("version".into(), json!(record.version));
    row.insert("generation".into(), json!(record.changed));
}

/// A folder row as the contract answers it.
fn folder_row(record: &Record) -> Value {
    let mut row = Map::new();
    row.insert("kind".into(), json!("folder"));
    row.insert("name".into(), json!(record.id));
    stable_fields(record, &mut row);
    Value::Object(row)
}

impl AccountFiles {
    /// `list_changes`: the changes to the person's names and folders after `after`, in the store's own order.
    pub fn list_changes(&self, after: Option<&str>, limit: Option<usize>, wait: bool, device: Option<&str>) -> Answer<Value> {
        let Some(after) = after else {
            return Ok(json!({ "changes": [], "next": self.store.order()?.to_string(), "more": false }));
        };
        let after = number("after must be a cursor list_changes answered", after)?;
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        // A wait holds while nothing the folder shows changed: a change to another scope (a file's own record) moves the order
        // but wakes it only to look again.
        let mut heard = after;
        let page = loop {
            let page = self.store.changes(&live_prefixes(), after, limit)?;
            let Some(until) = self.until.filter(|until| wait && page.items.is_empty() && Instant::now() < *until) else { break page };
            heard = self.store.wait_for_order(heard, until)?;
        };
        let next = page.items.last().map_or(after, |change| change.changed);
        let mut changes = Vec::new();
        let (mut names, mut at_name) = (Vec::new(), Vec::new());
        for change in &page.items {
            match change {
                Changed { record: Some(record), scope, .. } if scope.starts_with(LIVE.folders) => changes.push(Some(folder_row(record))),
                Changed { record: Some(record), .. } => {
                    at_name.push(changes.len());
                    names.push(record.clone());
                    changes.push(None);
                }
                Changed { record: None, minted: Some(item), changed, .. } => {
                    // A removed row whose item a live name or folder holds now was carried there: the carry's own `put` says so.
                    if self.store.minted(&live_prefixes(), *item)?.is_none() {
                        changes.push(Some(json!({ "op": "remove", "item": item.to_string(), "generation": changed })));
                    }
                }
                Changed { record: None, .. } => {}
            }
        }
        let mut rows = self.name_rows(&names)?;
        self.mark_kept(device, &mut rows)?;
        for (at, mut row) in at_name.into_iter().zip(rows) {
            row["kind"] = json!("name");
            changes[at] = Some(row);
        }
        let changes: Vec<Value> = changes
            .into_iter()
            .flatten()
            .map(|mut change| {
                if change.get("op").is_none() {
                    change["op"] = json!("put");
                }
                change
            })
            .collect();
        Ok(json!({ "changes": changes, "next": next.to_string(), "more": page.next.is_some() }))
    }

    /// `show_item`: the live name or folder that holds `item` now.
    pub fn show_item(&self, item: &str, device: Option<&str>) -> Answer<Value> {
        let item = number("item must be an item id list_files, show_item or list_changes gave", item)?;
        let (scope, record) = self.store.minted(&live_prefixes(), item)?.ok_or(crate::cause!(AccountFilesError::NotFound))?;
        if scope.starts_with(LIVE.folders) {
            return Ok(folder_row(&record));
        }
        let mut rows = self.name_rows(std::slice::from_ref(&record))?;
        self.mark_kept(device, &mut rows)?;
        let mut row = rows.pop().ok_or(crate::cause!(AccountFilesError::NotFound))?;
        row["kind"] = json!("name");
        Ok(row)
    }

    /// The folder rows of `folders` in `tree`'s folder `folder`, by name: `{item, version, generation}` each.
    pub(super) fn folder_items(&self, scope: &str, folders: &[String]) -> Answer<Map<String, Value>> {
        let ids: Vec<&str> = folders.iter().map(String::as_str).collect();
        let mut items = Map::new();
        for record in self.store.get_many(scope, &ids)?.into_iter().flatten() {
            let mut row = Map::new();
            stable_fields(&record, &mut row);
            items.insert(record.id.clone(), Value::Object(row));
        }
        Ok(items)
    }

    /// Put `kept` on each name row: true when an `on` pin rule of `device` names its item or the item of a folder it is under. No device,
    /// no mark.
    pub(super) fn mark_kept(&self, device: Option<&str>, rows: &mut [Value]) -> Answer<()> {
        let Some(device) = device else { return Ok(()) };
        let pinned: BTreeSet<String> = self
            .pin_rules_of(Some(device))?
            .iter()
            .filter(|rule| rule.value.get("on") != Some(&Value::Bool(false)))
            .flat_map(|rule| rule.value.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned))
            .collect();
        // Each folder's item is read once, however many names of the page are under it.
        let mut folders: BTreeMap<String, Option<String>> = BTreeMap::new();
        for row in rows.iter_mut() {
            let name = row.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            let mut kept = row.get("item").and_then(Value::as_str).is_some_and(|item| pinned.contains(item));
            let mut folder = folder_name(parent(&name));
            while !kept && folder != "/" {
                if !folders.contains_key(&folder) {
                    let item = self.store.get(&LIVE.folders(parent(&folder)), &folder)?.record.and_then(|record| record.value.get("item").and_then(Value::as_i64)).map(|item| item.to_string());
                    folders.insert(folder.clone(), item);
                }
                kept = folders[&folder].as_ref().is_some_and(|item| pinned.contains(item));
                folder = folder_name(parent(&folder));
            }
            row["kept"] = json!(kept);
        }
        Ok(())
    }

    /// Every pin rule, or those of one device, in id order.
    fn pin_rules_of(&self, device: Option<&str>) -> Answer<Vec<Record>> {
        let scope = &folder()?.pin_rules.scope;
        let mut rules = Vec::new();
        let mut after = String::new();
        loop {
            let page = self.store.list_page(scope, &after, MAX_PAGE_ITEMS)?;
            rules.extend(page.items.into_iter().filter(|rule| device.is_none_or(|device| text(&rule.value, "device") == Some(device))));
            match page.next {
                Some(next) => after = next,
                None => return Ok(rules),
            }
        }
    }

    /// `set_pin_rule`: keep one pin rule at the version the caller read.
    pub fn set_pin_rule(&mut self, input: &Value) -> Answer<Value> {
        let settings = folder()?;
        let field = |name: &str| input.get(name).and_then(Value::as_str).filter(|value| !value.is_empty());
        let (Some(id), Some(device), Some(items), Some(expected)) =
            (field("id"), field("device"), input.get("items").and_then(Value::as_array), input.get("expected_version").and_then(Value::as_i64))
        else {
            return Err(AccountFilesError::Invalid("a pin rule needs id, device, items and expected_version", crate::cause!()));
        };
        if items.is_empty() || !items.iter().all(|item| item.as_str().is_some_and(|item| number("", item).is_ok())) {
            return Err(AccountFilesError::Invalid("a pin rule's items are item ids list_files, show_item or list_changes gave", crate::cause!()));
        }
        let value = json!({
            "kind": settings.pin_rules.kind, "device": device, "items": items,
            "label": input.get("label").and_then(Value::as_str).unwrap_or_default(),
            "on": input.get("on").and_then(Value::as_bool).unwrap_or(true),
        });
        let request = content_crypto::advanced::blake3::hash(format!("pin\0{id}\0{expected}\0{value}").as_bytes()).to_hex().to_string();
        let change = self.mutate(&settings.pin_rules.scope, Mutation { id: id.to_owned(), expected_version: expected, request_key: request, deleted: false, value })?;
        Ok(json!({ "id": id, "version": change.version, "rule": change.value }))
    }

    /// `remove_pin_rule`: remove one pin rule at the version the caller read.
    pub fn remove_pin_rule(&mut self, id: &str, expected: i64) -> Answer<Value> {
        let scope = &folder()?.pin_rules.scope;
        let request = content_crypto::advanced::blake3::hash(format!("unpin\0{id}\0{expected}").as_bytes()).to_hex().to_string();
        let change = self.mutate(scope, Mutation { id: id.to_owned(), expected_version: expected, request_key: request, deleted: true, value: Value::Null })?;
        Ok(json!({ "id": id, "version": change.version, "removed": true }))
    }

    /// `list_pin_rules`: one page of the pin rules, of one device or all, in id order.
    pub fn list_pin_rules(&self, device: Option<&str>, after: Option<&str>, limit: Option<usize>) -> Answer<Value> {
        let scope = &folder()?.pin_rules.scope;
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_PAGE_ITEMS);
        let mut rules = Vec::new();
        let mut cursor = after.unwrap_or("").to_owned();
        let next = loop {
            let page = self.store.list_page(scope, &cursor, limit)?;
            for rule in page.items {
                cursor.clone_from(&rule.id);
                if device.is_none_or(|device| text(&rule.value, "device") == Some(device)) {
                    rules.push(json!({ "id": rule.id, "version": rule.version, "rule": rule.value }));
                    if rules.len() == limit {
                        break;
                    }
                }
            }
            if rules.len() == limit || page.next.is_none() {
                break (rules.len() == limit && page.next.is_some()).then_some(cursor);
            }
        };
        Ok(json!({ "rules": rules, "next_after": next }))
    }

    /// `make_folder`: one folder in a folder that exists, made only when nothing is at that name (`expected_version` 0, the store's
    /// compare-and-set at the version the name holds now, a removed folder's own included). Answers the folder's row.
    pub fn make_folder(&mut self, name: &str, expected: i64) -> Answer<Value> {
        let name = folder_name(name);
        if name == "/" || name.contains('\0') {
            return Err(AccountFilesError::Invalid("a folder is an absolute path below the top", crate::cause!()));
        }
        let above = parent(&name).to_owned();
        if above != "/" && self.store.get(&LIVE.folders(parent(&above)), &above)?.record.is_none() {
            return Err(crate::cause!(AccountFilesError::NotFound));
        }
        let scope = LIVE.folders(parent(&name));
        let (version, held) = self.store.held_record_with_version(&scope, &name)?;
        let named = self.store.get(&LIVE.names(parent(&name)), &name)?.record.is_some();
        if expected != 0 || held.is_some() || named {
            return Err(AccountFilesError::Records(crate::cause!(Error::Conflict), crate::cause!()));
        }
        let value = json!({ "kind": super::FOLDER_KIND, "folder": name });
        let request = content_crypto::advanced::blake3::hash(format!("folder\0{name}\0{version}").as_bytes()).to_hex().to_string();
        self.mutate(&scope, Mutation { id: name.clone(), expected_version: version, request_key: request, deleted: false, value })?;
        let made = self.store.get(&scope, &name)?.record.ok_or(crate::cause!(Error::Unavailable))?;
        Ok(folder_row(&made))
    }

    /// `thumbnail`: a picture of the file at most `size` pixels on its longer edge, made once and kept under its content identity.
    pub fn thumbnail(&mut self, name_or_identity: &str, size: u64) -> Answer<Value> {
        let settings = &folder()?.thumbnails;
        if size == 0 {
            return Err(AccountFilesError::Invalid("size is the longer edge in pixels, at least 1", crate::cause!()));
        }
        let file = self.resolve(name_or_identity)?.file;
        let field = format!("size_{size}");
        let kept = self.read_file_result_fields(&file.id, &settings.result_kind, &[field.as_str()], None)?;
        if let Some(picture) = kept.get(&field).and_then(Value::as_str) {
            return Ok(json!({ "identity": file.id, "size": size, "media_type": settings.media_type, "content_base64": picture }));
        }
        let media_type = text(&file.value, "media_type").unwrap_or_default();
        let Some(maker) = settings.makers.iter().find(|maker| maker.media_type_prefixes.iter().any(|prefix| media_type.starts_with(prefix.as_str()))) else {
            return Ok(json!({ "identity": file.id, "size": size, "thumbnail": null, "reason": "no maker takes this media type" }));
        };
        let picture = self.make_thumbnail(maker, &file, size)?;
        if picture.is_empty() {
            return Ok(json!({ "identity": file.id, "size": size, "thumbnail": null, "reason": "the maker made no picture of this file" }));
        }
        let encoded = BASE64.encode(&picture);
        self.merge_file_result(&file.id, &settings.result_kind, &json!({ field: encoded }), Some(&maker.program), false)?;
        Ok(json!({ "identity": file.id, "size": size, "media_type": settings.media_type, "content_base64": encoded }))
    }

    /// Run `maker` over `file`: the file is offered by range at a loopback address with an unguessable path, served from this thread one
    /// request at a time until the program ends (or the call's time does, which ends the program).
    fn make_thumbnail(&self, maker: &Maker, file: &Record, size: u64) -> Answer<Vec<u8>> {
        let byte_length = file.value.get("byte_length").and_then(Value::as_u64).ok_or(crate::cause!(Error::Unavailable))?;
        let unavailable = |_| AccountFilesError::Records(crate::cause!(Error::Unavailable), crate::cause!());
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(unavailable)?;
        let address = listener.local_addr().map_err(unavailable)?;
        let token = content_crypto::advanced::blake3::hash(format!("thumbnail\0{}\0{:?}\0{}", file.id, Instant::now(), std::process::id()).as_bytes()).to_hex().to_string();
        let input = format!("http://{address}/{token}");
        let arguments: Vec<String> =
            maker.arguments.iter().map(|argument| argument.replace("{input}", &input).replace("{size}", &size.to_string())).collect();
        let mut child = Command::new(&maker.program)
            .args(&arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| AccountFilesError::Invalid("the thumbnail program is not on this computer", crate::cause!()))?;
        let pid = child.id();
        let mut stdout = child.stdout.take().ok_or(crate::cause!(Error::Unavailable))?;
        let done = Arc::new(AtomicBool::new(false));
        let (ended, end_heard) = mpsc::channel::<()>();
        let until = self.until;
        // The program's picture is read off this thread; when the program ends, the server below is woken to stop.
        let drained = {
            let done = done.clone();
            std::thread::spawn(move || {
                let mut picture = Vec::new();
                let _ = stdout.read_to_end(&mut picture);
                let finished = child.wait().is_ok_and(|status| status.success());
                done.store(true, Ordering::SeqCst);
                let _ = ended.send(());
                let _ = TcpStream::connect(address);
                finished.then_some(picture).unwrap_or_default()
            })
        };
        // The call's time ends the program.
        if let Some(until) = until {
            std::thread::spawn(move || {
                if end_heard.recv_timeout(until.saturating_duration_since(Instant::now())).is_err() {
                    // SAFETY: kill sends a signal to the one process this call started; it touches no memory.
                    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
                }
            });
        }
        for stream in listener.incoming() {
            if done.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            self.answer_range(stream, &token, file, byte_length);
        }
        drained.join().map_err(|_| crate::cause!(Error::Unavailable).into())
    }

    /// Answer one HTTP request of the thumbnail program: `GET` or `HEAD` of the token's path, whole or one byte range, read through the
    /// account files' own ranged reads a contract read at a time. Anything else is refused. The connection closes after it.
    fn answer_range(&self, mut stream: TcpStream, token: &str, file: &Record, byte_length: u64) {
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(stream) => stream,
            Err(_) => return,
        });
        let mut request = String::new();
        if reader.read_line(&mut request).is_err() {
            return;
        }
        let mut range = None;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.trim().eq_ignore_ascii_case("range") {
                    range = value.trim().strip_prefix("bytes=").map(str::to_owned);
                }
            }
        }
        let mut parts = request.split_whitespace();
        let (method, path) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
        if !matches!(method, "GET" | "HEAD") || path.strip_prefix('/') != Some(token) {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
        let (start, end) = match range.as_deref().and_then(|range| range.split_once('-')) {
            Some((start, end)) => {
                let start = start.parse::<u64>().unwrap_or(0);
                let end = end.parse::<u64>().ok().map_or(byte_length, |end| end.saturating_add(1)).min(byte_length);
                (start, end)
            }
            None => (0, byte_length),
        };
        if start >= end && byte_length > 0 {
            let _ = stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{byte_length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
            return;
        }
        let head = match range {
            Some(_) => format!(
                "HTTP/1.1 206 Partial Content\r\nAccept-Ranges: bytes\r\nContent-Range: bytes {start}-{}/{byte_length}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                end.saturating_sub(1),
                end - start
            ),
            None => format!("HTTP/1.1 200 OK\r\nAccept-Ranges: bytes\r\nContent-Length: {byte_length}\r\nConnection: close\r\n\r\n"),
        };
        if stream.write_all(head.as_bytes()).is_err() || method == "HEAD" {
            return;
        }
        let mut at = start;
        while at < end {
            let length = (end - at).min(READ_MAX_BYTES);
            let Ok(bytes) = self.read_range(file, at, length) else { return };
            if stream.write_all(&bytes).is_err() {
                return;
            }
            at += length;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_folder_data_is_valid() {
        assert!(folder().unwrap().valid());
    }

    #[test]
    fn every_refusal_code_has_an_http_status_and_a_conflict_is_409() {
        let settings = folder().unwrap();
        for code in ["namespace_conflict", "namespace_not_found", "original_input_refused", "namespace_identity_mismatch", "namespace_origin_not_bound", "namespace_unavailable", "namespace_source_unavailable"] {
            assert!(settings.status_of(code).is_some(), "{code}");
        }
        assert_eq!(settings.status_of("namespace_conflict"), Some(409));
        let conflict = super::super::account_routes::Failure::AccountFiles(AccountFilesError::Records(crate::cause!(Error::Conflict), crate::cause!()), crate::cause!());
        assert_eq!(conflict.code(), ("namespace_conflict", false), "a compare-and-set refusal is not an outage");
    }

    #[test]
    fn a_cursor_or_an_item_is_a_whole_number_of_zero_or_more() {
        assert_eq!(number("x", "12").unwrap(), 12);
        assert!(number("x", "-1").is_err() && number("x", "a").is_err() && number("x", "").is_err());
    }
}
