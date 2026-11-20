//! A simulated world for the files core: this computer's engine door answering the files contract over a link with a
//! round trip and a rate, a clock that only moves when the test moves it, faults on demand, and an OS that keeps the
//! bytes the core writes. Every number below is the test's own scenario, never the core's.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use files_core::{Command, Core, Event, Problem};
use serde_json::{json, Value};

/// The contract's answer to `bounds`, from where tools/live-namespace keeps each number (src/account_files/folder.rs
/// `bounds`): a span and a piece at most one stored chunk (settings.json `chunks.bytes`, which is also objects.rs
/// MAX_RANGE_BYTES), and the store's idle wait (`transfer.idle_seconds`).
pub fn bounds_answer() -> Value {
    let settings: Value = serde_json::from_str(include_str!("../../../../live-namespace/src/account_files/settings.json")).unwrap();
    let chunk = settings["chunks"]["bytes"].as_u64().unwrap();
    json!({"span_most": chunk, "piece_most": chunk, "idle_seconds": settings["transfer"]["idle_seconds"]})
}

/// The contract's idle wait in milliseconds.
pub fn idle_ms() -> u64 {
    bounds_answer()["idle_seconds"].as_u64().unwrap() * 1000
}

/// Where in the door's message a slot of contract.json `call.body` sits.
fn slot_path(template: &Value, slot: &str) -> Option<Vec<String>> {
    match template {
        Value::String(text) if text == slot => Some(Vec::new()),
        Value::Object(fields) => fields.iter().find_map(|(name, value)| {
            slot_path(value, slot).map(|mut path| {
                path.insert(0, name.clone());
                path
            })
        }),
        _ => None,
    }
}

pub fn contract_value() -> Value {
    serde_json::from_str(include_str!("../../contract.json")).unwrap()
}

/// The operation and input a door message carries (every call is one of the files session's operations).
pub fn operation_of(message: &Value) -> (String, Value) {
    let contract = contract_value();
    let slot = |template: &Value, value: &Value, name: &str| {
        let path = slot_path(template, contract["call"]["slots"][name].as_str().unwrap()).unwrap();
        path.iter().fold(value, |value, name| &value[name.as_str()]).clone()
    };
    let body = &contract["call"]["body"];
    let (method, call_input) = (slot(body, message, "method"), slot(body, message, "call_input"));
    assert_eq!(&method, &contract["files"]["method"]);
    assert!(message["params"]["arguments"].get("address").is_none(), "a call names its method, never an address");
    let files = &contract["files"]["input"];
    (slot(files, &call_input, "op").as_str().unwrap().to_owned(), slot(files, &call_input, "input"))
}

/// This computer as the door names it.
pub fn this_computer() -> Value {
    let contract = contract_value();
    let call = &contract["this_computer"];
    json!({call["id"].as_str().unwrap(): "device-a", call["label"].as_str().unwrap(): "Example Laptop"})
}

pub fn identity_of(bytes: &[u8]) -> String {
    format!("1f:{}", blake3::hash(bytes).to_hex())
}

/// A file's bytes: kept, or made from a seed at any offset (a 33 GB file the test never holds).
#[derive(Clone)]
pub enum Content {
    Kept(Vec<u8>),
    Made { seed: u8, size: u64 },
}

impl Content {
    pub fn size(&self) -> u64 {
        match self {
            Content::Kept(bytes) => bytes.len() as u64,
            Content::Made { size, .. } => *size,
        }
    }
    pub fn range(&self, offset: u64, length: u64) -> Vec<u8> {
        match self {
            Content::Kept(bytes) => bytes[offset as usize..(offset + length) as usize].to_vec(),
            Content::Made { seed, .. } => (offset..offset + length).map(|at| (at as u8) ^ seed).collect(),
        }
    }
}

#[derive(Clone)]
pub struct SimFile {
    pub item: String,
    pub identity: String,
    pub content: Content,
    /// The row's own version, which a write names as expected_version.
    pub version: i64,
    pub generation: u64,
    pub modified: Option<u64>,
    pub folder: bool,
    pub read_only: bool,
}

