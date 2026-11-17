//! The files core: one state machine for every OS. A shell hands it events; it answers commands. It opens no socket,
//! file or clock (L002): the shell sends what `send` asks, writes what `write` asks, reads what `read_local` asks,
//! and tells the time in every event.
//!
//! Invariants
//!   - Every request goes to the account's computers in their order, starting from the one that answered last; a
//!     computer that does not answer, or stalls past the contract's idle bound, is passed over for the next.
//!   - A span answer is handed on only after its check (check.rs); read-ahead is trained only by a copy the OS was
//!     handed (f1 bug 14), and sized from what the link and the reader measure (link.rs).
//!   - Every write names the version it expects; an edit that meets a newer version is kept beside it as a conflict
//!     copy with a plain name, never written over it (f2 rule 7).
//!   - An item with an edit not yet kept reports `uploaded: false`, so the OS never evicts it (f2 rule 3).
//!   - No retry runs on the core's own clock: a busy computer's wait is the time it named, checked when an event
//!     brings the host's time.

use std::collections::{HashMap, HashSet, VecDeque};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::{json, Map, Value};

use crate::check::{checked_span, Asked};
use crate::data::{Contract, Setup};
use crate::errors::{problem_of, Problem};
use crate::items::{item_of_row, ItemTable, ItemView};
use crate::link::Link;
use crate::names;
use crate::protocol::{Command, Event, EventKind};
use crate::ranges::{Span, SpanSet};
use crate::rules::RuleSet;

/// Milliseconds in a second: a unit, for the contract's `retry_after_seconds`.
const MS_PER_SECOND: u64 = 1000;

#[derive(Clone, Debug)]
enum Purpose {
    Anchor { demand: u64 },
    Item { demand: u64 },
    List { demand: u64 },
    Changes { demand: u64 },
    Watch,
    Span { item: String, identity: String, span: Span, size: u64 },
    Thumbnail { identity: String, size: u64 },
    Work { demand: u64, stage: Stage },
}

/// Which request of a work's step an answer is for.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    Step,
    UploadStart,
    UploadPiece { end: u64 },
    UploadFinish,
}

struct Pending {
    purpose: Purpose,
    computer: usize,
    tried: usize,
    url_operation: String,
    body: Vec<u8>,
    sent_ms: u64,
    deadline_ms: Option<u64>,
    retry_at_ms: Option<u64>,
}

#[derive(Default)]
struct Stream {
    held: SpanSet,
    inflight: Vec<Span>,
    /// The last span the OS was handed (start, end, when).
    last_handed: Option<(u64, u64, u64)>,
    /// Bytes per ms a sequential reader consumes, measured between handovers.
    consumption: Option<f64>,
}

impl Stream {
    fn covered(&self) -> SpanSet {
        let mut covered = self.held.clone();
        for span in &self.inflight {
            covered.insert(*span);
        }
        covered
    }

    /// A span the OS was handed at `now_ms`, for a read the OS asked at `asked_ms`. A reader's pace is measured from
    /// its previous handover to its next ask: the time it spent consuming, never the time it spent waiting for
    /// bytes. A reader that asks again at once consumes as fast as it is served.
    fn handed(&mut self, span: Span, asked_ms: u64, now_ms: u64) {
        self.consumption = match self.last_handed {
            Some((start, end, at)) if span.start >= start && span.start <= end && span.end > end => {
                let consuming = asked_ms.saturating_sub(at);
                Some(if consuming > 0 { (span.end - end) as f64 / consuming as f64 } else { f64::INFINITY })
            }
            _ => None,
        };
        self.last_handed = Some((span.start, span.end, now_ms));
    }
}

struct FetchDemand {
    key: (String, String),
    span: Span,
    asked_ms: u64,
    fetched: bool,
}

struct Upload {
    /// The name the bytes are kept under: the item's, or a conflict copy's.
    name: String,
    /// The name asked for, from which a conflict copy's name is made.
    asked_name: String,
    /// Whether the name must not exist yet (a new file, a conflict copy); otherwise the bytes replace the version of the
    /// item the table holds when the upload starts.
    new_name: bool,
    length: u64,
    media_type: Option<String>,
    upload_id: Option<String>,
    hasher: blake3::Hasher,
    hashed: u64,
    accepted: u64,
    attempt: Option<u64>,
    date: String,
}

enum Step {
    Move { to: String, after: Option<String> },
    SetAside { after: Option<String> },
    MakeFolder { name: String },
    /// Read the work's item again (after a move), or find the item a new name holds (after a new file is kept).
    Refresh,
    Upload(Box<Upload>),
    /// Read this device's pin rules naming the item, then keep or stop keeping it here.
    PinRead { keep: bool, after: Option<String> },
    PinWrite { job: &'static str, input: Map<String, Value> },
}

struct Work {
    item: Option<String>,
    /// The name a new item was kept under, until its item is found.
    made_name: Option<String>,
    steps: VecDeque<Step>,
    kept_beside: bool,
    removed: bool,
}

pub struct Core {
    contract: &'static Contract,
    setup: Setup,
    items: ItemTable,
    ignores: RuleSet,
    link: Link,
    now_ms: u64,
    next_request: u64,
    pending: HashMap<u64, Pending>,
    preferred: usize,
    troubled: bool,
    want_watch: bool,
    watching: bool,
    /// When the last change wait was sent, and the earliest an empty one may be asked again.
    watch_sent_ms: u64,
    rewatch_at_ms: Option<u64>,
    /// The last `wake` told to the shell.
    told_wake: Option<u64>,
    cursor: Option<String>,
    streams: HashMap<(String, String), Stream>,
    fetches: HashMap<u64, FetchDemand>,
    works: HashMap<u64, Work>,
    thumbnails: HashMap<(String, u64), Vec<u64>>,
    uploading: HashSet<String>,
    out: VecDeque<(Command, Vec<u8>)>,
}

impl Core {
    /// A core for one device of one account.
    pub fn new(setup: Setup) -> Result<Core, String> {
        if setup.computers.is_empty() {
            return Err("the setup lists no computer of the account".into());
        }
        let bounds = setup.bounds;
        if bounds.span_most_bytes == 0 || bounds.piece_most_bytes == 0 || bounds.idle_ms == 0 {
            return Err("the setup's bounds are the contract's own numbers, each above 0".into());
        }
        let mut core = Core {
            contract: Contract::shipped(),
            setup,
            items: ItemTable::default(),
            ignores: RuleSet::default(),
            link: Link::default(),
            now_ms: 0,
            next_request: 0,
            pending: HashMap::new(),
            preferred: 0,
            troubled: false,
            want_watch: false,
            watching: false,
            watch_sent_ms: 0,
            rewatch_at_ms: None,
            told_wake: None,
            cursor: None,
            streams: HashMap::new(),
            fetches: HashMap::new(),
            works: HashMap::new(),
            thumbnails: HashMap::new(),
            uploading: HashSet::new(),
            out: VecDeque::new(),
        };
        let (root, trash) = (core.setup.root.id.clone(), core.contract.trash_id.clone());
        core.emit(Command::Ready { root, trash });
        Ok(core)
    }

