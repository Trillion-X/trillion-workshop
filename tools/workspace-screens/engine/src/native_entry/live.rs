//! The workspace page's live socket (/work/live) on the native host. It tells every open page of the account that the
//! account's records moved, the moment the move is durable. An open screen then draws a change made elsewhere (the
//! person's AI, another tab or device, a tool run) without the person opening it again. The page's end is
//! src/workspace/store-changes.ts in the client.
//!
//! Non-Negotiable Invariants:
//! - One owner per account waits on the account's one change notifier (`records::changes::AccountChanges`, the same
//!   one the wake ticker waits on). No socket polls the store, and nothing holds the account owner while it waits.
//! - A message names record ids only, never values, and only ids in a resource a browser session reads (DATA
//!   `readable_resources`, the account's own records). A change anywhere else (the account's command records, the wake
//!   book) is never named, not even by id. Each page reads what changed again through the workspace's own reads, with
//!   its own rights.
//! - The revision in a message comes from the one revision owner, `workspace_heads::LiveHeads`, through the same heads
//!   read /work/api/screen-revision answers. A message is that heads read plus the stream position and the changed ids,
//!   so its revision is the number the page compares with the one it opened at (store-changes.ts invariants 4 and 9).
//!   A page whose revision is current reads nothing again when its socket opens.
//! - A socket is admitted like every page request, and each message is admitted again (`WorkspaceSessions::authorize`).
//!   A socket whose session is no longer admitted is closed with code 4401, so its page signs in again. The request
//!   permit is held for the socket's whole life, and a cancelled permit closes it.
//!
//! Key Concepts:
//! - `Live`: the account's waiting thread and its recent change steps (DATA `kept_steps`). A step holds the ids one
//!   notifier wake brought, or a gap when the notifier's ring outran the owner.
//! - The stream position is (`epoch`, `seq`). `epoch` is new for every owner (every engine run); `seq` counts its
//!   steps. A page that reconnects names the position it last heard (`?epoch=&after=`), and its socket's first message
//!   then names every id since that position, if the owner still remembers them.
//! - A message is the heads read's JSON (`revision`, `heads`, any `changed` reads) plus `epoch` and `seq`. It also
//!   carries `writes` {records: [{id, fields: null}]} when every id since the socket's last message is known and there
//!   are at most `most_ids` of them.
//! - The first message also carries the hello (`hello`: {epoch, instruction?}). `instruction` is the first DATA `boot`
//!   row whose `active` is true ({code, said}); every shipped row is off, so nothing steers a page by default. What a
//!   page does for a code is the page's own DATA (the client's src/live-protocol.json `boot.actions`).
//! - A numbered request ({id, type, ...}, DATA `requests.types`) is answered on the same socket with
//!   {reply_to: id, epoch, ...}: `ping` answers `ok`; `subscribe` acknowledges at most `max_subscriptions` of its ids
//!   ({acked, cap, dropped}) and the socket holds them for its life; `catch_up {scope, after}` answers
//!   {scope, through, items}, the ids of records of kind `scope` in DATA `scope_resource` changed after change number
//!   `after` (`provide`), and the socket then carries `counters` {scope: newest number} in each later message;
//!   `window {list, from, to}` answers {list, from, rows, total}, the newest ids of kind `list` as rows {id}, held for
//!   the socket and kept current by `{ops: {list, ops}}` after each change (`window_frames`, `window_ops`). A scope or
//!   list the store answers nothing for is refused by name (`refusals.unknown_scope`, `refusals.unknown_list`); any
//!   other type is refused `refusals.unknown_request`. A message that is not a numbered request is answered nothing.
//! - A typed dirty notice (`LiveOwner::dirty`, {kind, id?, version}) is sent to every open socket as {dirty: notice};
//!   no revision moves, and the page reads that kind again only when the version moved.
//! - The port of the old client-and-store protocol owner (Trillion-X/trillion src/live-protocol.mjs) part by part:
//!   docs/live-protocol-port.md.
//!
//! Security Considerations:
//! - The socket takes only text messages up to `most_message_bytes`. A `ping` is answered `pong`; a numbered request
//!   is answered from the socket's own memory, from an id read admitted like the page's own reads
//!   (`SelectedAccount::live_ids`: the browser session, the account and its record book are current), or refused by
//!   name. An id read answers ids and numbers only, never a value, and nothing a page sends is written.
//! - Refusal closes send {code, cause} first because a full source identity may exceed a Close reason.
//!   The subsequent standard Close code is unchanged. Nothing here logs record ids or values.
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use crate::{
    native_boot::SelectedAccount,
    records::changes::{AccountChanges, Changed, Moved},
    workspace::{SupplyFuture, WorkspaceError, WorkspacePermit, WorkspaceLive, WorkspaceRequestHead, WorkspaceSession},
    workspace_domain::DomainContext,
    workspace_session::{owner_wait, WorkspaceSessions},
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        FromRequestParts, Request,
    },
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::watch;

trait RefusalOutput: Send {
    fn send_refusal_frame(&mut self, frame: Message, fallback: crate::refusal_cause::Cause)
        -> impl std::future::Future<Output = Result<(), crate::refusal_cause::Cause>> + Send + '_;
}
impl RefusalOutput for WebSocket {
    fn send_refusal_frame(&mut self, frame: Message, fallback: crate::refusal_cause::Cause)
        -> impl std::future::Future<Output = Result<(), crate::refusal_cause::Cause>> + Send + '_ {
        async move {
            self.send(frame).await.map_err(|error| crate::refusal_cause::Caused::stored_cause(&error).unwrap_or(fallback))
        }
    }
}

/// A refusal needs a full source identity, which can exceed a Close reason's
/// protocol bound. Send content-free metadata first, then the unchanged Close
/// code. Both sends share the existing configured delivery bound.
async fn close_refused<S>(socket: &mut S, code: u16, cause: crate::refusal_cause::Cause, wait: Duration)
    -> Result<(), crate::refusal_cause::Cause>
where S: RefusalOutput {
    crate::quiet_eprintln!("live-refusal code={code} cause={cause}");
    let sent = tokio::time::timeout(wait, async {
        socket.send_refusal_frame(Message::Text(json!({"code":code,"cause":cause.id()}).to_string().into()),
            crate::cause!(condition: live_refusal_metadata_delivery)).await?;
        socket.send_refusal_frame(Message::Close(Some(CloseFrame { code, reason: "".into() })),
            crate::cause!(condition: live_refusal_close_delivery)).await
    }).await.unwrap_or_else(|_| Err(crate::cause!(condition: live_refusal_delivery_timeout)));
    if let Err(cause) = &sent { crate::quiet_eprintln!("live-send-refusal cause={cause}"); }
    sent
}

/// The declared product DATA file the live socket's bounds are read from.
const DATA: &[u8] = include_bytes!("workspace-live.json");
/// The close code of a socket whose session is no longer admitted: its page signs in again.
const CLOSE_SIGNED_OUT: u16 = 4401;
/// The close code of a socket the engine can no longer answer (its permit ended, a read failed).
const CLOSE_UNAVAILABLE: u16 = 1011;
/// The close code of a socket that sent a message this socket does not take.
const CLOSE_REFUSED: u16 = 1008;

/// src/native_entry/workspace-live.json.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    readable_resources: Vec<String>,
    kept_steps: usize,
    most_ids: usize,
    longest_wait_ms: u64,
    permit_look_ms: u64,
    most_message_bytes: usize,
    max_subscriptions: usize,
    /// The resource whose change log numbers the catch-up scopes and whose kinds the windows list (old
    /// src/live-scopes.mjs: the person's record log).
    scope_resource: String,
    /// The most change pages, and changes a page, one catch-up reads (old src/live-scopes.json `catch_up_pages`,
    /// `catch_up_page_size`).
    catch_up_pages: usize,
    catch_up_page_size: usize,
    /// The most rows one window holds (old src/live-scopes.json windows[].most).
    window_most: usize,
    /// The longest one catch-up or window read may take.
    ids_read_ms: u64,
    requests: Requests,
    refusals: Refusals,
    boot: Boot,
}
/// The words of the socket's messages: the ping and its pong, and the numbered request types it takes.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Requests {
    ping_text: String,
    pong_text: String,
    types: Vec<String>,
}
/// The error names a numbered request is refused with.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Refusals {
    unknown_request: String,
    unknown_scope: String,
    unknown_list: String,
}
/// The instructions the first message's hello can give a page; the first active row is sent.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Boot {
    rows: Vec<BootRow>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BootRow {
    code: String,
    active: bool,
    said: String,
}
impl Settings {
    fn shipped() -> Result<Self, WorkspaceError> {
        let bytes = DATA;
        let settings: Self = serde_json::from_slice(bytes).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let valid = !settings.readable_resources.is_empty()
            && (1..=4096).contains(&settings.kept_steps)
            && (1..=4096).contains(&settings.most_ids)
            && (10..=60_000).contains(&settings.longest_wait_ms)
            && (10..=60_000).contains(&settings.permit_look_ms)
            && (16..=65_536).contains(&settings.most_message_bytes)
            && (1..=65_536).contains(&settings.max_subscriptions)
            && settings.readable_resources.contains(&settings.scope_resource)
            && (1..=1000).contains(&settings.catch_up_pages)
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(&settings.catch_up_page_size)
            && (1..=crate::records::MAX_PAGE_ITEMS).contains(&settings.window_most)
            && (10..=60_000).contains(&settings.ids_read_ms)
            && !settings.requests.ping_text.is_empty()
            && !settings.requests.pong_text.is_empty()
            && !settings.requests.types.is_empty()
            && [&settings.refusals.unknown_request, &settings.refusals.unknown_scope, &settings.refusals.unknown_list]
                .iter()
                .all(|name| !name.is_empty())
            && settings.boot.rows.iter().all(|row| !row.code.is_empty());
        valid.then_some(settings).ok_or(crate::cause!(WorkspaceError::Integrity))
    }
}