/// One pin rule row: {device, items, on} at its version.
#[derive(Clone)]
pub struct PinRule {
    pub device: String,
    pub items: Vec<String>,
    pub on: bool,
    pub version: i64,
}

/// The account's files, as every computer of it serves them (tools/live-namespace/src/account_files/account-files-routes.json
/// `_folder`: items, versions, generations, a change feed whose cursor never expires, pins, compare-and-set on every write).
#[derive(Default)]
pub struct Store {
    pub names: BTreeMap<String, SimFile>,
    pub by_identity: HashMap<String, Content>,
    pub log: Vec<Value>,
    pub uploads: HashMap<String, (String, u64, i64, Vec<u8>)>,
    pub next_item: u64,
    pub order: u64,
    pub pins: BTreeMap<String, PinRule>,
    pub thumbnail_calls: HashMap<String, u64>,
    pub offers_ids: bool,
    /// Whether the session was started by an engine that knows this computer (else `this_computer` names none).
    pub names_computer: bool,
}

impl Store {
    pub fn new() -> Store {
        Store { offers_ids: true, names_computer: true, ..Store::default() }
    }

    fn new_item(&mut self) -> String {
        self.next_item += 1;
        self.next_item.to_string()
    }

    fn next_order(&mut self) -> u64 {
        self.order += 1;
        self.order
    }

    fn parent(name: &str) -> String {
        match name.rfind('/') {
            Some(0) | None => "/".into(),
            Some(cut) => name[..cut].into(),
        }
    }

    /// Whether an on pin rule of `device` names the name's item or a folder's above it.
    fn kept(&self, name: &str, device: Option<&str>) -> Option<bool> {
        let device = device?;
        let pinned: Vec<&String> = self.pins.values().filter(|rule| rule.on && rule.device == device).flat_map(|rule| rule.items.iter()).collect();
        let mut at = name.to_owned();
        loop {
            if self.names.get(&at).is_some_and(|file| pinned.contains(&&file.item)) {
                return Some(true);
            }
            if at == "/" || !at.contains('/') {
                return Some(false);
            }
            at = Self::parent(&at);
            if at == "/" {
                return Some(false);
            }
        }
    }

    pub fn row_for(&self, name: &str, device: Option<&str>) -> Value {
        let file = &self.names[name];
        let mut row = json!({"name": name, "version": file.version, "generation": file.generation, "kind": if file.folder { "folder" } else { "name" }});
        if self.offers_ids {
            row["item"] = json!(file.item);
        }
        if let Some(modified) = file.modified {
            row["modified_at_ms"] = json!(modified);
        }
        if file.read_only {
            row["read_only"] = json!(true);
        }
        if !file.folder {
            row["identity"] = json!(file.identity);
            row["byte_length"] = json!(file.content.size());
            row["media_type"] = json!("application/octet-stream");
            if let Some(kept) = self.kept(name, device) {
                row["kept"] = json!(kept);
            }
        }
        row
    }

    pub fn row(&self, name: &str) -> Value {
        self.row_for(name, None)
    }

    fn logged_put(&mut self, name: &str) {
        let order = self.next_order();
        self.names.get_mut(name).unwrap().generation = order;
        self.log.push(json!({"op": "put", "name": name}));
    }

    fn logged_remove(&mut self, item: &str) {
        self.next_order();
        self.log.push(json!({"op": "remove", "item": item}));
    }

    pub fn put_file(&mut self, name: &str, content: Content, modified: Option<u64>) -> String {
        let identity = match &content {
            Content::Kept(bytes) => identity_of(bytes),
            Content::Made { seed, size } => identity_of(format!("made {seed} {size}").as_bytes()),
        };
        let (item, version) = match self.names.get(name) {
            Some(old) => (old.item.clone(), old.version + 1),
            None => (self.new_item(), 1),
        };
        self.by_identity.insert(identity.clone(), content.clone());
        self.names.insert(name.into(), SimFile { item: item.clone(), identity, content, version, generation: 0, modified, folder: false, read_only: false });
        self.logged_put(name);
        item
    }