    /// The next command and the bytes it carries (empty when it carries none).
    pub fn next_command(&mut self) -> Option<(Command, Vec<u8>)> {
        self.out.pop_front()
    }

    /// The measured link, for a shell that shows it and for tests.
    pub fn link(&self) -> Link {
        self.link
    }

    /// One event, with the bytes it carries (empty when it carries none).
    pub fn handle(&mut self, event: Event, bytes: &[u8]) {
        self.now_ms = self.now_ms.max(event.now_ms);
        match event.kind {
            EventKind::Rules { ignore } => self.rules(&ignore),
            EventKind::Restore { state } => self.restore(state),
            EventKind::Keep => {
                let state = json!({
                    "items": serde_json::to_value(&self.items).unwrap_or(Value::Null),
                    "cursor": self.cursor,
                });
                self.emit(Command::State { state });
            }
            EventKind::Watch => {
                self.want_watch = true;
                self.watch();
            }
            EventKind::Anchor { demand } => {
                self.request(Purpose::Anchor { demand }, "changes", Map::new());
            }
            EventKind::Item { demand, item } => {
                if item == self.setup.root.id {
                    let items = vec![self.items.root_view(&self.setup.root)];
                    self.emit(Command::Items { demand, items, next_page: None });
                } else {
                    let mut input = self.for_device();
                    input.insert(self.contract.field("item_asked").into(), json!(item));
                    self.request(Purpose::Item { demand }, "item", input);
                }
            }
            EventKind::List { demand, folder, page, page_size } => self.list(demand, &folder, page, page_size),
            EventKind::Pin { demand, item, keep } => self.pin(demand, &item, keep),
            EventKind::Changes { demand, anchor, page_size } => {
                let mut input = self.for_device();
                input.insert(self.contract.field("changes_after").into(), json!(anchor));
                if let Some(size) = page_size {
                    input.insert(self.contract.field("changes_limit").into(), json!(size));
                }
                self.request(Purpose::Changes { demand }, "changes", input);
            }
            EventKind::Fetch { demand, item, version, offset, length, alignment } => {
                self.fetch(demand, &item, &version, Span::new(offset, offset.saturating_add(length)), alignment)
            }
            EventKind::Handed { demand } => self.handed(demand),
            EventKind::Thumbnail { demand, item, version, size } => self.thumbnail(demand, &item, &version, size),
            EventKind::Create { demand, parent, name, folder, length, media_type, date } => {
                self.create(demand, &parent, &name, folder, length, media_type, date)
            }
            EventKind::Modify { demand, item, base_version, parent, name, length, media_type, date } => {
                self.modify(demand, &item, base_version, parent, name, length, media_type, date)
            }
            EventKind::Delete { demand, item, base_version } => self.delete(demand, &item, base_version),
            EventKind::LocalBytes { demand, offset } => self.local_bytes(demand, offset, bytes),
            EventKind::Answer { request, status, sent_ms, first_byte_ms, done_ms } => {
                self.answer(request, status, sent_ms, first_byte_ms, done_ms, bytes)
            }
            EventKind::Tick => {}
            EventKind::Cancel { demand } => {
                self.fetches.remove(&demand);
                if let Some(work) = self.works.remove(&demand) {
                    if let Some(item) = work.item {
                        self.uploading.remove(&item);
                    }
                }
                for waiting in self.thumbnails.values_mut() {
                    waiting.retain(|asked| *asked != demand);
                }
            }
        }
        self.on_time();
        self.tell_wake();
    }

    /// Tell the shell when the next tick is due, when that moved.
    fn tell_wake(&mut self) {
        let due = self
            .pending
            .values()
            .filter_map(|pending| pending.retry_at_ms.or(pending.deadline_ms))
            .chain(self.rewatch_at_ms)
            .min();
        if let Some(at_ms) = due.filter(|due| Some(*due) != self.told_wake) {
            self.emit(Command::Wake { at_ms });
        }
        self.told_wake = due;
    }

    fn emit(&mut self, command: Command) {
        self.out.push_back((command, Vec::new()));
    }

    fn emit_bytes(&mut self, command: Command, bytes: Vec<u8>) {
        self.out.push_back((command, bytes));
    }

    fn fail(&mut self, demand: u64, problem: Problem) {
        self.emit(Command::Failed { demand, problem, retry_after_ms: None });
    }

    // ---- items and rules -------------------------------------------------------------------------------------------

    fn ignored(&self, name: &str, folder: bool, media_type: Option<&str>, size: Option<u64>) -> bool {
        !self.ignores.is_empty()
            && self.ignores.holds(&self.setup.device, &ItemTable::facts(self.contract, name, folder, media_type, size))
    }

    fn view(&self, id: &str) -> Option<ItemView> {
        if id == self.setup.root.id {
            return Some(self.items.root_view(&self.setup.root));
        }
        self.items.view(&self.setup.root, id, !self.uploading.contains(id))
    }

    fn views(&self, ids: &[String]) -> Vec<ItemView> {
        let mut seen = HashSet::new();
        ids.iter().filter(|id| seen.insert((*id).clone())).filter_map(|id| self.view(id)).collect()
    }

    /// The contract folder name an OS folder id stands for.
    fn folder_name(&self, id: &str) -> Option<String> {
        if id == self.setup.root.id {
            return Some(self.setup.root.folder.clone());
        }
        self.items.get(id).filter(|item| item.folder).map(|item| item.name.clone())
    }

    /// An input naming this device, so the contract answers `kept` for it.
    fn for_device(&self) -> Map<String, Value> {
        let mut input = Map::new();
        input.insert(self.contract.field("device").into(), json!(self.setup.device));
        input
    }