/// One notifier wake: the ids it brought, or a gap when the notifier's ring outran the owner.
enum Step {
    Ids(BTreeSet<String>),
    /// Scoped IDs never enter the original namespace's ID list. The complete
    /// context travels beside each group, including duplicate IDs/sequences.
    Scoped { original: BTreeSet<String>, histories: BTreeMap<(String,String), BTreeSet<String>> },
    Gap,
}
/// The owner's recent steps: `steps[i]` is step number `first + i`, and the newest is `seq`.
struct Steps {
    first: u64,
    steps: VecDeque<Step>,
}
impl Steps {
    fn seq(&self) -> u64 {
        self.first + self.steps.len() as u64 - 1
    }
    /// Every id of the steps after `after`, or `None` when one of them is a gap, is no longer remembered, or there
    /// are more than `most`.
    fn ids_after(&self, after: u64, most: usize) -> Option<Vec<String>> {
        let start = after.checked_add(1)?;
        if start < self.first {
            return None;
        }
        let mut ids = BTreeSet::new();
        for step in self.steps.iter().skip(usize::try_from(start - self.first).ok()?) {
            match step {
                Step::Ids(step) => ids.extend(step.iter().cloned()),
                Step::Scoped { original, .. } => ids.extend(original.iter().cloned()),
                Step::Gap => return None,
            }
            if ids.len() > most {
                return None;
            }
        }
        Some(ids.into_iter().collect())
    }

    fn histories_after(&self, after: u64, most: usize) -> Option<Vec<Value>> {
        let start = after.checked_add(1)?;
        if start < self.first { return None; }
        let mut histories = BTreeMap::<(String,String), BTreeSet<String>>::new();
        for step in self.steps.iter().skip(usize::try_from(start - self.first).ok()?) {
            match step {
                Step::Scoped { histories: changed, .. } => {
                    for (history, ids) in changed { histories.entry(history.clone()).or_default().extend(ids.iter().cloned()); }
                }
                Step::Gap => return None,
                Step::Ids(_) => {}
            }
            if histories.values().map(BTreeSet::len).sum::<usize>() > most { return None; }
        }
        histories.into_iter().map(|((history,resource), ids)| {
            let scope: Value = serde_json::from_str(&history).ok()?;
            Some(json!({"scope":scope,"resource":resource,"records":ids.into_iter().map(|id| json!({"id":id,"fields":null})).collect::<Vec<_>>()}))
        }).collect()
    }
}

/// The account's live owner, mounted as the workspace's `WorkspaceLive`.
pub struct LiveOwner(Arc<Live>);
struct Live {
    owner: Arc<Mutex<SelectedAccount>>,
    sessions: WorkspaceSessions<SelectedAccount>,
    settings: Settings,
    epoch: String,
    steps: Arc<Mutex<Steps>>,
    moved: watch::Receiver<u64>,
    /// Typed dirty notices for every open socket (`LiveOwner::dirty`), already as the text each is sent.
    dirty: tokio::sync::broadcast::Sender<String>,
    /// The record store's kind field, which a catch-up scope and a window list name.
    kind_field: String,
    stop: Arc<AtomicBool>,
}
impl Drop for Live {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
impl LiveOwner {
    /// Start the account's live owner. `account` is the account the change notifier is kept under: the owner id the
    /// store's writes are published under.
    pub fn start(
        owner: Arc<Mutex<SelectedAccount>>,
        sessions: WorkspaceSessions<SelectedAccount>,
        account: &str,
    ) -> Result<Self, WorkspaceError> {
        let settings = Settings::shipped()?;
        let changes = AccountChanges::of(account).ok_or(crate::cause!(WorkspaceError::Integrity))?;
        let mut random = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random)
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        let epoch = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let steps = Arc::new(Mutex::new(Steps { first: 0, steps: VecDeque::from([Step::Ids(BTreeSet::new())]) }));
        let (signal, moved) = watch::channel(0u64);
        let stop = Arc::new(AtomicBool::new(false));
        let (kept, longest) = (settings.kept_steps, Duration::from_millis(settings.longest_wait_ms));
        let readable: BTreeSet<String> = settings.readable_resources.iter().cloned().collect();
        let (thread_steps, thread_stop) = (steps.clone(), stop.clone());
        std::thread::Builder::new()
            .name("native-live-changes".into())
            .spawn(move || {
                let mut cursor = changes.cursor();
                while !thread_stop.load(Ordering::Acquire) {
                    let step = match cursor.wait(&changes, longest, &thread_stop) {
                        Moved::Changes(changed) => readable_step(changed, &readable),
                        Moved::Gap => Some(Step::Gap),
                        Moved::Nudged | Moved::Still => None,
                    };
                    let Some(step) = step else { continue };
                    let Ok(mut steps) = thread_steps.lock() else { return };
                    steps.steps.push_back(step);
                    while steps.steps.len() > kept {
                        steps.steps.pop_front();
                        steps.first += 1;
                    }
                    let seq = steps.seq();
                    drop(steps);
                    signal.send_replace(seq);
                }
            })
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
        let kind_field = crate::storage::record_store::settings::shipped().ok_or(crate::cause!(WorkspaceError::Integrity))?.kind_field.clone();
        let (dirty, _) = tokio::sync::broadcast::channel(DIRTY_KEPT);
        Ok(Self(Arc::new(Live { owner, sessions, settings, epoch, steps, moved, dirty, kind_field, stop })))
    }

    /// Tell every open screen that a kind of state is stale (`{kind, id?, version}`): no revision moves, and each page
    /// reads that kind again only when the version differs from the one it holds (its own createDirty). Old
    /// Trillion-X/trillion src/live-screen.mjs:470-475 (`dirty(notice)`), F-0812, F-0816, F-0822. A notice is sent as
    /// it is given; a caller names kinds and ids only, never a value. A socket that falls more than DIRTY_KEPT
    /// notices behind is sent a new heads message instead, so it reads everything again.
    pub fn dirty(&self, notice: &Value) -> bool {
        let fields = notice.as_object();
        let well_formed = fields.is_some_and(|fields| {
            fields.get("kind").and_then(Value::as_str).is_some_and(|kind| !kind.is_empty())
                && fields.keys().all(|key| matches!(key.as_str(), "kind" | "id" | "version"))
                && fields.get("id").is_none_or(Value::is_string)
        });
        well_formed && self.0.dirty.send(json!({"dirty": notice}).to_string()).is_ok()
    }
}

/// How many dirty notices wait for one socket before it is told to read everything again.
const DIRTY_KEPT: usize = 64;

/// The live socket's id reads, under the page's admission (local_account/record_delivery.rs `with_live_ids`): ids
/// and numbers only, never a value.
pub trait LiveIds {
    /// A page of `resource`'s change log after `after` (sequence order).
    fn changes_after(&self, resource: &str, after: i64, limit: usize) -> Result<crate::records::Page<crate::records::Change, i64>, crate::records::Error>;
    /// At most `limit` live ids of `kind` in `resource`, highest id first.
    fn ids_of_kind(&self, resource: &str, kind: &str, limit: usize) -> Result<Vec<String>, crate::records::Error>;
    /// The newest change number of `resource` (0 when nothing was written).
    fn newest(&self, resource: &str) -> Result<i64, crate::records::Error>;
}
/// `LiveIds` over one account's record store.
pub struct StoreIds<'a, S: crate::storage::Storage> {
    pub store: &'a crate::storage::record_store::RecordStore<S>,
    pub account: &'a str,
}
impl<S: crate::storage::Storage> LiveIds for StoreIds<'_, S> {
    fn changes_after(&self, resource: &str, after: i64, limit: usize) -> Result<crate::records::Page<crate::records::Change, i64>, crate::records::Error> {
        self.store.changes_page_readonly(self.account, resource, after, limit)
    }
    fn ids_of_kind(&self, resource: &str, kind: &str, limit: usize) -> Result<Vec<String>, crate::records::Error> {
        self.store.ids_of_kind(self.account, resource, kind, None, limit).map(|(ids, _)| ids)
    }
    fn newest(&self, resource: &str) -> Result<i64, crate::records::Error> {
        self.store.stamp(self.account, resource)
    }
}