    pub fn put_folder(&mut self, name: &str) -> String {
        let item = self.new_item();
        self.names.insert(name.into(), SimFile { item: item.clone(), identity: String::new(), content: Content::Kept(Vec::new()), version: 1, generation: 0, modified: None, folder: true, read_only: false });
        self.logged_put(name);
        item
    }

    fn failure(code: &str) -> Reply {
        Reply::Refused(json!({"code": code, "outcome": "not_started"}))
    }

    fn conflict() -> Reply {
        Self::failure("namespace_conflict")
    }

    /// Whether a write naming `expected` may change `name` (0: the name must not exist).
    fn at_version(&self, name: &str, expected: Option<i64>) -> bool {
        match (expected, self.names.get(name)) {
            (Some(0), None) => true,
            (Some(asked), Some(file)) => asked == file.version,
            _ => false,
        }
    }

    /// One contract call, answered as a computer that holds the account answers it.
    pub fn call(&mut self, operation: &str, input: &Value) -> Reply {
        let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
        let number = |key: &str| input.get(key).and_then(Value::as_u64);
        let device = text("device");
        let expected = input.get("expected_version").and_then(Value::as_i64);
        match operation {
            "list_files" => {
                let folder = text("folder").unwrap_or("/".into());
                let after = text("after").unwrap_or_default();
                let limit = number("limit").unwrap_or(200) as usize;
                let children: Vec<String> = self.names.keys().filter(|name| Self::parent(name) == folder && name.as_str() > after.as_str()).cloned().collect();
                let page: Vec<String> = children.iter().take(limit).cloned().collect();
                let next = if children.len() > limit { page.last().map(|name| json!(name)) } else { None };
                let files: Vec<Value> = page.iter().filter(|name| !self.names[*name].folder).map(|name| self.row_for(name, device.as_deref())).collect();
                let folders: Vec<&String> = page.iter().filter(|name| self.names[*name].folder).collect();
                let mut folder_items = serde_json::Map::new();
                if self.offers_ids {
                    for name in &folders {
                        let file = &self.names[*name];
                        folder_items.insert((*name).clone(), json!({"item": file.item, "version": file.version, "generation": file.generation}));
                    }
                }
                Reply::Answer(json!({"collection": folder, "names": files, "folders": folders, "folder_items": folder_items, "next_after": next}))
            }
            "list_changes" => {
                let Some(after) = text("after") else { return Reply::Answer(json!({"changes": [], "next": self.log.len().to_string(), "more": false})) };
                let at: usize = after.parse().unwrap();
                let limit = number("limit").unwrap_or(200) as usize;
                let end = at.saturating_add(limit).min(self.log.len());
                let changes: Vec<Value> = self.log[at..end]
                    .iter()
                    .filter_map(|change| match change["op"].as_str() {
                        Some("put") => {
                            let name = change["name"].as_str().unwrap();
                            self.names.contains_key(name).then(|| {
                                let mut row = self.row_for(name, device.as_deref());
                                row["op"] = json!("put");
                                row
                            })
                        }
                        _ => Some(change.clone()),
                    })
                    .collect();
                Reply::Answer(json!({"changes": changes, "next": end.to_string(), "more": end < self.log.len()}))
            }
            "show_item" => {
                let item = text("item").unwrap();
                match self.names.iter().find(|(_, file)| file.item == item).map(|(name, _)| name.clone()) {
                    Some(name) => Reply::Answer(self.row_for(&name, device.as_deref())),
                    None => Self::failure("namespace_not_found"),
                }
            }
            "read_file_span" => {
                let asked = text("name_or_identity").unwrap();
                let (offset, length) = (number("offset").unwrap(), number("length").unwrap());
                let Some(content) = self.by_identity.get(&asked) else { return Self::failure("namespace_not_found") };
                if length == 0 || offset + length > content.size() {
                    return Self::failure("original_input_refused");
                }
                assert_eq!(input["raw"], json!(true), "every span is read raw");
                Reply::Raw { bytes: content.range(offset, length), total: content.size(), offset, identity: asked }
            }
            "write_file_start" => {
                let id = text("upload_id").unwrap();
                assert_eq!(id.len(), 32, "the upload id has the contract's length");
                assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
                let name = text("name").unwrap();
                if !self.uploads.contains_key(&id) && !self.at_version(&name, expected) {
                    return Self::conflict();
                }
                let version = expected.unwrap();
                self.uploads.entry(id.clone()).or_insert((name, number("byte_length").unwrap(), version, Vec::new()));
                Reply::Answer(json!({"upload_id": id, "next_offset": self.uploads[&id].3.len()}))
            }
            "write_file_piece" => {
                let id = text("upload_id").unwrap();
                // The piece came raw: the door handed its body over as the content file (here, its bytes as base64).
                let given = input["content_file"]["base64"].as_str().map(str::to_owned).or(text("content_base64"));
                let bytes = BASE64.decode(given.unwrap()).unwrap();
                let upload = self.uploads.get_mut(&id).unwrap();
                assert_eq!(upload.0, text("name").unwrap(), "a piece names its upload's name");
                let offset = number("offset").unwrap() as usize;
                if offset == upload.3.len() {
                    upload.3.extend_from_slice(&bytes);
                } else if offset > upload.3.len() {
                    return Self::failure("original_input_refused");
                }
                Reply::Answer(json!({"next_offset": upload.3.len()}))
            }
            "write_file_finish" => {
                let id = text("upload_id").unwrap();
                let (name, length, version, bytes) = self.uploads.get(&id).cloned().unwrap();
                assert_eq!(name, text("name").unwrap());
                if bytes.len() as u64 != length || identity_of(&bytes) != text("identity").unwrap() {
                    return Self::failure("namespace_identity_mismatch");
                }
                if !self.at_version(&name, Some(version)) {
                    return Self::conflict();
                }
                self.uploads.remove(&id);
                self.put_file(&name, Content::Kept(bytes), Some(1_800_000_000_000));
                // The finish answers the written name's stable fields too (tools/live-namespace folder.rs `with_name_row`).
                let kept = &self.names[&name];
                Reply::Answer(json!({"upload_id": id, "state": "finished", "identity": kept.identity, "name": name, "byte_length": length,
                    "item": kept.item, "version": kept.version, "generation": kept.generation}))
            }
            "move_names" => {
                let (from, to) = (text("from").unwrap(), text("to").unwrap());
                if !self.names.contains_key(&from) {
                    return Self::failure("namespace_not_found");
                }
                if self.names.contains_key(&to) || !self.at_version(&from, expected) {
                    return Self::conflict();
                }
                let moved: Vec<String> = self.names.keys().filter(|name| **name == from || name.starts_with(&format!("{from}/"))).cloned().collect();
                for old in moved {
                    let mut file = self.names.remove(&old).unwrap();
                    file.version += 1;
                    let new = format!("{to}{}", &old[from.len()..]);
                    self.names.insert(new.clone(), file);
                    self.logged_put(&new);
                }
                Reply::Answer(json!({"from": from, "to": to, "next_after": null}))
            }
            "set_aside" => {
                let name = text("name").unwrap();
                let Some(file) = self.names.get(&name).cloned() else { return Self::failure("namespace_not_found") };
                if !self.at_version(&name, expected) {
                    return Self::conflict();
                }
                self.names.remove(&name);
                self.logged_remove(&file.item);
                Reply::Answer(json!({"name": name, "next_after": null}))
            }
            "list_pin_rules" => {
                let rules: Vec<Value> = self
                    .pins
                    .iter()
                    .filter(|(_, rule)| device.as_deref().is_none_or(|device| rule.device == device))
                    .map(|(id, rule)| json!({"id": id, "version": rule.version, "rule": {"device": rule.device, "items": rule.items, "on": rule.on}}))
                    .collect();
                Reply::Answer(json!({"rules": rules, "next_after": null}))
            }
            "set_pin_rule" => {
                let id = text("id").unwrap();
                let current = self.pins.get(&id).map_or(0, |rule| rule.version);
                if expected != Some(current) {
                    return Self::conflict();
                }
                let items: Vec<String> = input["items"].as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect();
                let on = input.get("on").and_then(Value::as_bool).unwrap_or(true);
                self.pins.insert(id.clone(), PinRule { device: device.unwrap(), items, on, version: current + 1 });
                Reply::Answer(json!({"id": id, "version": current + 1}))
            }
            "remove_pin_rule" => {
                let id = text("id").unwrap();
                if self.pins.get(&id).map(|rule| rule.version) != expected {
                    return Self::conflict();
                }
                self.pins.remove(&id);
                Reply::Answer(json!({"id": id, "removed": true}))
            }
            "make_folder" => {
                let name = text("name").unwrap();
                if !self.at_version(&name, expected) {
                    return Self::conflict();
                }
                if !self.names.get(&Self::parent(&name)).is_some_and(|parent| parent.folder) && Self::parent(&name) != "/" {
                    return Self::failure("namespace_not_found");
                }
                self.put_folder(&name);
                Reply::Answer(self.row(&name))
            }
            "thumbnail" => {
                let identity = text("name_or_identity").unwrap();
                *self.thumbnail_calls.entry(identity.clone()).or_default() += 1;
                Reply::Answer(json!({"identity": identity, "size": number("size"), "media_type": "image/png", "content_base64": BASE64.encode(b"picture")}))
            }
            "bounds" => Reply::Answer(bounds_answer()),
            "this_computer" if self.names_computer => Reply::Answer(this_computer()),
            "this_computer" => Reply::Answer(json!({"id": null, "label": null})),
            // An operation the session does not list: live-namespace finds no such tool.
            _ => Reply::NoTool,
        }
    }
}

