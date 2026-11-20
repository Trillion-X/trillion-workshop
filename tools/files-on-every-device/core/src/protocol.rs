//! The events a shell hands the core and the commands the core answers, as JSON across the C ABI.
//!
//! An event that carries bytes (a network answer's body, a piece of a local file) has them beside the JSON, never
//! inside it; a command that carries bytes (a request body, bytes to write, a thumbnail) says how many in `bytes` and
//! the shell takes them with `files_core_take_bytes`. Every event carries the host's monotonic time, `now_ms`: the
//! core reads no clock.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::errors::Problem;
use crate::items::ItemView;

#[derive(Deserialize, Debug, Clone)]
pub struct Event {
    pub now_ms: u64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// The state a shell kept from an earlier `state` command, after a restart.
    Restore { state: Value },
    /// Ask for the state to keep (answered by `state`).
    Keep,
    /// Keep one wait for changes open (at start, and when the OS says the network came back).
    Watch,
    /// The current change anchor (Apple's currentSyncAnchor).
    Anchor { demand: u64 },
    /// One item by its id (Apple's item(for:)), answered as `items` with that one item.
    Item { demand: u64, item: String },
    /// Keep an item on this device, or stop keeping it (Make available offline, Remove download).
    Pin { demand: u64, item: String, keep: bool },
    /// One page of a folder's items. `folder` is an item id, the root's or the trash's id included.
    List { demand: u64, folder: String, page: Option<String>, page_size: Option<u64> },
    /// The changes since an anchor (Apple's enumerateChanges, the working set). An anchor never expires.
    Changes { demand: u64, anchor: String, page_size: Option<u64> },
    /// Bytes of one version of a file: the OS's range and the alignment it needs.
    Fetch { demand: u64, item: String, version: String, offset: u64, length: u64, alignment: u64 },
    /// The OS was handed the checked copy a `fetched` command answered.
    Handed { demand: u64 },
    Thumbnail { demand: u64, item: String, version: String, size: u64 },
    /// A new item in a folder; a file's bytes are read with `read_local`. `date` is the host's local date, for a
    /// conflict copy's name.
    Create {
        demand: u64,
        parent: String,
        name: String,
        folder: bool,
        length: Option<u64>,
        media_type: Option<String>,
        date: String,
    },
    /// An item renamed, moved, or with new bytes (`length` set), from the version the OS had.
    Modify {
        demand: u64,
        item: String,
        base_version: Option<String>,
        parent: Option<String>,
        name: Option<String>,
        length: Option<u64>,
        media_type: Option<String>,
        date: String,
    },
    /// An item moved to Recently Deleted.
    Delete { demand: u64, item: String, base_version: Option<String> },
    /// The bytes a `read_local` asked for, beside the JSON.
    LocalBytes { demand: u64, offset: u64 },
    /// A network answer: whether a body came (false when the transport failed), its timings, its headers by lowercase
    /// name, and its body beside the JSON. The core reads every refusal from the body; a transport status is never
    /// handed in.
    Answer {
        request: u64,
        reached: bool,
        sent_ms: u64,
        first_byte_ms: u64,
        done_ms: u64,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    /// Time passed; nothing else happened.
    Tick,
    Cancel { demand: u64 },
}

impl EventKind {
    /// Whether the event asks the contract for something, so it waits until the contract's bounds are known.
    pub fn asks_the_contract(&self) -> bool {
        self.demand().is_some() && !matches!(self, EventKind::Handed { .. } | EventKind::LocalBytes { .. } | EventKind::Cancel { .. })
    }

    /// The demand the event is for, when it is one.
    pub fn demand(&self) -> Option<u64> {
        match self {
            EventKind::Anchor { demand }
            | EventKind::Item { demand, .. }
            | EventKind::Pin { demand, .. }
            | EventKind::List { demand, .. }
            | EventKind::Changes { demand, .. }
            | EventKind::Fetch { demand, .. }
            | EventKind::Handed { demand }
            | EventKind::Thumbnail { demand, .. }
            | EventKind::Create { demand, .. }
            | EventKind::Modify { demand, .. }
            | EventKind::Delete { demand, .. }
            | EventKind::LocalBytes { demand, .. }
            | EventKind::Cancel { demand } => Some(*demand),
            EventKind::Restore { .. }
            | EventKind::Keep
            | EventKind::Watch
            | EventKind::Answer { .. }
            | EventKind::Tick => None,
        }
    }
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    /// The first command of every core: the one place the shell shows (the whole of the person's files: its id and
    /// the name shown), the id of its OS's trash container, and the sentence for each problem, for one the shell
    /// itself finds.
    Ready { root: String, name: String, trash: String, problem_words: BTreeMap<String, String> },
    /// Send a `tick` at `at_ms` (host time) if no other event comes first: the next moment the core has something to do
    /// (a busy computer's wait ends, a request may have stalled, a change wait may be asked again). A later `wake`
    /// replaces it; with none due the core sends none.
    Wake { at_ms: u64 },
    /// Send one request with `content_type` and `accept` as its headers; its body is the command's bytes.
    Send {
        request: u64,
        method: String,
        url: String,
        content_type: String,
        accept: String,
        bytes: usize,
        /// Further headers to send as they are, by name (a raw upload's message, contract.json `call.raw_upload`).
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    /// Stop waiting for a request that stalled; the core has asked elsewhere.
    Abandon { request: u64 },
    Anchor { demand: u64, anchor: String },
    Items { demand: u64, items: Vec<ItemView>, next_page: Option<String> },
    Changed { demand: u64, updated: Vec<ItemView>, removed: Vec<String>, anchor: String, more: bool },
    /// Write the command's bytes at `offset` of the item's copy of `version`.
    Write { item: String, version: String, offset: u64, bytes: usize },
    /// The range of a fetch is in the item's copy, checked; hand it to the OS.
    Fetched { demand: u64, offset: u64, length: u64 },
    Progress { demand: u64, done: u64, total: u64 },
    /// Read `length` bytes at `offset` of the local file being sent, and hand them back as `local_bytes`.
    ReadLocal { demand: u64, offset: u64, length: u64 },
    /// A create, modify or delete is kept. `item` is what the folder now shows (None after a delete); `kept_beside`
    /// says the edit met a newer version and was kept as a conflict copy beside it.
    Done { demand: u64, item: Option<ItemView>, kept_beside: bool },
    /// The thumbnail's bytes are the command's bytes.
    Thumbnail { demand: u64, bytes: usize },
    /// A demand failed: the OS-neutral problem the shell maps to its own error, and `words`, the sentence the person
    /// reads (contract.json `problem_words`), set as that error's description.
    Failed { demand: u64, problem: Problem, retry_after_ms: Option<u64>, words: String },
    /// Something changed: the OS should ask for the working set's changes.
    Signal,
    /// The problem that stopped work is over (Apple's signalErrorResolved).
    Resolved,
    /// The state to keep and hand back in `restore`.
    State { state: Value },
}