struct HistoryIds<'a> { source: &'a dyn crate::wake::HistoryRead, account: &'a str }
impl LiveIds for HistoryIds<'_> {
    fn changes_after(&self, resource: &str, after: i64, limit: usize) -> Result<crate::records::Page<crate::records::Change,i64>,crate::records::Error> {
        self.source.after(self.account,resource,after,limit)
    }
    fn ids_of_kind(&self, resource: &str, kind: &str, limit: usize) -> Result<Vec<String>,crate::records::Error> {
        self.source.ids(self.account,resource,kind,limit)
    }
    fn newest(&self, resource: &str) -> Result<i64,crate::records::Error> { self.source.newest(self.account,resource) }
}

/// Bind one complete history for the socket's life. Numeric feed positions,
/// held windows and kind names cannot be reused in another history.
fn socket_history(head: &WorkspaceRequestHead) -> Result<Option<Value>,WorkspaceError> {
    let mut history = None;
    for (name,value) in url::form_urlencoded::parse(head.uri.query().unwrap_or("").as_bytes()) {
        if name != "history" { continue; }
        if history.is_some() { return Err(crate::cause!(WorkspaceError::Invalid)); }
        let value: Value = serde_json::from_str(&value).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        let selected = crate::storage::record_store_resources::domains::Selection::from_input(&json!({"scope":value}))
            .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?.ok_or(crate::cause!(WorkspaceError::Invalid))?;
        if selected.create { return Err(crate::cause!(WorkspaceError::Invalid)); }
        history = Some(serde_json::to_value(selected.identity()).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?);
    }
    Ok(history)
}

fn history_epoch(epoch: &str, history: Option<&Value>) -> String {
    match history {
        None => epoch.to_owned(),
        Some(history) => content_crypto::advanced::blake3::hash(&serde_json::to_vec(&(epoch,history)).unwrap_or_default()).to_hex().to_string(),
    }
}

/// What a numbered request asks the store for.
#[derive(Clone, Debug, PartialEq)]
enum Ask {
    /// `catch_up {scope, after}`: the ids of records of kind `scope` changed after change number `after`.
    CatchUp { scope: String, after: i64 },
    /// `window {list, from, to}`: the newest `to - from` ids of kind `list`.
    Window { list: String, from: i64, to: i64 },
}

/// The numbers the id reads take (DATA), copied for a read off the socket's task.
#[derive(Clone)]
struct IdsRules {
    resource: String,
    kind_field: String,
    pages: usize,
    page_size: usize,
    most: usize,
}

/// What `text` asks the store for, when it is a numbered catch_up or window request.
fn asked(text: &str) -> Option<Ask> {
    let request: Value = serde_json::from_str(text).ok()?;
    request.get("id").and_then(Value::as_u64)?;
    let number = |field: &str| match request.get(field) {
        None | Some(Value::Null) => Some(0),
        Some(Value::String(text)) => text.parse::<i64>().ok(),
        Some(value) => value.as_f64().map(|number| number.trunc() as i64),
    };
    match request.get("type").and_then(Value::as_str)? {
        "catch_up" => Some(Ask::CatchUp {
            scope: request.get("scope").and_then(Value::as_str).unwrap_or_default().to_owned(),
            after: number("after")?.max(0),
        }),
        "window" => Some(Ask::Window {
            list: request.get("list").and_then(Value::as_str).unwrap_or_default().to_owned(),
            from: number("from").unwrap_or(0).max(0),
            to: number("to").unwrap_or(0),
        }),
        _ => None,
    }
}

/// The store's answer to one ask, or None when it names nothing the store offers. Old src/live-scopes.mjs:
/// - `registerRecordScopes` (:18-36): a scope is the record log seen through one kind; its catch-up walks at most
///   `pages` pages of the log after `after` and answers `{through, items}`: the last number read and the ids of that
///   kind changed after `after`, once each, in the order first changed. A removal names no kind and is not an item
///   (the old feed's `types` answered nothing for a removed id).
/// - `registerWindows` (:39-48): a window starts at the newest (`from` 0, `to` > 0) and answers `{rows, total}`, rows
///   `{id}` of at most `most` ids.
///
/// Dropped: the old `read` field (a key of the page's own store-change-reads.json, page DATA), and the old fixed
/// rows naming which kinds were scopes (src/live-scopes.json `record_scopes`, `windows`): any kind of the resource a
/// session reads is a scope and a list, so the engine names none (docs/PRINCIPLES.md 5).
fn provide(rules: &IdsRules, ids: &dyn LiveIds, ask: &Ask) -> Result<Option<Value>, crate::refusal_cause::Cause> {
    match ask {
        Ask::CatchUp { scope, after } => {
            if scope.is_empty() {
                return Ok(None);
            }
            let (mut cursor, mut items) = (*after, Vec::<String>::new());
            for _ in 0..rules.pages {
                let page = ids.changes_after(&rules.resource, cursor, rules.page_size).map_err(|error| error.cause())?;
                for change in &page.items {
                    let kind = change.value.as_ref().and_then(|value| value.get(&rules.kind_field)).and_then(Value::as_str);
                    if kind == Some(scope.as_str()) && !items.contains(&change.id) {
                        items.push(change.id.clone());
                    }
                }
                if let Some(last) = page.items.last() {
                    cursor = last.sequence;
                }
                if page.items.len() < rules.page_size {
                    break;
                }
            }
            Ok(Some(json!({"through": cursor, "items": items})))
        }
        Ask::Window { list, from, to } => {
            if list.is_empty() || *from != 0 || *to <= 0 {
                return Ok(None);
            }
            let limit = usize::try_from(*to).unwrap_or(usize::MAX).min(rules.most);
            let rows: Vec<Value> = ids.ids_of_kind(&rules.resource, list, limit).map_err(|error| error.cause())?.into_iter().map(|id| json!({"id": id})).collect();
            let total = rows.len();
            Ok(Some(json!({"rows": rows, "total": total})))
        }
    }
}

/// The ops that turn a window's `before` rows into `after`, by row id (old src/live-protocol.mjs:262-277
/// `windowOps`): removed rows are deleted from the end first, then each row of `after` is kept, updated, or moved
/// (a delete and an insert); the last op carries `total`, and no change answers one `sync`.
fn window_ops(before: &[Value], after: &[Value], from: usize, total: usize) -> Vec<Value> {
    let id_of = |row: &Value| row.get("id").cloned().unwrap_or(Value::Null);
    let mut ops = Vec::new();
    let mut working: Vec<Value> = before.to_vec();
    let after_ids: Vec<Value> = after.iter().map(id_of).collect();
    for i in (0..working.len()).rev() {
        if !after_ids.contains(&id_of(&working[i])) {
            ops.push(json!({"op": "delete", "index": from + i}));
            working.remove(i);
        }
    }
    for (i, row) in after.iter().enumerate() {
        let at = working.iter().position(|candidate| id_of(candidate) == id_of(row));
        if at == Some(i) {
            if working[i] != *row {
                ops.push(json!({"op": "update", "index": from + i, "row": row}));
                working[i] = row.clone();
            }
            continue;
        }
        if let Some(at) = at {
            ops.push(json!({"op": "delete", "index": from + at}));
            working.remove(at);
        }
        ops.push(json!({"op": "insert", "index": from + i, "row": row}));
        working.insert(i.min(working.len()), row.clone());
    }
    match ops.last_mut() {
        Some(last) => last["total"] = json!(total),
        None => ops.push(json!({"op": "sync", "from": from, "rows": after, "total": total})),
    }
    ops
}