/// The link to the door: round trip and rate, and whether it answers at all.
#[derive(Clone, Copy)]
pub struct Linked {
    pub round_trip_ms: u64,
    pub bytes_per_ms: f64,
    pub down: bool,
    /// Never answers, without failing (a stall).
    pub silent: bool,
    /// What the store spends on each object a span read crosses, one after another, before the answer's first byte
    /// (tools/live-namespace read_range_inner reads a span's objects in order); 0 for a store that costs nothing.
    pub store_ms_per_object: u64,
    /// The bytes one stored object holds (a pages-32k-v1 file keeps every 32 KiB as its own object).
    pub object_bytes: u64,
}

/// What the store answers one operation: its answer, a refusal ({code, outcome}), or no such tool at all.
#[derive(Clone, Debug)]
pub enum Reply {
    Answer(Value),
    Refused(Value),
    NoTool,
    /// A span's bytes as the door hands them raw, with the headers that name the file's size and the span's offset.
    Raw { bytes: Vec<u8>, total: u64, offset: u64, identity: String },
}

impl Reply {
    /// The door's JSON-RPC answer carrying it (trillion-rust src/mcp.rs `tool_outcome`: the answer as text and as
    /// structured content). A files operation's reply is live-namespace's own MCP result (tools/live-namespace
    /// src/serve/mcp.rs `tool_result`), which the door answers inside {tool, result} or, for a JSON-RPC error,
    /// {tool, error} (trillion-rust src/tool_runs/tools/sessions.rs, session calls).
    /// What crosses the wire: the body and its headers. A raw span is its bytes alone (trillion-rust f4a4cb0a8b,
    /// e42ec83506, 7e0fbe2ec5: content-type application/octet-stream, X-Total-Bytes, X-Offset, X-Content-Identity).
    fn wire(&self, request: u64) -> (Vec<u8>, Value) {
        if let Reply::Raw { bytes, total, offset, identity } = self {
            return (bytes.clone(), json!({"content-type": "application/octet-stream", "x-total-bytes": total.to_string(), "x-offset": offset.to_string(), "x-content-identity": identity}));
        }
        (self.door(request).to_string().into_bytes(), json!({"content-type": "application/json"}))
    }