    fn rules(&mut self, ignore: &[Value]) {
        let (ignores, refused) = RuleSet::from_rows(self.contract, ignore);
        self.ignores = ignores;
        if !refused.is_empty() {
            self.emit(Command::RulesRefused { refused });
        }
        self.emit(Command::Signal);
    }

    fn restore(&mut self, state: Value) {
        if let Some(items) = state.get("items").and_then(|items| serde_json::from_value::<ItemTable>(items.clone()).ok()) {
            self.items = items;
        }
        self.cursor = state.get("cursor").and_then(Value::as_str).map(str::to_owned);
        // After a restart the OS asks again from its own anchor, so the root is never left stale (f1 bug 6).
        self.emit(Command::Signal);
    }

    // ---- requests --------------------------------------------------------------------------------------------------

    /// Send one contract call for a job; a job the contract does not offer fails as `not_offered`.
    fn request(&mut self, purpose: Purpose, job: &str, input: Map<String, Value>) {
        let Some(operation) = self.contract.operation(job).map(str::to_owned) else {
            self.failed(purpose, Problem::NotOffered);
            return;
        };
        let body = Value::Object(input).to_string().into_bytes();
        let computer = self.preferred;
        self.send(Pending {
            purpose,
            computer,
            tried: 0,
            url_operation: operation,
            body,
            sent_ms: self.now_ms,
            deadline_ms: None,
            retry_at_ms: None,
        });
    }

    fn send(&mut self, mut pending: Pending) {
        self.next_request += 1;
        let request = self.next_request;
        let expected = match &pending.purpose {
            Purpose::Span { span, .. } => span.len(),
            _ => pending.body.len() as u64,
        };
        pending.sent_ms = self.now_ms;
        pending.retry_at_ms = None;
        pending.deadline_ms = match pending.purpose {
            Purpose::Watch => None,
            _ => Some(self.link.deadline_ms(&self.setup.bounds, self.now_ms, expected)),
        };
        let origin = &self.setup.computers[pending.computer].origin;
        let url = format!(
            "{}{}",
            origin.trim_end_matches('/'),
            self.contract.call.path.replace("{operation}", &pending.url_operation)
        );
        let command = Command::Send {
            request,
            method: self.contract.call.method.clone(),
            url,
            content_type: self.contract.call.content_type.clone(),
            bytes: pending.body.len(),
        };
        let body = pending.body.clone();
        self.pending.insert(request, pending);
        self.emit_bytes(command, body);
    }

    /// Ask the next computer, or fail once every computer was asked.
    fn fail_over(&mut self, mut pending: Pending) {
        let count = self.setup.computers.len();
        if pending.tried + 1 < count {
            pending.tried += 1;
            pending.computer = (pending.computer + 1) % count;
            self.send(pending);
        } else {
            self.troubled = true;
            self.failed(pending.purpose, Problem::Unreachable);
        }
    }