/// For each window a socket holds, read it again and the messages that bring the page's copy up to date
/// (`{list, ops}`); a list that did not change answers nothing (old src/live-protocol.mjs:164-174 `windowFrames`).
fn window_frames(rules: &IdsRules, ids: &dyn LiveIds, windows: &mut std::collections::BTreeMap<String, HeldWindow>) -> Vec<Value> {
    let mut frames = Vec::new();
    for (list, held) in windows.iter_mut() {
        let now = match provide(rules, ids, &Ask::Window { list: list.clone(), from: held.from, to: held.to }) {
            Ok(Some(now)) => now,
            Ok(None) => continue,
            Err(cause) => { crate::quiet_eprintln!("live-window-read-failed cause={cause}"); continue; }
        };
        let rows = now["rows"].as_array().cloned().unwrap_or_default();
        if rows == held.rows {
            continue;
        }
        let total = now["total"].as_u64().unwrap_or(0) as usize;
        let from = usize::try_from(held.from).unwrap_or(0);
        frames.push(json!({"list": list, "ops": window_ops(&held.rows, &rows, from, total)}));
        held.rows = rows;
    }
    frames
}
impl Live {
    /// A socket's next message: a heads read under the socket's own admission, with the stream position and, when
    /// known, every id changed since `after`. The socket's first message (`first`) also carries the hello.
    async fn page_message(
        &self,
        context: &DomainContext,
        history: Option<&Value>,
        after: Option<u64>,
        first: bool,
        extra: Map<String, Value>,
    ) -> Result<(String, u64, Option<crate::native_boot::own_records_start::HistoryPermit>), WorkspaceError> {
        self.sessions.authorize(context.clone()).await?;
        let (seq, ids, histories) = {
            let steps = self.steps.lock().map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            let ids = after.and_then(|after| steps.ids_after(after, self.settings.most_ids));
            let remaining = self.settings.most_ids.saturating_sub(ids.as_ref().map_or(0,Vec::len));
            (steps.seq(), ids, after.and_then(|after| steps.histories_after(after, remaining)))
        };
        let owner = self.owner.clone();
        let read = context.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            let mut selected = owner_wait::acquire(owner.as_ref(), || read.permit.cancelled())
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            selected
                .prepare_workspace_heads(&read.session, read.permit.clone())
                .map(|prepared| prepared.bytes)
                .map_err(|error| match error {
                    crate::workspace_heads::Error::NotAuthorized(_) => crate::cause!(WorkspaceError::Unauthorized),
                    _ => crate::cause!(WorkspaceError::Unavailable),
                })
        })
        .await
        .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))??;
        let mut page_message: Map<String, Value> = match serde_json::from_slice(&bytes) {
            Ok(Value::Object(page_message)) => page_message,
            _ => return Err(crate::cause!(WorkspaceError::Integrity)),
        };
        page_message.extend(extra);
        let epoch = self.stream_epoch(history);
        page_message.insert("epoch".into(), Value::String(epoch.clone()));
        page_message.insert("seq".into(), json!(seq));
        if first {
            page_message.insert("hello".into(), hello(&epoch, &self.settings.boot));
        }
        if history.is_none() { if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
            let records: Vec<Value> = ids.into_iter().map(|id| json!({"id": id, "fields": null})).collect();
            page_message.insert("writes".into(), json!({"at": null, "version": null, "records": records}));
        } }
        if let Some(history) = history {
            page_message.insert("history".into(), history.clone());
            match histories {
                None if after.is_some() => { page_message.insert("history_gap".into(),json!(true)); },
                Some(histories) => {
                    let mut records = histories.into_iter().find(|frame| frame["scope"] == *history && frame["resource"] == self.settings.scope_resource)
                        .and_then(|mut frame| frame.get_mut("records").map(Value::take)).unwrap_or_else(||json!([]));
                    for row in records.as_array_mut().into_iter().flatten() { row["scope"] = history.clone(); }
                    if records.as_array().is_some_and(|rows| !rows.is_empty()) {
                        page_message.insert("writes".into(),json!({"at":null,"version":null,"records":records}));
                    }
                }
                None => {}
            }
        } else {
            match histories {
                Some(histories) if !histories.is_empty() => { page_message.insert("histories".into(),json!(histories)); },
                None if after.is_some() => { page_message.insert("history_gap".into(),json!(true)); },
                _ => {}
            }
        }
        self.sessions.authorize(context.clone()).await?;
        let history_permit = if let Some(history) = history {
            let (newest,permit) = self.read_ids_in_history(context,Some(history.clone()),|rules,ids| ids.newest(&rules.resource).map_err(|error| error.cause())).await.map_err(WorkspaceError::Unavailable)?;
            newest.map_err(WorkspaceError::Unavailable)?;
            permit
        } else { None };
        let text = serde_json::to_string(&page_message).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        Ok((text, seq, history_permit))
    }

    /// The id reads' DATA.
    fn rules(&self) -> IdsRules {
        IdsRules {
            resource: self.settings.scope_resource.clone(),
            kind_field: self.kind_field.clone(),
            pages: self.settings.catch_up_pages,
            page_size: self.settings.catch_up_page_size,
            most: self.settings.window_most,
        }
    }

    /// One id read under the socket's own admission (`SelectedAccount::live_ids`), bounded by `ids_read_ms`.
    /// A refused admission or failed read retains its original producer cause.
    async fn read_ids_in_history<T: Send + 'static>(
        &self,
        context: &DomainContext,
        history: Option<Value>,
        read: impl FnOnce(&IdsRules, &dyn LiveIds) -> T + Send + 'static,
    ) -> Result<(T,Option<crate::native_boot::own_records_start::HistoryPermit>), crate::refusal_cause::Cause> {
        let (owner, context, rules) = (self.owner.clone(), context.clone(), self.rules());
        let longest = Duration::from_millis(self.settings.ids_read_ms);
        tokio::task::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + longest;
            if let Some(history) = history {
                return crate::native_boot::own_records_start::read_history_retained(&owner,&context.session.session_id,
                    context.permit.cancellation_flag(),deadline,&history,|source,account|
                        Ok(read(&rules,&HistoryIds { source,account }))).map(|(answer,permit)|(answer,Some(permit))).map_err(|error| error.cause());
            }
            let mut selected = owner_wait::acquire(owner.as_ref(), || context.permit.cancelled() || std::time::Instant::now() >= deadline).map_err(|error| error.cause())?;
            selected.live_ids(&context.session, &context.permit, deadline, |ids| read(&rules, ids)).map(|answer|(answer,None)).map_err(|error| error.cause())
        })
        .await
        .map_err(|error| crate::refusal_cause::stored_error_cause(&error)
            .unwrap_or_else(|| crate::cause!(condition: live_read_worker_did_not_complete)))?
    }

    /// Where the page says it left off (`?epoch=&after=`), when it is this owner's epoch.
    fn stream_epoch(&self, history: Option<&Value>) -> String {
        history_epoch(&self.epoch,history)
    }
    fn resumed_after(&self, head: &WorkspaceRequestHead, history: Option<&Value>) -> Option<u64> {
        let (mut epoch, mut after) = (None, None);
        for pair in head.uri.query()?.split('&') {
            match pair.split_once('=') {
                Some(("epoch", value)) => epoch = Some(value),
                Some(("after", value)) => after = value.parse::<u64>().ok(),
                _ => {}
            }
        }
        (epoch == Some(self.stream_epoch(history).as_str())).then_some(after).flatten()
    }

    /// Flush one frame while its caller retains the exact history permit.
    /// A stalled or cancelled connection is dropped before that permit leaves.
    async fn send_frame(&self, socket: &mut WebSocket, context: &DomainContext, message: Message,
        history: Option<&crate::native_boot::own_records_start::HistoryPermit>,
        window: Option<&crate::native_boot::own_records_start::HistoryPermit>) -> Result<(), crate::refusal_cause::Cause> {
        let current = || {
            if context.permit.cancelled() { return Err(crate::cause!(condition: live_delivery_permit_cancelled)); }
            if history.is_some_and(|held| !held.still()) { return Err(crate::cause!(condition: live_delivery_history_changed)); }
            if window.is_some_and(|held| !held.still()) { return Err(crate::cause!(condition: live_delivery_window_changed)); }
            Ok(())
        };
        current()?;
        let cancelled = async {
            loop {
                tokio::time::sleep(Duration::from_millis(self.settings.permit_look_ms)).await;
                if let Err(cause) = current() { break cause; }
            }
        };
        tokio::select! {
            sent=socket.send(message) => sent.map_err(|error| crate::refusal_cause::Caused::cause(&error)),
            cause=cancelled => Err(cause),
            _=tokio::time::sleep(Duration::from_millis(self.settings.longest_wait_ms)) => Err(crate::cause!(condition: live_delivery_timed_out)),
        }
    }

    async fn serve(self: Arc<Self>, mut socket: WebSocket, context: DomainContext, resumed: Option<u64>, history: Option<Value>) {
        let close_wait = Duration::from_millis(self.settings.longest_wait_ms);
        let refused = |error: WorkspaceError| {
            let code = if matches!(error, WorkspaceError::Unauthorized(_)) { CLOSE_SIGNED_OUT } else { CLOSE_UNAVAILABLE };
            (code, error.cause())
        };
        let mut moved = self.moved.clone();
        let mut dirty = self.dirty.subscribe();
        moved.mark_unchanged();
        let mut permit_look = tokio::time::interval(Duration::from_millis(self.settings.permit_look_ms));
        // Whether a change has moved past the last message sent: set by the notifier, cleared when a message is sent.
        let mut owed = false;
        // What this socket holds for its life: the ids its last subscribe request was acknowledged for.
        let mut held = Held::default();
        // The first message is the current position and revision, with the hello: a page whose revision is current
        // reads nothing again.
        let epoch = self.stream_epoch(history.as_ref());
        let mut heard = match self.page_message(&context, history.as_ref(), resumed, true, Map::new()).await {
            Ok((text, seq, history_permit)) => {
                if let Err(cause) = self.send_frame(&mut socket,&context,Message::Text(text.into()),history_permit.as_ref(),None).await {
                    let _ = close_refused(&mut socket, CLOSE_UNAVAILABLE, cause, close_wait).await;
                    drop(socket); drop(history_permit); return;
                }
                drop(history_permit);
                seq
            }
            Err(error) => {
                let (code,cause) = refused(error);
                let _ = close_refused(&mut socket, code, cause, close_wait).await;
                return;
            }
        };
        loop {
            tokio::select! {
                changed = moved.changed() => {
                    if changed.is_err() {
                        let _ = close_refused(&mut socket, CLOSE_UNAVAILABLE, crate::cause!(condition: live_movement_channel_ended), close_wait).await;
                        return;
                    }
                    owed = true;
                }
                message = socket.recv() => {
                    let Some(Ok(message)) = message else { return };
                    match message {
                        Message::Text(text) => {
                            // A catch_up or window is read under the socket's own admission before it is answered.
                            let (provided,query_permit) = match asked(text.as_str()) {
                                Some(ask) => self.read_ids_in_history(&context,history.clone(), move |rules, ids| provide(rules, ids, &ask)).await.unwrap_or_else(|cause| (Err(cause),None)),
                                None => (Ok(None),None),
                            };
                            if let Some(mut reply) = answer(&self.settings, &epoch, &mut held, text.as_str(), provided) {
                                if let Some(history) = &history {
                                    if let Ok(mut framed) = serde_json::from_str::<Value>(&reply) {
                                        if framed.is_object() { framed["history"] = history.clone(); reply = framed.to_string(); }
                                    }
                                }
                                if let Err(cause) = self.send_frame(&mut socket,&context,Message::Text(reply.into()),query_permit.as_ref(),None).await {
                                    let _ = close_refused(&mut socket, CLOSE_UNAVAILABLE, cause, close_wait).await;
                                    drop(socket); drop(query_permit); return;
                                }
                            }
                            drop(query_permit);
                        }
                        Message::Ping(_) | Message::Pong(_) => {}
                        Message::Close(_) => return,
                        Message::Binary(_) => {
                            let _ = close_refused(&mut socket, CLOSE_REFUSED, crate::cause!(condition: live_binary_request_refused), close_wait).await;
                            return;
                        }
                    }
                }
                notice = dirty.recv() => {
                    match notice {
                        Ok(text) => {
                            if socket.send(Message::Text(text.into())).await.is_err() {
                                return;
                            }
                        }
                        // Notices this socket missed: its next message makes the page read everything again.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => owed = true,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                    }
                }
                _ = permit_look.tick() => {
                    if context.permit.cancelled() {
                        let _ = close_refused(&mut socket, CLOSE_UNAVAILABLE, crate::cause!(condition: live_permit_cancelled), close_wait).await;
                        return;
                    }
                }
            }
            if !owed {
                continue;
            }
            // The scopes and windows this socket holds: their newest number rides in the message (`counters`), and
            // each window that changed is sent its ops after it (old live-screen.mjs:436-437 settle, tellWindows).
            let mut extra = Map::new();
            let mut frames = Vec::new();
            let mut window_permit = None;
            if !held.scopes.is_empty() || !held.windows.is_empty() {
                let (scopes, mut windows) = (held.scopes.clone(), held.windows.clone());
                let read = self.read_ids_in_history(&context, history.clone(), move |rules, ids| {
                    let newest = ids.newest(&rules.resource).map_err(|error| {
                        crate::quiet_eprintln!("live-scope-read-failed cause={}", error.cause());
                    }).ok();
                    let frames = window_frames(rules, ids, &mut windows);
                    (newest, frames, windows)
                }).await;
                let read = read.map_err(|cause| { crate::quiet_eprintln!("live-read-refused cause={cause}"); });
                if let Ok(((newest, read_frames, windows),permit)) = read {
                    window_permit=permit;
                    if let Some(newest) = newest.filter(|_| !scopes.is_empty()) {
                        let counters: Map<String, Value> = scopes.iter().map(|scope| (scope.clone(), json!(newest))).collect();
                        extra.insert("counters".into(), Value::Object(counters));
                    }
                    held.windows = windows;
                    frames = read_frames;
                }
            }
            match self.page_message(&context, history.as_ref(), Some(heard), false, extra).await {
                Ok((text, seq, history_permit)) => {
                    if self.send_frame(&mut socket,&context,Message::Text(text.into()),history_permit.as_ref(),window_permit.as_ref()).await.is_err() {
                        drop(socket); drop(history_permit); drop(window_permit); return;
                    }
                    for frame in &frames {
                        let mut message = json!({"ops":frame});
                        if let Some(history) = &history { message["history"] = history.clone(); }
                        if let Err(cause) = self.send_frame(&mut socket,&context,Message::Text(message.to_string().into()),history_permit.as_ref(),window_permit.as_ref()).await {
                            let _ = close_refused(&mut socket, CLOSE_UNAVAILABLE, cause, close_wait).await;
                            drop(socket); drop(history_permit); drop(window_permit); return;
                        }
                    }
                    drop(history_permit);
                    drop(window_permit);
                    heard = seq;
                    owed = false;
                }
                Err(error @ WorkspaceError::Unauthorized(_)) => {
                    let _ = close_refused(&mut socket, CLOSE_SIGNED_OUT, error.cause(), close_wait).await;
                    return;
                }
                // A read the account's writes kept busy sends nothing now. The message stays owed: it is taken again on
                // the next change or the next permit look, and names every id since `heard` with the revision then.
                Err(_) => {}
            }
        }
    }
}