    fn door(&self, request: u64) -> Value {
        let result = |answer: &Value, refused: bool| json!({"content": [{"type": "text", "text": answer.to_string()}], "structuredContent": answer, "isError": refused});
        let (answer, refused) = match self {
            Reply::Raw { .. } => unreachable!("a raw span is no JSON answer"),
            Reply::Answer(answer) => (json!({"tool": "tool:your-files", "result": result(answer, false)}), false),
            Reply::Refused(refusal) => (json!({"tool": "tool:your-files", "result": result(refusal, true)}), false),
            Reply::NoTool => (json!({"tool": "tool:your-files", "error": {"code": -32602, "message": "No such tool."}}), false),
        };
        json!({"jsonrpc": "2.0", "id": request, "result": result(&answer, refused)})
    }

    pub fn answer(&self) -> Option<&Value> {
        match self {
            Reply::Answer(answer) => Some(answer),
            _ => None,
        }
    }
}

/// Changes an answer before it travels: (operation, input, reply).
pub type Tamper = Box<dyn FnMut(&str, &Value, &mut Reply)>;

impl Linked {
    /// A link that answers, with a store that costs nothing per object.
    pub fn quick() -> Linked {
        Linked { round_trip_ms: 0, bytes_per_ms: 1.0, down: false, silent: false, store_ms_per_object: 0, object_bytes: 1 }
    }