    /// The time an event brought: busy computers' waits that ended, requests that stalled, a change wait due again.
    fn on_time(&mut self) {
        let now = self.now_ms;
        if self.rewatch_at_ms.is_some_and(|at| at <= now) {
            self.rewatch_at_ms = None;
            self.watch();
        }
        let due: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.retry_at_ms.is_some_and(|at| at <= now))
            .map(|(request, _)| *request)
            .collect();
        for request in due {
            if let Some(pending) = self.pending.remove(&request) {
                self.send(pending);
            }
        }
        let stalled: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.retry_at_ms.is_none() && pending.deadline_ms.is_some_and(|at| at < now))
            .map(|(request, _)| *request)
            .collect();
        for request in stalled {
            if let Some(pending) = self.pending.remove(&request) {
                self.emit(Command::Abandon { request });
                self.fail_over(pending);
            }
        }
    }

    fn answer(&mut self, request: u64, status: Option<u16>, sent_ms: u64, first_byte_ms: u64, done_ms: u64, body: &[u8]) {
        let Some(mut pending) = self.pending.remove(&request) else { return };
        let Some(status) = status else {
            self.fail_over(pending);
            return;
        };
        if matches!(pending.purpose, Purpose::Span { .. }) {
            self.link.read_waited(sent_ms, first_byte_ms);
        }
        self.link.sample(sent_ms, first_byte_ms, done_ms, body.len() as u64);
        let parsed: Option<Value> = serde_json::from_slice(body).ok();
        if status != self.contract.answered_status {
            let code = parsed
                .as_ref()
                .and_then(|value| value.get(self.contract.field("failure_code")))
                .and_then(Value::as_str);
            match problem_of(self.contract, status, code) {
                Problem::Unreachable => self.fail_over(pending),
                problem => {
                    self.reached(pending.computer);
                    self.failed(pending.purpose, problem);
                }
            }
            return;
        }
        let Some(answer) = parsed else {
            self.fail_over(pending);
            return;
        };
        self.reached(pending.computer);
        if answer.get(self.contract.field("busy")).and_then(Value::as_bool) == Some(true) {
            let wait = answer
                .get(self.contract.field("retry_after_seconds"))
                .and_then(Value::as_u64)
                .unwrap_or_default();
            pending.retry_at_ms = Some(self.now_ms + wait * MS_PER_SECOND);
            self.next_request += 1;
            self.pending.insert(self.next_request, pending);
            return;
        }
        self.answered(pending.purpose, answer, body);
    }

    /// A computer answered: it is asked first from now on, and a problem that stopped work is over.
    fn reached(&mut self, computer: usize) {
        self.preferred = computer;
        if self.troubled {
            self.troubled = false;
            self.emit(Command::Resolved);
        }
        if self.want_watch && !self.watching {
            self.watch();
        }
    }

    fn failed(&mut self, purpose: Purpose, problem: Problem) {
        match purpose {
            Purpose::Anchor { demand } | Purpose::Item { demand } | Purpose::List { demand } | Purpose::Changes { demand } => {
                self.fail(demand, problem)
            }
            Purpose::Watch => self.watching = false,
            Purpose::Span { item, identity, span, .. } => {
                let key = (item, identity);
                if let Some(stream) = self.streams.get_mut(&key) {
                    stream.inflight.retain(|asked| *asked != span);
                }
                let failed: Vec<u64> = self
                    .fetches
                    .iter()
                    .filter(|(_, fetch)| !fetch.fetched && fetch.key == key && fetch.span.start < span.end && span.start < fetch.span.end)
                    .map(|(demand, _)| *demand)
                    .collect();
                for demand in failed {
                    self.fetches.remove(&demand);
                    self.fail(demand, problem);
                }
            }
            Purpose::Thumbnail { identity, size } => {
                for demand in self.thumbnails.remove(&(identity, size)).unwrap_or_default() {
                    self.fail(demand, problem);
                }
            }
            Purpose::Work { demand, stage } => self.work_failed(demand, stage, problem),
        }
    }

    fn answered(&mut self, purpose: Purpose, answer: Value, body: &[u8]) {
        match purpose {
            Purpose::Anchor { demand } => {
                let anchor = self.text(&answer, "changes_next").unwrap_or_default();
                self.emit(Command::Anchor { demand, anchor });
            }
            Purpose::Item { demand } => {
                let folder = self.is_folder_row(&answer);
                match item_of_row(self.contract, &answer, folder) {
                    Some(item) => {
                        let id = item.id.clone();
                        self.items.upsert(item);
                        let items = self.views(&[id]);
                        self.emit(Command::Items { demand, items, next_page: None });
                    }
                    None => self.fail(demand, Problem::NotOffered),
                }
            }
            Purpose::List { demand } => self.listed(demand, &answer),
            Purpose::Changes { demand } => self.changed(demand, &answer),
            Purpose::Watch => self.watched(&answer),
            Purpose::Span { item, identity, span, size } => self.span_arrived(item, identity, span, size, body),
            Purpose::Thumbnail { identity, size } => {
                let waiting = self.thumbnails.remove(&(identity, size)).unwrap_or_default();
                let bytes = self
                    .text(&answer, "thumbnail_content")
                    .and_then(|content| BASE64.decode(content).ok());
                // No content: no maker takes the file's media type, so there is no picture of it.
                for demand in waiting {
                    match &bytes {
                        Some(bytes) => self.emit_bytes(Command::Thumbnail { demand, bytes: bytes.len() }, bytes.clone()),
                        None => self.fail(demand, Problem::Missing),
                    }
                }
            }
            Purpose::Work { demand, stage } => self.work_answered(demand, stage, &answer),
        }
    }

    fn text(&self, answer: &Value, job: &str) -> Option<String> {
        answer.get(self.contract.field(job)).and_then(Value::as_str).map(str::to_owned)
    }

    /// Whether a contract row is a folder's, by its kind.
    fn is_folder_row(&self, row: &Value) -> bool {
        row.get(self.contract.field("change_kind")).and_then(Value::as_str) == Some(self.contract.item_kinds.folder.as_str())
    }

    // ---- listing and changes ---------------------------------------------------------------------------------------

    fn list(&mut self, demand: u64, folder: &str, page: Option<String>, page_size: Option<u64>) {
        if folder == self.contract.trash_id {
            // Deleted names are in Recently Deleted, the contract's set-aside tree; the OS trash lists nothing.
            self.emit(Command::Items { demand, items: Vec::new(), next_page: None });
            return;
        }
        let Some(name) = self.folder_name(folder) else {
            self.fail(demand, Problem::Missing);
            return;
        };
        let mut input = self.for_device();
        input.insert(self.contract.field("list_folder").into(), json!(name));
        if let Some(page) = page {
            input.insert(self.contract.field("list_after").into(), json!(page));
        }
        if let Some(size) = page_size {
            input.insert(self.contract.field("list_limit").into(), json!(size));
        }
        self.request(Purpose::List { demand }, "list", input);
    }

    fn listed(&mut self, demand: u64, answer: &Value) {
        let rows = |job: &str| answer.get(self.contract.field(job)).and_then(Value::as_array).cloned().unwrap_or_default();
        // A child folder is listed by its name, with its stable fields beside it in `folder_items`.
        let folder_items = answer.get(self.contract.field("list_folder_items")).and_then(Value::as_object).cloned().unwrap_or_default();
        let folders = rows("list_folders").into_iter().map(|folder| {
            let name = folder.as_str().map(str::to_owned);
            match (name, folder) {
                (Some(name), _) => {
                    let mut row = folder_items.get(&name).and_then(Value::as_object).cloned().unwrap_or_default();
                    row.insert(self.contract.field("name").into(), json!(name));
                    Value::Object(row)
                }
                (None, row) => row,
            }
        });
        let mut found = Vec::new();
        for (row, folder) in rows("list_files").into_iter().map(|row| (row, false)).chain(folders.map(|row| (row, true))) {
            match item_of_row(self.contract, &row, folder) {
                Some(item) => found.push(item),
                None => {
                    // A row with no stable item id cannot be shown: a path is never an item id.
                    self.fail(demand, Problem::NotOffered);
                    return;
                }
            }
        }
        let mut shown = Vec::new();
        for item in found {
            if self.ignored(&item.name, item.folder, item.media_type.as_deref(), item.size) {
                continue;
            }
            shown.push(item.id.clone());
            self.items.upsert(item);
        }
        let items = self.views(&shown);
        let next_page = self.text(answer, "list_next");
        self.emit(Command::Items { demand, items, next_page });
    }

    /// Apply one page of changes; answers the ids that changed and the ids removed.
    fn apply_changes(&mut self, answer: &Value) -> (Vec<String>, Vec<String>) {
        let mut updated = Vec::new();
        let mut removed = Vec::new();
        let changes = answer.get(self.contract.field("changes")).and_then(Value::as_array).cloned().unwrap_or_default();
        for change in changes {
            let op = change.get(self.contract.field("change_op")).and_then(Value::as_str);
            let folder = self.is_folder_row(&change);
            let id = change.get(self.contract.field("item")).and_then(Value::as_str).map(str::to_owned);
            if op == Some(self.contract.field("change_put")) {
                let Some(item) = item_of_row(self.contract, &change, folder) else { continue };
                if self.ignored(&item.name, item.folder, item.media_type.as_deref(), item.size) {
                    if self.items.get(&item.id).is_some() {
                        updated.extend(self.items.remove(&item.id));
                        removed.push(item.id);
                    }
                    continue;
                }
                updated.extend(self.items.upsert(item));
            } else if op == Some(self.contract.field("change_remove")) {
                if let Some(id) = id {
                    updated.extend(self.items.remove_tree(&id));
                    removed.push(id);
                }
            }
        }
        updated.retain(|id| !removed.contains(id));
        (updated, removed)
    }

    fn changed(&mut self, demand: u64, answer: &Value) {
        let (updated, removed) = self.apply_changes(answer);
        let updated = self.views(&updated);
        let anchor = self.text(answer, "changes_next").unwrap_or_default();
        let more = answer.get(self.contract.field("changes_more")).and_then(Value::as_bool).unwrap_or(false);
        self.emit(Command::Changed { demand, updated, removed, anchor, more });
    }

    fn watch(&mut self) {
        if self.watching || self.rewatch_at_ms.is_some() || self.contract.operation("changes").is_none() {
            return;
        }
        self.watching = true;
        self.watch_sent_ms = self.now_ms;
        let mut input = self.for_device();
        if let Some(cursor) = &self.cursor {
            input.insert(self.contract.field("changes_after").into(), json!(cursor));
        }
        input.insert(self.contract.field("changes_wait").into(), json!(true));
        self.request(Purpose::Watch, "changes", input);
    }

    fn watched(&mut self, answer: &Value) {
        self.watching = false;
        let changes = answer.get(self.contract.field("changes")).and_then(Value::as_array).is_some_and(|changes| !changes.is_empty());
        let had_cursor = self.cursor.is_some();
        self.cursor = self.text(answer, "changes_next").or(self.cursor.take());
        // One signal per answer, however many changes it carried (f1 bug 7, refresh storms).
        if changes {
            self.emit(Command::Signal);
        }
        // A wait that came back empty is asked again no sooner than the contract's idle bound after it was sent: a
        // computer that held it that long loses nothing, and one that did not hold it is never asked in a tight loop.
        // The first wait (no cursor yet) only learns the cursor of now, so the real wait follows at once.
        let again = self.watch_sent_ms + self.setup.bounds.idle_ms;
        if had_cursor && !changes && again > self.now_ms {
            self.rewatch_at_ms = Some(again);
            return;
        }
        self.watch();
    }

    // ---- reading ---------------------------------------------------------------------------------------------------

    fn fetch(&mut self, demand: u64, item_id: &str, version: &str, asked: Span, alignment: u64) {
        let Some(item) = self.items.get(item_id) else {
            self.fail(demand, Problem::Missing);
            return;
        };
        if item.identity.as_deref() != Some(version) {
            self.fail(demand, Problem::StaleVersion);
            return;
        }
        let Some(size) = item.size else {
            self.fail(demand, Problem::Missing);
            return;
        };
        let span = if self.link.take_whole(size) { Span::new(0, size) } else { asked.aligned(alignment, size) };
        let key = (item_id.to_owned(), version.to_owned());
        self.fetches.insert(demand, FetchDemand { key: key.clone(), span, asked_ms: self.now_ms, fetched: false });
        self.ask_for(&key, span, size, None);
        self.settle(&key);
    }

    /// Ask for the parts of `span` neither held nor already asked for, each at most what one request may carry.
    fn ask_for(&mut self, key: &(String, String), span: Span, size: u64, piece: Option<u64>) {
        let most = self.link.request_most(&self.setup.bounds, self.setup.bounds.span_most_bytes);
        let most = piece.map_or(most, |piece| piece.min(most));
        let stream = self.streams.entry(key.clone()).or_default();
        let missing = stream.covered().missing(span);
        let mut asked = Vec::new();
        for gap in missing {
            for piece in gap.pieces(most) {
                stream.inflight.push(piece);
                asked.push(piece);
            }
        }
        for piece in asked {
            let mut input = Map::new();
            input.insert(self.contract.field("span_asked").into(), json!(key.1));
            input.insert(self.contract.field("span_offset").into(), json!(piece.start));
            input.insert(self.contract.field("span_length").into(), json!(piece.len()));
            self.request(Purpose::Span { item: key.0.clone(), identity: key.1.clone(), span: piece, size }, "read_span", input);
        }
    }

    fn span_arrived(&mut self, item: String, identity: String, span: Span, size: u64, body: &[u8]) {
        let key = (item, identity);
        let asked = Asked { identity: key.1.clone(), span, size };
        match checked_span(self.contract, &asked, body) {
            Ok(bytes) => {
                let stream = self.streams.entry(key.clone()).or_default();
                stream.inflight.retain(|piece| *piece != span);
                stream.held.insert(span);
                self.emit_bytes(
                    Command::Write { item: key.0.clone(), version: key.1.clone(), offset: span.start, bytes: bytes.len() },
                    bytes,
                );
                self.settle(&key);
            }
            Err(_) => self.failed(Purpose::Span { item: key.0, identity: key.1, span, size }, Problem::RefusedCopy),
        }
    }

    /// Answer every fetch of a stream whose span is now held, and report the progress of the others.
    fn settle(&mut self, key: &(String, String)) {
        let Some(stream) = self.streams.get(key) else { return };
        let mut answers = Vec::new();
        for (demand, fetch) in self.fetches.iter_mut().filter(|(_, fetch)| &fetch.key == key && !fetch.fetched) {
            let total = fetch.span.len();
            let missing: u64 = stream.held.missing(fetch.span).iter().map(Span::len).sum();
            if missing == 0 {
                fetch.fetched = true;
                answers.push(Command::Progress { demand: *demand, done: total, total });
                answers.push(Command::Fetched { demand: *demand, offset: fetch.span.start, length: total });
            } else {
                answers.push(Command::Progress { demand: *demand, done: total - missing, total });
            }
        }
        answers.sort_by_key(|command| match command {
            Command::Progress { demand, .. } | Command::Fetched { demand, .. } => *demand,
            _ => 0,
        });
        for command in answers {
            self.emit(command);
        }
    }

    /// The OS has the copy: train read-ahead from it, and ask for what a sequential reader needs next.
    fn handed(&mut self, demand: u64) {
        let Some(fetch) = self.fetches.remove(&demand) else { return };
        if !fetch.fetched {
            return;
        }
        let now = self.now_ms;
        let Some(size) = self.items.get(&fetch.key.0).and_then(|item| item.size) else { return };
        let stream = self.streams.entry(fetch.key.clone()).or_default();
        stream.handed(fetch.span, fetch.asked_ms, now);
        let Some(consumption) = stream.consumption else { return };
        let read = fetch.span.len();
        let Some(ahead) = self.link.ahead_bytes(consumption, read) else { return };
        // Only the shortfall is asked: the bytes held or on their way stay `ahead` past the reader, topped up at
        // every handover, so the link carries a steady stream and never a late burst.
        let from = fetch.span.end;
        let frontier = stream.covered().held_until(from);
        // Whole reads ahead, so a piece never straddles two of the reader's reads and one read never waits for two.
        let wanted_until = from.saturating_add(ahead.div_ceil(read).saturating_mul(read)).min(size);
        if frontier >= wanted_until {
            return;
        }
        let want = Span::new(frontier, wanted_until);
        self.ask_for(&fetch.key, want, size, Some(read));
    }

    fn thumbnail(&mut self, demand: u64, item_id: &str, version: &str, size: u64) {
        if self.items.get(item_id).and_then(|item| item.identity.as_deref()) != Some(version) {
            self.fail(demand, Problem::StaleVersion);
            return;
        }
        let key = (version.to_owned(), size);
        // One request per identity and size, however many times the OS asks meanwhile (f2 rule 8).
        if let Some(waiting) = self.thumbnails.get_mut(&key) {
            waiting.push(demand);
            return;
        }
        self.thumbnails.insert(key, vec![demand]);
        let mut input = Map::new();
        input.insert(self.contract.field("thumbnail_asked").into(), json!(version));
        input.insert(self.contract.field("thumbnail_size").into(), json!(size));
        self.request(Purpose::Thumbnail { identity: version.to_owned(), size }, "thumbnail", input);
    }

    // ---- writing ---------------------------------------------------------------------------------------------------

    fn start_work(&mut self, demand: u64, item: Option<String>, steps: VecDeque<Step>) {
        self.works.insert(demand, Work { item, made_name: None, steps, kept_beside: false, removed: false });
        self.advance(demand);
    }

    #[allow(clippy::too_many_arguments)]
    fn create(&mut self, demand: u64, parent: &str, leaf: &str, folder: bool, length: Option<u64>, media_type: Option<String>, date: String) {
        let Some(parent_name) = self.folder_name(parent) else {
            self.fail(demand, Problem::Missing);
            return;
        };
        if self.items.get(parent).is_some_and(|parent| parent.read_only) {
            self.fail(demand, Problem::Forbidden);
            return;
        }
        let name = names::join(&parent_name, leaf);
        if self.ignored(&name, folder, media_type.as_deref(), length) {
            self.emit(Command::Done { demand, item: None, kept_beside: false, ignored: true });
            return;
        }
        // A new folder's answer is its row; a new file's item is found after its upload is kept.
        let steps = if folder {
            VecDeque::from([Step::MakeFolder { name }])
        } else {
            VecDeque::from([Step::Upload(Box::new(Upload::new(name, true, length.unwrap_or_default(), media_type, date))), Step::Refresh])
        };
        self.start_work(demand, None, steps);
    }

    #[allow(clippy::too_many_arguments)]
    fn modify(
        &mut self,
        demand: u64,
        id: &str,
        base: Option<String>,
        parent: Option<String>,
        leaf: Option<String>,
        length: Option<u64>,
        media_type: Option<String>,
        date: String,
    ) {
        let Some(item) = self.items.get(id).cloned() else {
            self.fail(demand, Problem::Missing);
            return;
        };
        if item.read_only {
            self.fail(demand, Problem::Forbidden);
            return;
        }
        let folder = match parent {
            Some(parent) => match self.folder_name(&parent) {
                Some(folder) => folder,
                None => {
                    self.fail(demand, Problem::Missing);
                    return;
                }
            },
            None => names::parent(&item.name).to_owned(),
        };
        let target = names::join(&folder, leaf.as_deref().unwrap_or_else(|| names::leaf(&item.name)));
        let mut steps = VecDeque::new();
        if target != item.name {
            steps.push_back(Step::Move { to: target.clone(), after: None });
            steps.push_back(Step::Refresh);
        }
        if let Some(length) = length {
            // New bytes from a version the table no longer holds meet a newer version: they are kept beside it.
            let stale = base.is_some() && base != item.identity;
            let mut upload = Upload::new(target, stale, length, media_type.or(item.media_type.clone()), date);
            if stale {
                upload.name = names::conflict_name(self.contract, &upload.asked_name, &self.setup.device_label, &upload.date, None);
            }
            steps.push_back(Step::Upload(Box::new(upload)));
            steps.push_back(Step::Refresh);
            self.uploading.insert(id.to_owned());
            self.start_work(demand, Some(id.to_owned()), steps);
            if let Some(work) = self.works.get_mut(&demand) {
                work.kept_beside = stale;
            }
            return;
        }
        self.start_work(demand, Some(id.to_owned()), steps);
    }

    fn delete(&mut self, demand: u64, id: &str, base: Option<String>) {
        let Some(item) = self.items.get(id).cloned() else {
            self.fail(demand, Problem::Missing);
            return;
        };
        if item.read_only {
            self.fail(demand, Problem::Forbidden);
            return;
        }
        if base.is_some() && base != item.identity {
            self.fail(demand, Problem::StaleVersion);
            return;
        }
        self.start_work(demand, Some(id.to_owned()), VecDeque::from([Step::SetAside { after: None }]));
        if let Some(work) = self.works.get_mut(&demand) {
            work.removed = true;
        }
    }

    /// Keep an item on this device, or stop keeping it: through this device's pin rule rows, at the version read.
    fn pin(&mut self, demand: u64, id: &str, keep: bool) {
        if self.items.get(id).is_none() {
            self.fail(demand, Problem::Missing);
            return;
        }
        self.start_work(demand, Some(id.to_owned()), VecDeque::from([Step::PinRead { keep, after: None }, Step::Refresh]));
    }

    /// The version a write of the work's item names: the one the table holds now.
    fn expected_of(&self, item: Option<&str>) -> Value {
        json!(item.and_then(|id| self.items.get(id)).and_then(|item| item.version).unwrap_or(self.contract.absent_version))
    }

    /// Send the request of a work's next step, or finish the work.
    fn advance(&mut self, demand: u64) {
        let Some(work) = self.works.get(&demand) else { return };
        let contract = self.contract;
        let item = work.item.clone();
        let current = item.as_deref().and_then(|id| self.items.get(id)).cloned();
        let expected = self.expected_of(item.as_deref());
        let mut input = Map::new();
        let job = match work.steps.front() {
            None => {
                let work = self.works.remove(&demand).expect("the work is here");
                if let Some(item) = &work.item {
                    self.uploading.remove(item);
                }
                let item = if work.removed { None } else { work.item.as_deref().and_then(|id| self.view(id)) };
                self.emit(Command::Done { demand, item, kept_beside: work.kept_beside, ignored: false });
                if work.kept_beside {
                    self.emit(Command::Signal);
                }
                return;
            }
            Some(Step::Move { to, after }) => {
                let Some(current) = current else { return self.work_failed(demand, Stage::Step, Problem::Missing) };
                input.insert(contract.field("move_from").into(), json!(current.name));
                input.insert(contract.field("move_to").into(), json!(to));
                if let Some(after) = after {
                    input.insert(contract.field("list_after").into(), json!(after));
                }
                input.insert(contract.field("expected_version").into(), expected);
                "move"
            }
            Some(Step::SetAside { after }) => {
                let Some(current) = current else { return self.work_failed(demand, Stage::Step, Problem::Missing) };
                input.insert(contract.field("set_aside_name").into(), json!(current.name));
                if let Some(after) = after {
                    input.insert(contract.field("list_after").into(), json!(after));
                }
                input.insert(contract.field("expected_version").into(), expected);
                "set_aside"
            }
            Some(Step::MakeFolder { name }) => {
                input.insert(contract.field("name").into(), json!(name));
                input.insert(contract.field("expected_version").into(), json!(contract.absent_version));
                "make_folder"
            }
            Some(Step::Refresh) => match (&item, &work.made_name) {
                (Some(id), _) => {
                    input = self.for_device();
                    input.insert(contract.field("item_asked").into(), json!(id));
                    "item"
                }
                (None, Some(name)) => {
                    input.insert(contract.field("find_prefix").into(), json!(name));
                    "find"
                }
                (None, None) => {
                    self.works.get_mut(&demand).expect("the work is here").steps.pop_front();
                    return self.advance(demand);
                }
            },
            Some(Step::PinRead { after, .. }) => {
                input.insert(contract.field("pin_device").into(), json!(self.setup.device));
                if let Some(after) = after {
                    input.insert(contract.field("list_after").into(), json!(after));
                }
                "pin_list"
            }
            Some(Step::PinWrite { job, input: write }) => {
                input.clone_from(write);
                job
            }
            Some(Step::Upload(upload)) => match &upload.upload_id {
                None => {
                    let seed = format!("{}\n{}\n{demand}\n{}\n{:?}", self.setup.device, upload.name, self.now_ms, upload.attempt);
                    let mut id = blake3::hash(seed.as_bytes()).to_hex().to_string();
                    id.truncate(contract.upload_id_hex_chars);
                    input.insert(contract.field("upload_id").into(), json!(id));
                    input.insert(contract.field("upload_name").into(), json!(upload.name));
                    input.insert(contract.field("upload_length").into(), json!(upload.length));
                    if let Some(media_type) = &upload.media_type {
                        input.insert(contract.field("upload_media_type").into(), json!(media_type));
                    }
                    let expected = if upload.new_name { json!(contract.absent_version) } else { expected };
                    input.insert(contract.field("expected_version").into(), expected);
                    if let Some(Step::Upload(upload)) = self.works.get_mut(&demand).and_then(|work| work.steps.front_mut()) {
                        upload.upload_id = Some(id);
                    }
                    return self.request(Purpose::Work { demand, stage: Stage::UploadStart }, "upload_start", input);
                }
                Some(id) if upload.accepted >= upload.length => {
                    let identity = format!("{}{}", contract.identity.prefix, upload.hasher.finalize().to_hex());
                    input.insert(contract.field("upload_id").into(), json!(id));
                    input.insert(contract.field("upload_name").into(), json!(upload.name));
                    input.insert(contract.field("finish_identity").into(), json!(identity));
                    return self.request(Purpose::Work { demand, stage: Stage::UploadFinish }, "upload_finish", input);
                }
                Some(_) => {
                    let most = self.link.request_most(&self.setup.bounds, self.setup.bounds.piece_most_bytes);
                    let length = most.min(upload.length - upload.accepted);
                    let offset = upload.accepted;
                    self.emit(Command::ReadLocal { demand, offset, length });
                    return;
                }
            },
        };
        self.request(Purpose::Work { demand, stage: Stage::Step }, job, input);
    }

    fn local_bytes(&mut self, demand: u64, offset: u64, bytes: &[u8]) {
        let contract = self.contract;
        let Some(Step::Upload(upload)) = self.works.get_mut(&demand).and_then(|work| work.steps.front_mut()) else { return };
        if offset != upload.accepted || bytes.is_empty() {
            return;
        }
        if offset == upload.hashed {
            upload.hasher.update(bytes);
            upload.hashed += bytes.len() as u64;
        }
        let mut input = Map::new();
        input.insert(contract.field("upload_id").into(), json!(upload.upload_id));
        input.insert(contract.field("upload_name").into(), json!(upload.name));
        input.insert(contract.field("piece_offset").into(), json!(offset));
        input.insert(contract.field("piece_content").into(), json!(BASE64.encode(bytes)));
        let end = offset + bytes.len() as u64;
        self.request(Purpose::Work { demand, stage: Stage::UploadPiece { end } }, "upload_piece", input);
    }

    fn work_answered(&mut self, demand: u64, stage: Stage, answer: &Value) {
        let contract = self.contract;
        let device = self.setup.device.clone();
        let next_after = |job: &str| answer.get(contract.field(job)).and_then(Value::as_str).map(str::to_owned);
        let folder_row = self.is_folder_row(answer);
        let Some(work) = self.works.get_mut(&demand) else { return };
        let item = work.item.clone();
        match work.steps.front_mut() {
            None => {}
            Some(Step::Move { to, after }) => match next_after("move_next") {
                Some(next) => *after = Some(next),
                None => {
                    let to = to.clone();
                    work.steps.pop_front();
                    if let Some(id) = &item {
                        self.items.rename(id, &to);
                    }
                }
            },
            Some(Step::SetAside { after }) => match next_after("move_next") {
                Some(next) => *after = Some(next),
                None => {
                    work.steps.pop_front();
                    if let Some(id) = &item {
                        self.items.remove_tree(id);
                    }
                }
            },
            Some(Step::MakeFolder { name }) => {
                let mut row = answer.clone();
                if row.get(contract.field("name")).is_none() {
                    row[contract.field("name")] = json!(name);
                }
                let Some(made) = item_of_row(contract, &row, true) else {
                    self.works.remove(&demand);
                    self.fail(demand, Problem::NotOffered);
                    return;
                };
                work.item = Some(made.id.clone());
                work.steps.pop_front();
                self.items.upsert(made);
            }
            Some(Step::Refresh) => {
                // The item now: show_item's row, or the new name's own row among the names that start with it.
                let row = match &work.made_name {
                    Some(name) if item.is_none() => answer
                        .get(contract.field("find_names"))
                        .and_then(Value::as_array)
                        .and_then(|rows| rows.iter().find(|row| row.get(contract.field("name")).and_then(Value::as_str) == Some(name.as_str())))
                        .map(|row| (row.clone(), false)),
                    _ => Some((answer.clone(), folder_row)),
                };
                let Some(kept) = row.and_then(|(row, folder)| item_of_row(contract, &row, folder)) else {
                    self.works.remove(&demand);
                    if let Some(id) = &item {
                        self.uploading.remove(id);
                    }
                    self.fail(demand, Problem::NotOffered);
                    return;
                };
                work.item = Some(kept.id.clone());
                work.made_name = None;
                work.steps.pop_front();
                self.items.upsert(kept);
            }
            Some(Step::PinRead { keep, after }) => {
                let keep = *keep;
                let rules = answer.get(contract.field("pin_rules")).and_then(Value::as_array).cloned().unwrap_or_default();
                let id = item.clone().unwrap_or_default();
                let naming: Vec<Value> = rules
                    .into_iter()
                    .filter(|rule| {
                        rule.get(contract.field("pin_rule"))
                            .and_then(|rule| rule.get(contract.field("pin_items")))
                            .and_then(Value::as_array)
                            .is_some_and(|items| items.iter().any(|named| named.as_str() == Some(id.as_str())))
                    })
                    .collect();
                if let Some(next) = next_after("pin_next").filter(|_| naming.is_empty()) {
                    *after = Some(next);
                } else {
                    work.steps.pop_front();
                    let mut writes = Vec::new();
                    if keep && naming.is_empty() {
                        let mut input = Map::new();
                        input.insert(contract.field("pin_id").into(), json!(format!("{device}:{id}")));
                        input.insert(contract.field("pin_device").into(), json!(device));
                        input.insert(contract.field("pin_items").into(), json!([id]));
                        input.insert(contract.field("expected_version").into(), json!(contract.absent_version));
                        writes.push(Step::PinWrite { job: "pin_set", input });
                    }
                    if !keep {
                        for rule in naming {
                            let mut input = Map::new();
                            input.insert(contract.field("pin_id").into(), rule.get(contract.field("pin_id")).cloned().unwrap_or(Value::Null));
                            input.insert(contract.field("expected_version").into(), rule.get(contract.field("pin_version")).cloned().unwrap_or(Value::Null));
                            let row = rule.get(contract.field("pin_rule")).cloned().unwrap_or(Value::Null);
                            let others: Vec<Value> = row
                                .get(contract.field("pin_items"))
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                                .filter(|named| named.as_str() != Some(id.as_str()))
                                .cloned()
                                .collect();
                            if others.is_empty() {
                                writes.push(Step::PinWrite { job: "pin_remove", input });
                            } else {
                                input.insert(contract.field("pin_device").into(), json!(device));
                                input.insert(contract.field("pin_items").into(), json!(others));
                                input.insert(contract.field("pin_on").into(), row.get(contract.field("pin_on")).cloned().unwrap_or(json!(true)));
                                writes.push(Step::PinWrite { job: "pin_set", input });
                            }
                        }
                    }
                    for write in writes.into_iter().rev() {
                        work.steps.push_front(write);
                    }
                }
            }
            Some(Step::PinWrite { .. }) => {
                work.steps.pop_front();
            }
            Some(Step::Upload(upload)) => {
                let upload = upload.as_mut();
                match stage {
                    Stage::UploadFinish => {
                        if item.is_none() || work.kept_beside {
                            if let Some(id) = &item {
                                self.uploading.remove(id);
                            }
                            work.made_name = Some(upload.name.clone());
                            work.item = None;
                        }
                        work.steps.pop_front();
                    }
                    Stage::UploadStart | Stage::UploadPiece { .. } => {
                        // The contract's accepted offset is where the next piece starts (a resumed upload included).
                        let reported = answer.get(contract.field("piece_next")).and_then(Value::as_u64);
                        let sent = match stage {
                            Stage::UploadPiece { end } => end,
                            _ => upload.accepted,
                        };
                        upload.accepted = reported.unwrap_or(sent).min(upload.hashed.max(upload.accepted));
                        if stage != Stage::UploadStart {
                            let (done, total) = (upload.accepted, upload.length);
                            self.emit(Command::Progress { demand, done, total });
                        }
                    }
                    Stage::Step => {}
                }
            }
        }
        self.advance(demand);
    }

    fn work_failed(&mut self, demand: u64, stage: Stage, problem: Problem) {
        let contract = self.contract;
        let device = self.setup.device_label.clone();
        let Some(work) = self.works.get_mut(&demand) else { return };
        if let Some(Step::Upload(upload)) = work.steps.front_mut() {
            if stage == Stage::UploadStart && problem == Problem::StaleVersion {
                // Never written over: the edit is kept beside the other version, under a plain name, as a new name.
                upload.attempt = match (work.kept_beside, upload.attempt) {
                    (false, _) => None,
                    (true, None) => Some(contract.conflict_first_again),
                    (true, Some(attempt)) => Some(attempt + 1),
                };
                upload.name = names::conflict_name(contract, &upload.asked_name, &device, &upload.date, upload.attempt);
                upload.new_name = true;
                upload.upload_id = None;
                upload.hasher = blake3::Hasher::new();
                upload.hashed = 0;
                upload.accepted = 0;
                work.kept_beside = true;
                self.advance(demand);
                return;
            }
        }
        let work = self.works.remove(&demand).expect("the work is here");
        if let Some(item) = work.item {
            self.uploading.remove(&item);
        }
        self.fail(demand, problem);
    }
}

impl Upload {
    fn new(name: String, new_name: bool, length: u64, media_type: Option<String>, date: String) -> Upload {
        Upload {
            asked_name: name.clone(),
            name,
            new_name,
            length,
            media_type,
            upload_id: None,
            hasher: blake3::Hasher::new(),
            hashed: 0,
            accepted: 0,
            attempt: None,
            date,
        }
    }
}