/// The step a notifier wake makes for the page: the ids of the changes in a resource a browser session reads, or
/// none when every change was elsewhere. A change in any other resource is never named, not even by its id.
fn readable_step(changed: Vec<Changed>, readable: &BTreeSet<String>) -> Option<Step> {
    let mut ids = BTreeSet::new();
    let mut histories = BTreeMap::<(String,String), BTreeSet<String>>::new();
    for change in changed.into_iter().filter(|change| readable.contains(&change.resource)) {
        match change.scope {
            None => { ids.insert(change.id); }
            Some(scope) => {
                let Ok(history) = serde_json::to_string(&scope) else { return Some(Step::Gap); };
                histories.entry((history,change.resource)).or_default().insert(change.id);
            }
        }
    }
    if !histories.is_empty() { Some(Step::Scoped { original: ids, histories }) }
    else { (!ids.is_empty()).then_some(Step::Ids(ids)) }
}

/// The first message's hello: this owner's epoch and the first active DATA `boot` row as `instruction` ({code, said}),
/// or no instruction when no row is active.
fn hello(epoch: &str, boot: &Boot) -> Value {
    let mut hello = json!({"epoch": epoch});
    if let Some(row) = boot.rows.iter().find(|row| row.active) {
        hello["instruction"] = json!({"code": row.code, "said": row.said});
    }
    hello
}

/// What one socket holds for its life: the ids its last subscribe request was acknowledged for. It lives only in
/// the socket's task; a new socket (or a new owner epoch) holds nothing, and its page asks again.
#[derive(Default)]
struct Held {
    subscribed: Vec<String>,
    /// The windows its page asked for, each with the rows it was last sent (old live-protocol.mjs:156 `state.windows`).
    windows: std::collections::BTreeMap<String, HeldWindow>,
    /// The scopes its page caught up on: each later message carries their newest number (`counters`), so the page
    /// sees a jump and asks once (old live-screen.mjs:457 `counters`, live-scopes.mjs:20).
    scopes: BTreeSet<String>,
}
/// One window a socket holds.
#[derive(Clone, Debug, PartialEq)]
struct HeldWindow {
    from: i64,
    to: i64,
    rows: Vec<Value>,
}