    pub fn of(round_trip_ms: u64, bytes_per_ms: f64) -> Linked {
        Linked { round_trip_ms, bytes_per_ms, ..Linked::quick() }
    }
}

pub struct Arrival {
    pub request: u64,
    pub reached: bool,
    pub headers: Value,
    pub sent_ms: u64,
    pub first_byte_ms: u64,
    pub body: Vec<u8>,
}

/// The world a core lives in, driven one event at a time.
pub struct World {
    pub core: Core,
    pub store: Store,
    pub link: Linked,
    pub link_free: u64,
    pub now: u64,
    pub arrivals: BTreeMap<(u64, u64), Arrival>,
    /// Watches the store has nothing for yet: (request, input).
    pub parked: Vec<(u64, Value)>,
    pub log: Vec<Command>,
    pub sends: Vec<(u64, String, Value)>,
    pub written: HashMap<(String, String), BTreeMap<u64, Vec<u8>>>,
    pub local: HashMap<u64, Vec<u8>>,
    pub span_bytes_asked: u64,
    /// Whether a change wait is held until a change comes (a contract that keeps `wait`), or answered at once.
    pub holds_waits: bool,
    pub tamper: Option<Tamper>,
}

/// This computer's engine door.
pub fn origin() -> String {
    "https://door.example.com".into()
}

impl World {
    pub fn new(link: Linked) -> World {
        let setup = json!({"origin": origin()});
        World {
            core: Core::new(serde_json::from_value(setup).unwrap()).unwrap(),
            store: Store::new(),
            link_free: 0,
            link,
            now: 0,
            arrivals: BTreeMap::new(),
            parked: Vec::new(),
            log: Vec::new(),
            sends: Vec::new(),
            written: HashMap::new(),
            local: HashMap::new(),
            span_bytes_asked: 0,
            holds_waits: true,
            tamper: None,
        }
    }

    pub fn fast() -> World {
        World::new(Linked { round_trip_ms: 20, bytes_per_ms: 10_000.0, ..Linked::quick() })
    }

    pub fn event(&mut self, kind: Value) {
        self.event_with(kind, &[]);
    }

    pub fn event_with(&mut self, mut kind: Value, bytes: &[u8]) {
        kind["now_ms"] = json!(self.now);
        let event: Event = serde_json::from_value(kind).expect("an event");
        self.core.handle(event, bytes);
        self.drain();
    }

    fn drain(&mut self) {
        while let Some((command, bytes)) = self.core.next_command() {
            match &command {
                Command::Send { request, url, content_type, headers, .. } => {
                    assert!(url.starts_with(&origin()), "every request goes to this computer's door: {url}");
                    // A raw upload, as the door takes it (the engine's src/mcp/upload.rs): the message rides in the contract's
                    // header, base64url, and the body is the piece, which the door hands to the session as its content file.
                    let upload = &contract_value()["call"]["raw_upload"];
                    let raw = content_type == upload["content_type"].as_str().unwrap();
                    let message = if raw {
                        let header = headers.get(upload["header"].as_str().unwrap()).expect("a raw upload carries its message in the header");
                        serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap()
                    } else {
                        serde_json::from_slice(&bytes).unwrap()
                    };
                    let (operation, mut input) = operation_of(&message);
                    if raw {
                        assert!(input.get("content_base64").is_none(), "a raw piece's bytes are its body alone");
                        input["content_file"] = json!({"length": bytes.len(), "base64": BASE64.encode(&bytes)});
                    }
                    self.sends.push((*request, operation.clone(), input.clone()));
                    if operation == "read_file_span" {
                        self.span_bytes_asked += input["length"].as_u64().unwrap();
                    }
                    self.carry(*request, &operation, &input);
                }
                Command::Write { item, version, offset, .. } => {
                    self.written.entry((item.clone(), version.clone())).or_default().insert(*offset, bytes.clone());
                }
                Command::ReadLocal { demand, offset, length } => {
                    let piece = self.local[demand][*offset as usize..(*offset + *length) as usize].to_vec();
                    let (demand, offset) = (*demand, *offset);
                    self.log.push(command.clone());
                    self.event_with(json!({"local_bytes": {"demand": demand, "offset": offset}}), &piece);
                    continue;
                }
                _ => {}
            }
            self.log.push(command);
        }
    }