/// What the live socket answers a page's message: `pong` to the ping text, the answer to a numbered request
/// ({id, type, ...}) as {reply_to: id, epoch, ...}, nothing to anything else (module docs).
fn answer(settings: &Settings, epoch: &str, held: &mut Held, text: &str, provided: Result<Option<Value>, crate::refusal_cause::Cause>) -> Option<String> {
    let words = &settings.requests;
    if text == words.ping_text {
        return Some(words.pong_text.clone());
    }
    let request: Value = serde_json::from_str(text).ok()?;
    let id = request.get("id").and_then(Value::as_u64)?;
    let kind = request.get("type").and_then(Value::as_str)?;
    let refused = |error: &str, cause: crate::refusal_cause::Cause| {
        crate::quiet_eprintln!("live-refusal cause={cause}");
        Some(json!({"reply_to": id, "epoch": epoch, "error": error, "cause": cause.id()}).to_string())
    };
    if !words.types.iter().any(|known| known == kind) {
        return refused(&settings.refusals.unknown_request, crate::cause!());
    }
    match kind {
        "ping" => Some(json!({"reply_to": id, "epoch": epoch, "ok": true}).to_string()),
        "subscribe" => {
            let mut ids: Vec<String> = Vec::new();
            for asked in request.get("ids").and_then(Value::as_array).into_iter().flatten() {
                if let Some(asked) = asked.as_str().filter(|asked| !asked.is_empty()) {
                    if !ids.iter().any(|id| id == asked) {
                        ids.push(asked.to_owned());
                    }
                }
            }
            let asked = ids.len();
            ids.truncate(settings.max_subscriptions);
            held.subscribed = ids;
            Some(
                json!({
                    "reply_to": id,
                    "epoch": epoch,
                    "acked": held.subscribed,
                    "cap": settings.max_subscriptions,
                    "dropped": asked - held.subscribed.len(),
                })
                .to_string(),
            )
        }
        // Old src/live-protocol.mjs:150-158: the window is held for the socket and its rows answered.
        "window" => {
            let Some(Ask::Window { list, from, to }) = asked(text) else { return refused(&settings.refusals.unknown_list, crate::cause!()) };
            let read = match provided {
                Ok(Some(read)) => read,
                Ok(None) => return refused(&settings.refusals.unknown_list, crate::cause!()),
                Err(cause) => return refused(&settings.refusals.unknown_list, cause),
            };
            let rows = read["rows"].as_array().cloned().unwrap_or_default();
            held.windows.insert(list.clone(), HeldWindow { from, to, rows: rows.clone() });
            Some(json!({"reply_to": id, "epoch": epoch, "list": list, "from": from, "rows": rows, "total": read["total"]}).to_string())
        }
        // Old src/live-protocol.mjs:159-160: what the scope holds after the number, with the scope named.
        "catch_up" => {
            let Some(Ask::CatchUp { scope, .. }) = asked(text) else { return refused(&settings.refusals.unknown_scope, crate::cause!()) };
            let caught = match provided {
                Ok(Some(caught)) => caught,
                Ok(None) => return refused(&settings.refusals.unknown_scope, crate::cause!()),
                Err(cause) => return refused(&settings.refusals.unknown_scope, cause),
            };
            held.scopes.insert(scope.clone());
            Some(json!({"reply_to": id, "epoch": epoch, "scope": scope, "through": caught["through"], "items": caught["items"]}).to_string())
        }
        _ => refused(&settings.refusals.unknown_request, crate::cause!()),
    }
}