    fn carry(&mut self, request: u64, operation: &str, input: &Value) {
        let link = self.link;
        if link.silent {
            return;
        }
        if link.down {
            let at = self.now + link.round_trip_ms;
            self.arrivals.insert((at, request), Arrival { request, reached: false, headers: json!({}), sent_ms: self.now, first_byte_ms: at, body: Vec::new() });
            return;
        }
        if operation == "list_changes" && input.get("wait") == Some(&json!(true)) {
            // A wait with no cursor waits from now.
            let mut input = input.clone();
            if input.get("after").is_none() {
                input["after"] = json!(self.store.log.len().to_string());
            }
            let reply = self.store.call(operation, &input);
            if self.holds_waits && reply.answer().is_some_and(|answer| answer["changes"].as_array().is_some_and(|changes| changes.is_empty())) {
                self.parked.push((request, input));
                return;
            }
            self.arrive(request, reply);
            return;
        }
        let mut reply = self.store.call(operation, input);
        if let Some(tamper) = self.tamper.as_mut() {
            tamper(operation, input, &mut reply);
        }
        // The store reads a span's objects one after another before it answers.
        let serving = if operation == "read_file_span" && link.store_ms_per_object > 0 {
            let (offset, length) = (input["offset"].as_u64().unwrap(), input["length"].as_u64().unwrap());
            let objects = (offset + length).div_ceil(link.object_bytes) - offset / link.object_bytes;
            objects * link.store_ms_per_object
        } else {
            0
        };
        self.arrive_after(request, reply, serving);
    }

    fn arrive(&mut self, request: u64, reply: Reply) {
        self.arrive_after(request, reply, 0);
    }

    fn arrive_after(&mut self, request: u64, reply: Reply, serving: u64) {
        let link = self.link;
        let (body, headers) = reply.wire(request);
        let first_byte = (self.now + link.round_trip_ms + serving).max(self.link_free);
        let done = first_byte + (body.len() as f64 / link.bytes_per_ms).ceil() as u64;
        self.link_free = done;
        self.arrivals.insert((done, request), Arrival { request, reached: true, headers, sent_ms: self.now, first_byte_ms: first_byte, body });
    }

    /// Answer parked watches that now have changes.
    pub fn wake_watches(&mut self) {
        let parked = std::mem::take(&mut self.parked);
        for (request, input) in parked {
            self.carry(request, "list_changes", &input);
        }
    }

    /// Deliver the next arrival; false when none is on its way.
    pub fn step(&mut self) -> bool {
        let Some((&(at, key), _)) = self.arrivals.iter().next() else { return false };
        let arrival = self.arrivals.remove(&(at, key)).unwrap();
        self.now = self.now.max(at);
        let event = json!({"answer": {"request": arrival.request, "reached": arrival.reached, "sent_ms": arrival.sent_ms, "first_byte_ms": arrival.first_byte_ms, "done_ms": at, "headers": arrival.headers}});
        self.event_with(event, &arrival.body);
        true
    }

    /// Deliver every arrival.
    pub fn settle(&mut self) {
        while self.step() {}
    }

    /// Move the clock to `at`, delivering what arrives before it, then tell the core the time.
    pub fn until(&mut self, at: u64) {
        while self.arrivals.keys().next().is_some_and(|(arrives, _)| *arrives <= at) {
            self.step();
        }
        self.now = self.now.max(at);
        self.event(json!({"tick": null}));
    }

    /// Run until a command matching `found` appears for the first time after `from` entries of the log.
    pub fn until_logged(&mut self, from: usize, found: impl Fn(&Command) -> bool) -> Option<Command> {
        loop {
            if let Some(command) = self.log[from..].iter().find(|command| found(command)) {
                return Some(command.clone());
            }
            if !self.step() {
                return None;
            }
        }
    }

    pub fn commands(&self, from: usize) -> &[Command] {
        &self.log[from..]
    }

    /// The items a page of a folder lists.
    pub fn list(&mut self, demand: u64, folder: &str) -> Command {
        let from = self.log.len();
        self.event(json!({"list": {"demand": demand, "folder": folder, "page": null, "page_size": null}}));
        self.until_logged(from, |command| matches!(command, Command::Items { demand: asked, .. } | Command::Failed { demand: asked, .. } if *asked == demand)).expect("the list is answered")
    }

    pub fn item_id(&self, name: &str) -> String {
        self.store.names[name].item.clone()
    }

    pub fn identity(&self, name: &str) -> String {
        self.store.names[name].identity.clone()
    }

    /// Fetch a range and wait for its answer; answers the command and the time it took.
    pub fn fetch(&mut self, demand: u64, name: &str, offset: u64, length: u64, alignment: u64) -> (Command, u64) {
        let (item, version) = (self.item_id(name), self.identity(name));
        let from = self.log.len();
        let asked = self.now;
        self.event(json!({"fetch": {"demand": demand, "item": item, "version": version, "offset": offset, "length": length, "alignment": alignment}}));
        let answer = self
            .until_logged(from, |command| matches!(command, Command::Fetched { demand: asked, .. } | Command::Failed { demand: asked, .. } if *asked == demand))
            .expect("the fetch is answered");
        (answer, self.now - asked)
    }

    pub fn handed(&mut self, demand: u64) {
        self.event(json!({"handed": {"demand": demand}}));
    }

    /// The bytes the OS holds for a version at a range, from the core's writes.
    pub fn held(&self, name: &str, offset: u64, length: u64) -> Option<Vec<u8>> {
        let key = (self.item_id(name), self.identity(name));
        let writes = self.written.get(&key)?;
        let mut out = Vec::new();
        let mut at = offset;
        while at < offset + length {
            let (start, bytes) = writes.range(..=at).next_back()?;
            let end = start + bytes.len() as u64;
            if end <= at {
                return None;
            }
            let take = (end.min(offset + length) - at) as usize;
            let from = (at - start) as usize;
            out.extend_from_slice(&bytes[from..from + take]);
            at += take as u64;
        }
        Some(out)
    }

    pub fn failed_with(&self, from: usize, demand: u64) -> Option<Problem> {
        self.log[from..].iter().find_map(|command| match command {
            Command::Failed { demand: asked, problem, .. } if *asked == demand => Some(*problem),
            _ => None,
        })
    }

    pub fn done(&mut self, from: usize, demand: u64) -> Command {
        self.until_logged(from, |command| matches!(command, Command::Done { demand: asked, .. } | Command::Failed { demand: asked, .. } if *asked == demand)).expect("the work is answered")
    }

    pub fn create_file(&mut self, demand: u64, parent: &str, name: &str, bytes: &[u8]) -> Command {
        self.local.insert(demand, bytes.to_vec());
        let from = self.log.len();
        self.event(json!({"create": {"demand": demand, "parent": parent, "name": name, "folder": false, "length": bytes.len(), "media_type": null, "date": "2026-11-17"}}));
        self.done(from, demand)
    }

    pub fn edit_file(&mut self, demand: u64, item: &str, base: &str, bytes: &[u8]) -> Command {
        self.local.insert(demand, bytes.to_vec());
        let from = self.log.len();
        self.event(json!({"modify": {"demand": demand, "item": item, "base_version": base, "parent": null, "name": null, "length": bytes.len(), "media_type": null, "date": "2026-11-17"}}));
        self.done(from, demand)
    }
}