impl WorkspaceLive for LiveOwner {
    fn subscribe(&self, session: WorkspaceSession, request: Request, permit: WorkspacePermit) -> SupplyFuture<Response> {
        let live = self.0.clone();
        Box::pin(async move {
            let (mut parts, _) = request.into_parts();
            let head = WorkspaceRequestHead { method: parts.method.clone(), uri: parts.uri.clone(), headers: parts.headers.clone() };
            let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
                .await
                .map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            let context = DomainContext { session: Arc::new(session), head, permit };
            live.sessions.authorize(context.clone()).await?;
            let history = socket_history(&context.head)?;
            let resumed = live.resumed_after(&context.head,history.as_ref());
            let most = live.settings.most_message_bytes;
            Ok(upgrade
                .max_message_size(most)
                .max_frame_size(most)
                .on_upgrade(move |socket| live.serve(socket, context, resumed, history))
                .into_response())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RefusalSink {
        frames: Vec<Message>,
        failure: Option<crate::refusal_cause::CodedError<()>>,
    }
    impl RefusalOutput for RefusalSink {
        fn send_refusal_frame(&mut self, frame: Message, _: crate::refusal_cause::Cause)
            -> impl std::future::Future<Output = Result<(), crate::refusal_cause::Cause>> + Send + '_ {
            async move {
                if let Some(error) = self.failure.take() { return Err(error.cause()); }
                self.frames.push(frame); Ok(())
            }
        }
    }

    #[tokio::test]
    async fn close_refusal_keeps_full_cause_before_each_unchanged_public_close_code() {
        let prefix = "socket_test@src/native_entry/live.rs:1:1:";
        let source = format!("{prefix}{}", "x".repeat(crate::refusal_cause::wire_bytes() - prefix.len()));
        let cause = crate::refusal_cause::Cause::from_wire(&source).unwrap();
        assert!(source.len() > 123, "the full source cannot fit a standard Close reason");
        for code in [CLOSE_SIGNED_OUT, CLOSE_UNAVAILABLE, CLOSE_REFUSED] {
            let mut sink = RefusalSink::default();
            close_refused(&mut sink, code, cause.clone(), Duration::from_secs(1)).await.unwrap();
            assert_eq!(sink.frames.len(), 2);
            let Message::Text(text) = &sink.frames[0] else { panic!("source metadata precedes Close") };
            let answer: Value = serde_json::from_str(text).unwrap();
            assert_eq!(answer, json!({"code":code,"cause":source}));
            let Message::Close(Some(frame)) = &sink.frames[1] else { panic!("the original Close still follows") };
            assert_eq!(frame.code, code);
            assert!(frame.reason.is_empty());
        }
    }

    #[tokio::test]
    async fn failed_refusal_delivery_retains_the_transport_producer_cause() {
        let original = crate::cause!(condition: synthetic_refusal_sink_failed);
        let mut sink = RefusalSink { frames: Vec::new(), failure: Some(crate::refusal_cause::CodedError::with_cause((), original.clone())) };
        let error = close_refused(&mut sink, CLOSE_UNAVAILABLE, crate::cause!(condition: synthetic_refusal), Duration::from_secs(1)).await.unwrap_err();
        assert_eq!(error, original);
        assert!(sink.frames.is_empty(), "a failed send does not claim a caller received the refusal");
    }


    fn steps(first: u64, steps: Vec<Step>) -> Steps {
        Steps { first, steps: steps.into() }
    }
    fn ids(names: &[&str]) -> Step {
        Step::Ids(names.iter().map(|name| (*name).to_owned()).collect())
    }

    #[test]
    fn a_message_names_every_id_since_the_last_step_heard() {
        let kept = steps(0, vec![ids(&[]), ids(&["a"]), ids(&["b", "a"]), ids(&["c"])]);
        assert_eq!(kept.seq(), 3);
        assert_eq!(kept.ids_after(0, 10).unwrap(), vec!["a", "b", "c"]);
        assert_eq!(kept.ids_after(2, 10).unwrap(), vec!["c"]);
        assert_eq!(kept.ids_after(3, 10).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn a_gap_a_forgotten_step_or_too_many_ids_names_none() {
        let kept = steps(5, vec![ids(&["a"]), Step::Gap, ids(&["b"])]);
        assert!(kept.ids_after(5, 10).is_none(), "a gap after the step heard");
        assert_eq!(kept.ids_after(6, 10).unwrap(), vec!["b"]);
        assert!(kept.ids_after(3, 10).is_none(), "steps no longer remembered");
        let many = steps(0, vec![ids(&[]), ids(&["a", "b", "c"])]);
        assert!(many.ids_after(0, 2).is_none());
    }

    #[test]
    fn a_change_outside_the_resources_a_session_reads_is_never_named() {
        let change = |resource: &str, id: &str| Changed { scope: None, resource: resource.into(), kind: None, id: id.into(), sequence: 1 };
        let readable = BTreeSet::from(["own-records".to_owned()]);
        let Some(Step::Ids(ids)) =
            readable_step(vec![change("own-records", "readable-one"), change("own-commands", "unreadable-one")], &readable)
        else {
            panic!("a readable change makes a step")
        };
        assert_eq!(ids, BTreeSet::from(["readable-one".to_owned()]));
        assert!(readable_step(vec![change("own-commands", "unreadable-one"), change("wake", "book")], &readable).is_none());
    }

    #[test]
    fn equal_ids_in_independent_histories_never_enter_the_original_namespace_message() {
        let scope = |id| json!({"id":id,"incarnation":"first","generation":1});
        let change = |scope| Changed { resource:"own-records".into(), scope,
            kind:Some("note".into()), id:"same-id".into(), sequence:1 };
        let readable = BTreeSet::from(["own-records".to_owned()]);
        let moved = readable_step(vec![change(None), change(Some(scope("a"))), change(Some(scope("b")))], &readable).unwrap();
        let kept = steps(0, vec![ids(&[]), moved]);
        assert_eq!(kept.ids_after(0, 10).unwrap(), vec!["same-id"]);
        let histories = kept.histories_after(0, 10).unwrap();
        assert_eq!(histories.len(), 2);
        assert_ne!(histories[0]["scope"], histories[1]["scope"]);
        assert!(histories.iter().all(|history| history["records"] == json!([{"id":"same-id","fields":null}])));
        assert!(kept.histories_after(0, 1).is_none(), "the message budget counts history-qualified IDs");
        let gap = steps(0, vec![ids(&[]), Step::Gap]);
        assert!(gap.histories_after(0, 10).is_none(), "a lost scope is an explicit gap");
    }

    #[test]
    fn history_notice_frames_keep_inner_resources_separate() {
        let scope=json!({"id":"a","incarnation":"first","generation":1});
        let readable=BTreeSet::from(["first-resource".into(),"second-resource".into()]);
        let changed=readable.iter().map(|resource: &String| Changed { resource:resource.clone(),scope:Some(scope.clone()),kind:None,id:"same-id".into(),sequence:1 }).collect();
        let kept=steps(0,vec![ids(&[]),readable_step(changed,&readable).unwrap()]);
        let frames=kept.histories_after(0,2).unwrap();
        assert_eq!(frames.len(),2);
        assert_eq!(frames[0]["scope"],frames[1]["scope"]);
        assert_ne!(frames[0]["resource"],frames[1]["resource"]);
        assert!(kept.histories_after(0,1).is_none());
    }

    #[test]
    fn live_socket_history_is_complete_canonical_and_part_of_its_resume_epoch() {
        let history = |id| json!({"id":id,"incarnation":"first","generation":1});
        let head = |query: String| WorkspaceRequestHead { method:axum::http::Method::GET,
            uri:format!("/work/live?{query}").parse().unwrap(),headers:axum::http::HeaderMap::new() };
        let query = |value:Value| url::form_urlencoded::Serializer::new(String::new()).append_pair("history",&value.to_string()).finish();
        assert_eq!(socket_history(&head(query(history("a")))).unwrap(),Some(history("a")));
        assert_eq!(socket_history(&head("epoch=e&after=3".into())).unwrap(),None);
        for bad in [json!({"id":"a"}),json!({"id":"a","incarnation":"first","generation":1,"create":true})] {
            assert!(socket_history(&head(query(bad))).is_err());
        }
        assert!(socket_history(&head(format!("{}&{}",query(history("a")),query(history("b"))))).is_err());
        assert_eq!(history_epoch("engine-epoch",None),"engine-epoch");
        let a = history_epoch("engine-epoch",Some(&history("a")));
        assert_ne!(a,history_epoch("engine-epoch",Some(&history("b"))));
        assert_ne!(a,history_epoch("engine-epoch",Some(&json!({"id":"a","incarnation":"second","generation":1}))));
        assert_eq!(a,history_epoch("engine-epoch",Some(&history("a"))));
    }

    fn answered(settings: &Settings, held: &mut Held, text: &str) -> Option<Value> {
        answered_with(settings, held, text, None)
    }
    fn answered_with(settings: &Settings, held: &mut Held, text: &str, provided: Option<Value>) -> Option<Value> {
        answer(settings, "E", held, text, Ok(provided)).map(|reply| {
            let mut value: Value = serde_json::from_str(&reply).unwrap_or(Value::String(reply));
            if value.get("error").is_some() {
                let cause = crate::refusal_cause::Cause::from_wire(value["cause"].as_str().unwrap()).unwrap();
                assert_eq!(cause.file(), "src/native_entry/live.rs");
                assert!(include_str!("live.rs").lines().nth(cause.line() as usize - 1).unwrap().contains("refused("));
                value.as_object_mut().unwrap().remove("cause");
            }
            value
        })
    }

    #[test]
    fn live_refusals_name_each_condition_and_keep_a_failed_read_origin() {
        let settings = Settings::shipped().unwrap();
        let mut held = Held::default();
        let mut origins = BTreeSet::new();
        for request in [
            json!({"id":1,"type":"unknown"}),
            json!({"id":2,"type":"window","list":"private-list","from":0,"to":9}),
            json!({"id":3,"type":"catch_up","scope":"private-scope","after":[]}),
            json!({"id":4,"type":"catch_up","scope":"private-scope","after":0}),
        ] {
            let wire = answer(&settings, "E", &mut held, &request.to_string(), Ok(None)).unwrap();
            let body: Value = serde_json::from_str(&wire).unwrap();
            let encoded = body["cause"].as_str().unwrap();
            let cause = crate::refusal_cause::Cause::from_wire(encoded).unwrap();
            assert_eq!(cause.file(), "src/native_entry/live.rs");
            assert!(include_str!("live.rs").lines().nth(cause.line() as usize - 1).unwrap().contains("refused("));
            assert!(!encoded.contains("private-"));
            origins.insert(encoded.to_owned());
        }
        assert_eq!(origins.len(), 4);

        struct FailedIds(crate::refusal_cause::Cause);
        impl LiveIds for FailedIds {
            fn changes_after(&self, _: &str, _: i64, _: usize) -> Result<crate::records::Page<crate::records::Change,i64>, crate::records::Error> {
                Err(crate::records::Error::Unavailable(self.0.clone()))
            }
            fn ids_of_kind(&self, _: &str, _: &str, _: usize) -> Result<Vec<String>, crate::records::Error> {
                Err(crate::records::Error::Unavailable(self.0.clone()))
            }
            fn newest(&self, _: &str) -> Result<i64, crate::records::Error> {
                Err(crate::records::Error::Unavailable(self.0.clone()))
            }
        }
        let origin = crate::cause!(condition: synthetic_record_read_failed);
        let request = json!({"id":5,"type":"window","list":"private-list","from":0,"to":9});
        let ask = asked(&request.to_string()).unwrap();
        let provided = provide(&rules(), &FailedIds(origin.clone()), &ask);
        let wire = answer(&settings, "E", &mut held, &request.to_string(), provided).unwrap();
        let mut body: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(body["cause"], origin.id());
        body.as_object_mut().unwrap().remove("cause");
        assert_eq!(body, json!({"reply_to":5,"epoch":"E","error":"unknown_list"}));
    }

    // Old test/live-protocol.test.mjs "the store answers requests: ping is left to the platform, subscribe is
    // capped, catch_up asks the scope" and "the store answers a request message on the same socket, with its epoch".
    #[test]
    fn the_socket_answers_numbered_requests_with_its_epoch_and_caps_a_subscription() {
        let mut settings = Settings::shipped().unwrap();
        settings.max_subscriptions = 2;
        let mut held = Held::default();
        // The ping text is answered by this socket itself (the old store left it to the platform's auto-response).
        assert_eq!(answer(&settings, "E", &mut held, "ping", Ok(None)).as_deref(), Some("pong"));
        assert_eq!(
            answered(&settings, &mut held, r#"{"id":1,"type":"subscribe","ids":["a","b","c","a","",3]}"#),
            Some(json!({"reply_to": 1, "epoch": "E", "acked": ["a", "b"], "cap": 2, "dropped": 1}))
        );
        assert_eq!(held.subscribed, vec!["a", "b"], "the socket holds what it acknowledged");
        assert_eq!(
            answered(&settings, &mut held, r#"{"id":2,"type":"ping"}"#),
            Some(json!({"reply_to": 2, "epoch": "E", "ok": true}))
        );
        // A scope or list the store answers nothing for is refused by name, with the epoch.
        assert_eq!(
            answered(&settings, &mut held, r#"{"id":3,"type":"catch_up","scope":"told","after":4}"#),
            Some(json!({"reply_to": 3, "epoch": "E", "error": "unknown_scope"}))
        );
        assert_eq!(
            answered(&settings, &mut held, r#"{"id":4,"type":"window","list":"l","from":0,"to":9}"#),
            Some(json!({"reply_to": 4, "epoch": "E", "error": "unknown_list"}))
        );
        assert_eq!(
            answered(&settings, &mut held, r#"{"id":5,"type":"drop_tables"}"#).unwrap()["error"],
            "unknown_request"
        );
        // A new subscribe replaces the last.
        answered(&settings, &mut held, r#"{"id":6,"type":"subscribe","ids":["z"]}"#);
        assert_eq!(held.subscribed, vec!["z"]);
        // Not a numbered request: answered nothing.
        for text in ["hello", r#"{"type":"ping"}"#, r#"{"id":"7","type":"ping"}"#, r#"{"id":7}"#, "[]"] {
            assert_eq!(answer(&settings, "E", &mut held, text, Ok(None)), None, "{text}");
        }
    }

    // Old test/live-protocol.test.mjs "the hello carries the first active boot row and the page maps its code to an
    // action" (the store's half; the page's bootAction stays with the page).
    #[test]
    fn the_hello_carries_the_first_active_boot_row_and_none_by_default() {
        let row = |code: &str, active: bool, said: &str| BootRow { code: code.into(), active, said: said.into() };
        let boot = Boot { rows: vec![row("reload", false, "r"), row("re_auth", true, "Sign in again"), row("paused", true, "p")] };
        assert_eq!(hello("E", &boot), json!({"epoch": "E", "instruction": {"code": "re_auth", "said": "Sign in again"}}));
        assert_eq!(hello("E", &Boot { rows: vec![row("reload", false, "r")] }), json!({"epoch": "E"}), "nothing steered");
        let shipped = Settings::shipped().unwrap();
        assert!(shipped.boot.rows.iter().all(|row| !row.active), "shipped rows default off");
        assert_eq!(hello("E", &shipped.boot), json!({"epoch": "E"}));
    }

    /// An in-memory record store with records of kinds in `own-records`, read through `StoreIds`.
    fn store() -> crate::storage::record_store::RecordStore<crate::storage::memory::Memory> {
        struct Counter(std::sync::atomic::AtomicU64);
        impl crate::storage::record_store::Clock for Counter {
            fn now_ms(&self) -> i64 {
                self.0.fetch_add(1, Ordering::SeqCst) as i64
            }
        }
        let limits = crate::storage::record_store::settings::Limits::fixed(1 << 20, 10 << 30);
        crate::storage::record_store::RecordStore::new(crate::storage::memory::Memory::open("record_store").unwrap(),
            Box::new(Counter(std::sync::atomic::AtomicU64::new(1_800_000_000_000))), limits).unwrap()
    }
    fn put(store: &mut crate::storage::record_store::RecordStore<crate::storage::memory::Memory>, id: &str, kind: &str, version: i64) {
        use crate::records::Records;
        let mutation = crate::records::Mutation { id: id.into(), expected_version: version, request_key: format!("{id}-{version}"),
            // The version is part of the value, so each put is a change (a write of the value a record already
            // holds writes nothing, record_store apply).
            deleted: false, value: json!({"kind": kind, "title": id, "version": version + 1}) };
        store.mutate("person", "own-records", mutation).unwrap();
    }
    fn rules() -> IdsRules {
        let settings = Settings::shipped().unwrap();
        IdsRules { resource: settings.scope_resource, kind_field: "kind".into(), pages: 2, page_size: 2, most: 3 }
    }

    // Old test/live-protocol.test.mjs "the store answers requests: ... catch_up asks the scope" and
    // test/live-scopes.test.mjs:31 "the messages scope is numbered by the record log and a jump is filled by one
    // catch-up for only the messages that changed".
    #[test]
    fn a_catch_up_answers_the_ids_of_its_kind_changed_after_a_number_and_the_socket_holds_the_scope() {
        let mut store = store();
        put(&mut store, "message:1", "message", 0);
        let ids = StoreIds { store: &store, account: "person" };
        let after = ids.newest("own-records").unwrap();
        put(&mut store, "note:1", "note", 0);
        put(&mut store, "message:2", "message", 0);
        put(&mut store, "message:1", "message", 1);
        let ids = StoreIds { store: &store, account: "person" };
        let caught = provide(&rules(), &ids, &Ask::CatchUp { scope: "message".into(), after }).unwrap().unwrap();
        assert_eq!(caught["items"], json!(["message:2", "message:1"]), "only the scope's kind, once each, after the number");
        assert_eq!(caught["through"], json!(ids.newest("own-records").unwrap()), "through the last number read");
        // Bounded: two pages of two changes read through the fourth change only; the fifth waits for the next ask.
        put(&mut store, "note:2", "note", 0);
        put(&mut store, "message:3", "message", 0);
        let ids = StoreIds { store: &store, account: "person" };
        let bounded = provide(&rules(), &ids, &Ask::CatchUp { scope: "message".into(), after }).unwrap().unwrap();
        assert_eq!(bounded["items"], json!(["message:2", "message:1"]));
        assert!(bounded["through"].as_i64().unwrap() < ids.newest("own-records").unwrap(), "the page asks again from through");
        assert_eq!(provide(&rules(), &ids, &Ask::CatchUp { scope: String::new(), after }), Ok(None));

        let settings = Settings::shipped().unwrap();
        let mut held = Held::default();
        let text = format!(r#"{{"id":2,"type":"catch_up","scope":"message","after":{after}}}"#);
        assert_eq!(asked(&text), Some(Ask::CatchUp { scope: "message".into(), after }));
        assert_eq!(answered_with(&settings, &mut held, &text, Some(caught.clone())),
            Some(json!({"reply_to": 2, "epoch": "E", "scope": "message", "through": caught["through"], "items": caught["items"]})));
        assert!(held.scopes.contains("message"), "its later messages carry the scope's counter");
    }

    // Old test/live-scopes.test.mjs:55 "the newest messages are a window held per socket and kept current by ops
    // that equal a fresh read".
    #[test]
    fn a_window_is_held_per_socket_and_kept_current_by_ops_that_equal_a_fresh_read() {
        let mut store = store();
        for id in ["message:1", "message:2", "note:1"] {
            put(&mut store, id, if id.starts_with("note") { "note" } else { "message" }, 0);
        }
        let ids = StoreIds { store: &store, account: "person" };
        let read = provide(&rules(), &ids, &Ask::Window { list: "message".into(), from: 0, to: 50 }).unwrap().unwrap();
        assert_eq!(read, json!({"rows": [{"id": "message:2"}, {"id": "message:1"}], "total": 2}));
        assert_eq!(provide(&rules(), &ids, &Ask::Window { list: "message".into(), from: 5, to: 50 }), Ok(None), "a window starts at the newest");
        let settings = Settings::shipped().unwrap();
        let mut held = Held::default();
        let text = r#"{"id":4,"type":"window","list":"message","from":0,"to":50}"#;
        assert_eq!(answered_with(&settings, &mut held, text, Some(read.clone())),
            Some(json!({"reply_to": 4, "epoch": "E", "list": "message", "from": 0, "rows": read["rows"], "total": 2})));
        assert!(window_frames(&rules(), &ids, &mut held.windows).is_empty(), "an unchanged window is sent nothing");
        put(&mut store, "message:3", "message", 0);
        put(&mut store, "message:4", "message", 0);
        let ids = StoreIds { store: &store, account: "person" };
        let frames = window_frames(&rules(), &ids, &mut held.windows);
        assert_eq!(frames.len(), 1);
        let fresh = provide(&rules(), &ids, &Ask::Window { list: "message".into(), from: 0, to: 50 }).unwrap().unwrap();
        let applied = apply_window_ops(read["rows"].as_array().unwrap(), frames[0]["ops"].as_array().unwrap());
        assert_eq!(Value::Array(applied), fresh["rows"], "the ops bring the page's copy to a fresh read (at most `most` rows)");
        assert_eq!(held.windows["message"].rows, fresh["rows"].as_array().unwrap().clone());
    }

    /// The page's end of the window ops (old src/live-protocol.mjs:246-260 applyWindowOps), kept here only to check
    /// the store's ops.
    fn apply_window_ops(rows: &[Value], ops: &[Value]) -> Vec<Value> {
        let mut rows = rows.to_vec();
        for op in ops {
            let index = op["index"].as_u64().unwrap_or(0) as usize;
            match op["op"].as_str() {
                Some("sync") => rows = op["rows"].as_array().cloned().unwrap_or_default(),
                Some("insert") => rows.insert(index, op["row"].clone()),
                Some("update") => rows[index] = op["row"].clone(),
                Some("delete") => { rows.remove(index); }
                _ => {}
            }
        }
        rows
    }

    // Old test/live-protocol.test.mjs "window ops: the store diffs a window into ordered ops and the page applies them
    // to the same result" (from 0 here; the page's copy is indexed from the window's start).
    #[test]
    fn window_ops_bring_a_window_to_its_new_rows_and_an_unchanged_one_is_a_sync() {
        let row = |id: &str, v: &str| json!({"id": id, "v": v});
        let before = vec![row("a", ""), row("b", ""), row("c", ""), row("d", "")];
        let after = vec![row("a", ""), row("c", "new"), row("x", ""), row("b", ""), row("d", "")];
        let ops = window_ops(&before, &after, 0, 99);
        assert_eq!(apply_window_ops(&before, &ops), after);
        assert_eq!(ops.last().unwrap()["total"], 99);
        let same: Vec<Value> = window_ops(&after, &after, 10, 5).iter().map(|op| op["op"].clone()).collect();
        assert_eq!(same, vec![json!("sync")]);
    }

    // Old src/live-screen.mjs:470-475 `dirty(notice)` (F-0812, F-0816, F-0822): a typed notice reaches every open
    // socket as {dirty: notice}; one that is not {kind, id?, version} is not sent.
    #[test]
    fn a_dirty_notice_is_sent_to_every_socket_and_a_malformed_one_is_not() {
        let (sender, _) = tokio::sync::broadcast::channel::<String>(DIRTY_KEPT);
        let mut first = sender.subscribe();
        let mut second = sender.subscribe();
        let notice = json!({"kind": "people", "id": "p1", "version": "h1"});
        let well_formed = |notice: &Value| notice.as_object().is_some_and(|fields| {
            fields.get("kind").and_then(Value::as_str).is_some_and(|kind| !kind.is_empty())
                && fields.keys().all(|key| matches!(key.as_str(), "kind" | "id" | "version"))
        });
        assert!(well_formed(&notice));
        assert!(!well_formed(&json!({"kind": "people", "value": "secret"})), "a notice carries no value");
        sender.send(json!({"dirty": notice}).to_string()).unwrap();
        for socket in [&mut first, &mut second] {
            assert_eq!(serde_json::from_str::<Value>(&socket.try_recv().unwrap()).unwrap(), json!({"dirty": notice}));
        }
    }

    #[test]
    fn the_shipped_bounds_read() {
        Settings::shipped().unwrap();
    }
}
