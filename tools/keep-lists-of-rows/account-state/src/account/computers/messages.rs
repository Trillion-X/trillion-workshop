//! What computers say to each other, and the HTTP requests the forwarder carries to a computer, over the forwarder sessions.
//!
//! A computer never opens a connection to another computer. It posts a `Message` to the forwarder at
//! `/a/<address>/<message_path>/<to>` with its own signed message proof (`trp_`, `ComputerSigner::message_credential`, which never opens a session) as
//! its bearer. The forwarder checks the proof names the account of the path, that both computers are named by the
//! account's newest signed computers row (except a narrowly typed, sealed command-only settle submission), and that
//! a writer's message is not from a term older than the newest it has
//! carried (`ConnectedComputers::term_check`). Then it sends the message to computer `to` as one message on that computer's own
//! session (`message_operation`), with the sender's proof inside, and answers what the computer answered. The computer
//! checks the proof again itself: the forwarder is trusted to carry, never to say who sent a message.
//!
//! The forwarder also sends a computer an HTTP request for a path under `/a/<address>` (`http_operation`): a browser's
//! sign-in page, a passkey or OAuth step, or the account's metadata. The computer answers it with the account's own
//! door, as its own listener would.
//!
//! Every message and answer is plain JSON; the bounds are in `computers/settings.json`.

use super::{writer_row::{Ask, Vote}, KeptAccount};
use crate::storage::record_store::follow::{Carried, Past};
use serde::{Deserialize, Serialize};

/// One message from a computer to another.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    /// One complete independently addressed history. Older receivers cannot
    /// decode this variant and therefore can never acknowledge a partial group.
    Group { request: GroupRequest },
    /// A vote on the writer row. `stamps` say how far the asker's copy holds, per resource: the newest writer term it
    /// took changes from and its caught-up stamp (the account rows are the entry named `copied_row`). A voter refuses
    /// a takeover from a computer whose copy holds less than its own: an older term, or the same term and a lower stamp.
    Vote { ask: Ask, stamps: Vec<(String, u64, i64)> },
    /// The writer's changes of one resource after the stamp `after`, at term `term`. The copy applies them only
    /// when it holds every change up to `after`; it answers `Applied` with its new stamp, or `Behind` with the stamp
    /// it holds. An empty page moves the copy's term floor (a new writer tells its term this way). `base` is the
    /// stamp the writer held of the resource when it took term `term`: a copy that first hears this term and holds
    /// more than `base` took a change no writer acknowledged, and rolls it back (`RecordStore::roll_back_after`).
    Push {
        #[serde(rename = "lease")] term: u64,
        resource: String,
        after: i64,
        changes: Vec<Carried>,
        #[serde(default)]
        base: i64,
    },
    /// One page of changes after `after`. With `writer` the asked computer answers only while it holds the writer role, and
    /// takes `after` as the asker's caught-up stamp; without, it answers from its copy as it is (a computer catching up
    /// before it claims).
    Pull { writer: bool, resource: String, after: i64, limit: usize },
    /// The versions of record `id` of `resource` after the asker's own `version` (made at stamp `since`) and before
    /// `before`, oldest first: one bounded page (`Answer::History`). A change carries at most `feed_history_items`
    /// versions in between; a copy that needs more asks with this, page by page, before it takes the change. `writer`
    /// as in `Pull`.
    History { writer: bool, resource: String, id: String, version: i64, since: i64, before: i64, limit: usize },
    /// The writer's page of versions in between of record `id`, sent while it pushes a change that the copy answered
    /// it cannot take whole yet (`Answer::Needs`). `kept`: the oldest version the writer keeps of the record. `term`
    /// and `base` as in `Push`.
    PushHistory {
        #[serde(rename = "lease")] term: u64,
        resource: String,
        id: String,
        kept: i64,
        versions: Vec<Past>,
        #[serde(default)]
        base: i64,
    },
    /// The asked computer's caught-up stamps, per resource it follows.
    Stamps,
    /// Whether the asked computer has completed its existing call-admission readback (`Copies::answers_now`).
    /// Done means ready; a refusal or an unsupported probe proves nothing. Kept separate from Stamps so an older
    /// computer's ordinary replication replies retain exactly their wire shape.
    Ready,
    /// While no writer is known, a computer that may answer asks a voter to vouch that its account rows hold every
    /// sign-in change the voter holds: `term` and `stamp` are its sign-in counter. A voter vouches (`Answer::Vouch`)
    /// only while no term is live in its own writer row, and tells the time it gave with every vote it answers
    /// afterwards (`Answer::Vote`), so the next writer waits for it before a sign-in change counts as done.
    Vouch { #[serde(rename = "lease")] term: u64, stamp: u64 },
    /// A copy tells the writer it holds every change of `resource` up to `stamp` (`follow::FeedSource::caught_up`).
    CaughtUp { #[serde(rename = "lease")] term: u64, resource: String, stamp: i64 },
    /// The writer's changes of the account's account rows after its sign-in stamp `after`, at term `term`
    /// (`rows_copy.rs`). Sent only to a computer the account's row lets answer. `base` is the writer's sign-in stamp
    /// when it took term `term`: a copy that first hears this term and holds more starts again from nothing.
    SignIn { #[serde(rename = "lease")] term: u64, base: u64, after: u64, changes: Vec<RowChange> },
    /// A computer that may answer asks the writer for its sign-in changes after `after`. `needs_secrets_key`: this computer holds
    /// no secrets key yet, and asks for it, sealed to its own key. `root_identity`: the `key_identity` of the root it
    /// holds, when it holds one; a writer that holds another (a re-key) sends its own, with the keyring.
    SignInPull {
        after: u64,
        limit: usize,
        #[serde(rename = "needs_root")] needs_secrets_key: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root_identity: Option<String>,
    },
    /// The writer tells a voter that may not answer (so holds no account row) that its sign-in changes up to `stamp`
    /// under term `term` are made at the computers that answer. The voter keeps only that mark, and refuses a takeover
    /// from a computer whose account rows hold less: a sign-in change counts only once a majority of the voters hold it or
    /// its mark.
    SignInMark { #[serde(rename = "lease")] term: u64, stamp: u64 },
    /// The account's computers row as the sender holds it (`told`: the row and the account's public key, so the
    /// receiver checks it with nothing stored) and the writer term it was made under. The receiver takes it when it is
    /// newer than its own (a higher revision, or the same one made under a newer term) and answers its own (`Answer::
    /// Row`). With no row, the sender only asks for the receiver's. A writer sends the new row this way to every computer
    /// of the old and the new row before a change of the computers is made (`copies.rs`).
    /// The writer at term `term` hands its writer role over: it has stopped writing (the account's row no longer lets it
    /// answer, as when the owner moves the account to another computer), so the term in the voter's writer row protects
    /// nobody. A voter whose row names the sender at that same term ends it now, so the next writer claims at once
    /// instead of after the whole term and the clock margin. Only the writer ends its own term, and only that term
    /// number: a later term, or another writer's, is never touched.
    Release { #[serde(rename = "lease")] term: u64 },
    /// Part `index` (from 0) of `count` of one message longer than one message may be (`bytes`: base64 of that part of
    /// the message's JSON), transfer `transfer` of the sender. Parts come in order; the receiver keeps them (at most
    /// `carried_bytes` in all) and answers `Done` to each but the last, which it answers with the whole message's answer.
    /// Old trillion carried a row larger than a page as a page of its own, up to 16 MiB (src/resource-state-carry.mjs:11
    /// `ROW_BYTES`); here one change, page or answer larger than a message travels as parts.
    Part { transfer: u64, index: u32, count: u32, bytes: String },
    /// The asker takes part `index` of the answer the receiver keeps as transfer `transfer` (`Answer::Parts`).
    AnswerPart { transfer: u64, index: u32 },
    Row {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "announced")] told: Option<KeptAccount>,
        #[serde(rename = "lease")] term: u64,
        /// The writer made this row (acknowledged as a sign-in change): the receiver takes it. Without, the row is
        /// only proposed: the receiver keeps it pending, never acts on it, and says so in its answer.
        #[serde(default)]
        made: bool,
    },
    /// A computer the account's row names that does not keep the account yet asks a computer that serves it for what it
    /// needs to join by itself (src/native_entry/computer/join_itself.rs): the account's computers row and key, its
    /// restore file and object index (ids and file names, no value), and the account rows a joined folder starts with.
    /// The stores its account routes open (`create::AccountStores`) come through the writer's feed as records
    /// (`account_stores.rs`), not here. Answered `Answer::Holding` by the computer, not by the account's copies; an answer
    /// longer than one message travels in parts (`Answer::Parts`), as the copies' own answers do.
    Holding,
    /// A computer the row lets answer the account, which has no copy of the account's tools and cannot reach the
    /// tools' hosts, asks a computer that serves the account for one page of its live copy after the path `after`
    /// (src/tool_runs/tools/install.rs `copy_page`, `take_copy`). Answered `Answer::Tools` by the computer, in parts
    /// when longer than one message.
    Tools {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<String>,
    },
    /// A computer that may answer and does not hold the writer role hands the writer the account rows made there outside
    /// its copies (the sign-in command line run at that computer, `Log::unlogged`): each with the value its log held
    /// (`was`, none for a row it never logged). The writer makes them one acknowledged sign-in change, as its own
    /// `copy_outside_changes` does, but a row only while its own row still holds `was` (a row made since is left as the
    /// writer has it). Answered `Applied` with how many rows changed, or refused (`not_the_writer`). The computers row
    /// (`places`) never travels this way: it is edited through the door.
    OutsideChanges { rows: Vec<OutsideRow> },
    /// A settle of one records resource (src/storage/record_store/record_sync.rs, old trillion record-sync.mjs): the asker's
    /// root, positions and net changes, a bucket page, or a forget. Answered `Answer::Settled`. Only between computers
    /// that may both answer: a computer that only holds a copy keeps its records sealed and takes no plain record.
    Settle { resource: String, request: crate::storage::record_store::record_sync::SettleRequest },
    /// A durable local command submitted through the settle owner. Unlike plain record settles this carries no row,
    /// bucket, feed or sign-in access: its sealed payload retains the original caller credential and request key.
    /// A proof-bearing computer omitted from the current account row may submit it; the current writer alone opens
    /// it, checks the caller's current rights through the ordinary door, and returns a sealed terminal receipt.
    /// Ported from old trillion src/workspace/quiet-writes.ts:747-816 (stable key, retry, known refusal); the fixed
    /// remote leader is replaced by the current signed may-answer computer and its fenced writer turn.
    SettleCommand { request: super::copies::pending::Submission },
    /// Command-only multipart transfer. A receiver keeps this apart from ordinary `Part` transfers and accepts the
    /// reconstructed message only when it is exactly `SettleCommand`; it cannot carry rows, buckets, votes or feeds.
    SettleCommandPart { transfer: u64, index: u32, count: u32, bytes: String },
    /// Read only a part of a sealed command receipt previously retained for this sender. The receiver never exposes
    /// an ordinary kept answer through this path, even if a sender guesses another transfer number.
    SettleCommandAnswerPart { transfer: u64, index: u32 },
}

impl Message {
    /// The narrowly typed submit/reply-parts path that may be used by an omitted computer. Sender proof remains
    /// required; no ordinary record settle or generic multipart envelope obtains this exception.
    pub(crate) fn command_settle(&self) -> bool {
        matches!(self, Self::SettleCommand { .. } | Self::SettleCommandPart { .. } | Self::SettleCommandAnswerPart { .. })
    }

    /// The term a writer sends this message under, when it is a writer's message: a push, or a renewal of its own
    /// term. The forwarder refuses such a message below the newest term it has carried for the account.
    pub fn writer_term(&self) -> Option<u64> {
        match self {
            Message::Group { request: GroupRequest::Push { term, .. } } => Some(*term),
            Message::Push { term, .. } | Message::PushHistory { term, .. } | Message::SignIn { term, .. } | Message::SignInMark { term, .. } => Some(*term),
            Message::Vote { ask, .. } if ask.term == ask.prior => Some(ask.term),
            _ => None,
        }
    }
}

/// The writer a `not_writer` refusal names: the computer and the term its writer row holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefusedWriter {
    pub computer: String,
    pub term: u64,
}

/// The `refused` word of an HTTP answer from a computer that does not hold the account: 503 with `{"refused":"not_held"}`.
/// The forwarder passes the request on to another computer that holds it (src/forwarder/gateway.rs `forward_http`).
pub(crate) const NOT_HELD: &str = "not_held";

/// A computer's answer to a `Message`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Answer {
    Group { answer: GroupAnswer },
    Vote {
        vote: Vote,
        /// The computers this voter vouched for (`Message::Vouch`) and for how much longer each may admit from its copy,
        /// in milliseconds from this answer.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        vouched: Vec<(String, i64)>,
    },
    /// A voter's answer to `Message::Vouch`: for how long, from when it asked, the asking computer may admit from its
    /// copy on this voter's word (0: not at all).
    Vouch { ms: i64 },
    Applied { stamp: i64 },
    Behind { stamp: i64 },
    /// One page: the term it is sent under, its changes, whether more follow, and every resource the replying
    /// computer follows (so a copy learns resources written after it started). `base` as in `Message::Push`.
    Page {
        #[serde(rename = "lease")] term: u64,
        changes: Vec<Carried>,
        more: bool,
        resources: Vec<String>,
        #[serde(default)]
        base: i64,
        /// The replying computer's computers row: its revision and the term it was made under. A copy that holds an older
        /// one asks for it (`Message::Row`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        row: Option<(u64, u64)>,
    },
    /// One page of sign-in changes, oldest first. `stamp` is the writer's sign-in stamp when nothing more follows.
    /// `fresh_ms`: the asking computer may admit sign-ins from its copy for this long after it sent the ask (0: not at
    /// all; the writer gives it only while it holds the writer role, and never past its own term). `root`: the secrets key
    /// sealed to the asking computer's own key, when it asked and may answer.
    SignInPage {
        #[serde(rename = "lease")] term: u64,
        base: u64,
        changes: Vec<RowChange>,
        more: bool,
        stamp: u64,
        fresh_ms: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        root: Option<String>,
        /// With `root`: the older roots a re-key left, sealed under that root (`secrets::secrets_key::Keyring::
        /// sealed_older`, base64), so a value sealed under one of them still opens.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keyring: Option<String>,
        /// When nothing more follows: the replying computer's read-back of its copied account rows (`Log::census`: per
        /// family, the count and the BLAKE3 of the ids), so the asking computer checks its own copy matches before it
        /// takes calls (`Copies::answers_now`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        census: Option<Vec<(String, u64, String)>>,
    },
    /// The replying computer's computers row and the term it was made under (`Message::Row`), and the mark (revision,
    /// term) of a proposed row it keeps pending, when it keeps one.
    Row {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "announced")] told: Option<KeptAccount>,
        #[serde(rename = "lease")] term: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pending: Option<(u64, u64)>,
    },
    /// The stamps of the computer asked, and whether its copy has caught up once since it was added (`Copies::joined`):
    /// a computer that has not refuses to vote for a takeover, so the writer names it a voter only once it says it has.
    Stamps {
        stamps: Vec<(String, u64, i64)>,
        #[serde(default = "joined_by_default")]
        joined: bool,
    },
    /// One page of versions in between (`Message::History`): the term it is sent under and its base, the versions,
    /// whether more follow, and the oldest version the replying computer keeps of the record.
    History { #[serde(rename = "lease")] term: u64, base: i64, versions: Vec<Past>, more: bool, kept: i64 },
    /// A copy took the changes of a push before change `id` (it holds `stamp`), and needs the versions of `id` after
    /// its own `version` (made at `since`) before it can take that change: the writer sends them (`PushHistory`) and
    /// pushes again.
    Needs { stamp: i64, id: String, version: i64, since: i64 },
    /// The answer is longer than one message may be: it is kept at the computer that answered as `count` parts
    /// of transfer `transfer`, and this is the first (`bytes`, base64 of the answer's JSON). The asker takes the others
    /// with `Message::AnswerPart`.
    Parts { transfer: u64, count: u32, bytes: String },
    /// One later part of a kept answer (`Message::AnswerPart`).
    Part { bytes: String },
    Done,
    Refused {
        code: String,
        cause: crate::refusal_cause::Cause,
        /// For `not_writer`: the writer this computer's writer row names while it is live, when that is another computer.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        writer: Option<RefusedWriter>,
    },
    /// The answer to `Message::Settle`.
    Settled { answer: crate::storage::record_store::record_sync::SettleAnswer },
    /// A terminal result of `Message::SettleCommand`, sealed for its original command identity. A transport loss or
    /// a computer that does not hold the writer turn never fabricates a terminal receipt.
    SettleCommand { receipt: super::copies::pending::Receipt },
    /// The answer to `Message::Holding`.
    Holding { holding: Box<Holding> },
    /// The answer to `Message::Tools`: one page of the live copy of the account's tools, or none when the replying
    /// computer has none.
    Tools { page: Option<serde_json::Value> },
}

/// Complete logical-history context travels with every group operation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum GroupRequest {
    Maintenance { scope: crate::storage::record_store_resources::domains::Identity, term: u64, nonce: String, frame: String },
    Bootstrap { scope: crate::storage::record_store_resources::domains::Identity, writer:bool, snapshot:Option<String>, ordinal:u64 },
    BootstrapClose { scope: crate::storage::record_store_resources::domains::Identity, snapshot:String },
    Probe { scope: crate::storage::record_store_resources::domains::Identity },
    Current { scope: crate::storage::record_store_resources::domains::Identity, term:u64 },
    TakeWriter { scope: crate::storage::record_store_resources::domains::Identity, released_term:u64 },
    Pull { scope: crate::storage::record_store_resources::domains::Identity, writer: bool, after: i64 },
    Push { scope: crate::storage::record_store_resources::domains::Identity, term: u64, base: i64, after: i64, commits: Vec<WireCommit> },
    Prepare { scope: crate::storage::record_store_resources::domains::Identity, term:u64, base:i64, after:i64, commits:Vec<WireCommit> },
    Finalize { scope: crate::storage::record_store_resources::domains::Identity, term:u64, commit:WireCommit },
    Abort { scope: crate::storage::record_store_resources::domains::Identity, term:u64, sequence:i64, digest:String },
    Resolve { scope: crate::storage::record_store_resources::domains::Identity, sequence:i64, digest:String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GroupAnswer {
    Maintenance { frame: String },
    Bootstrap { term:u64, base:i64, key:crate::storage::record_store_resources::carry::commit_log::opaque_map::WrappedKey,
        page:crate::storage::record_store_resources::carry::commit_log::opaque_map::MapPage,
        seal:Option<crate::storage::record_store_resources::carry::commit_log::opaque_map::MapSeal> },
    Stamps { through: i64, materialized: i64, retained_from: i64 },
    Current { term:u64, through:i64, digest:Option<String> },
    Writer {term:u64},
    Resolved {sequence:i64,digest:String,committed:bool},
    Applied { through: i64 },
    Page { term: u64, base: i64, commits: Vec<WireCommit>, through: i64, retained_from: i64, further: bool },
}

/// Native identity, physical keys, indexes and values remain inside authenticated
/// ciphertext. Base64 is wire encoding only; storage retains bounded bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireCommit {
    pub sequence: i64,
    pub digest: String,
    pub payload: String,
    pub map: WireMap,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WireMap {
    pub key: crate::storage::record_store_resources::carry::commit_log::opaque_map::WrappedKey,
    pub delta: crate::storage::record_store_resources::carry::commit_log::opaque_map::MapDelta,
}

/// What a computer that serves an account gives a computer the account's row names so it joins by itself
/// (`Message::Holding`, src/native_entry/computer/join_itself.rs): no record value, no secret and no root travel here.
/// Records and the vault's sealed secrets follow through the writer's feed; the root comes sealed to the asker's key on its
/// sign-in pull.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Holding {
    /// The account's computers row and key, believed only when the account's key signed the row for its address.
    pub row: KeptAccount,
    /// The account's restore file, as its bytes are kept (text).
    pub restore: String,
    /// The account's object index (one JSON line per object: ids and file names).
    pub index: String,
    /// The account rows a joined folder starts with: the key row and the computers row; and, to a computer the row lets
    /// answer, the account's settings and ways rows.
    pub rows: Vec<HeldRow>,
}

/// One account row as `Holding` carries it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HeldRow {
    pub family: String,
    pub id: String,
    pub account: String,
    pub expires_at: u64,
    pub value: serde_json::Value,
}


/// One change of one account row, as it travels and as the copy log keeps it (`rows_copy.rs`): its stamp, its
/// family and id, and the row after the change (`None`: the row is gone).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowChange {
    pub seq: u64,
    pub family: String,
    pub id: String,
    pub row: Option<RowBody>,
}

/// One account row made at a computer outside its copies (`Message::OutsideChanges`): the row after it (`None`: removed)
/// and the value the computer's log held of it before (`None`: it logged none).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutsideRow {
    pub family: String,
    pub id: String,
    pub row: Option<RowBody>,
    pub was: Option<String>,
}

/// The fields of a account row besides its id (`rows/families.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowBody {
    pub account: String,
    pub expires_at: i64,
    pub value: String,
}

/// What a computer posts to the forwarder: the message for one other computer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Post {
    pub message: Message,
}

/// What a computer posts to the forwarder to tell the account's computers row again while its session stays open
/// (`tell_again_path`): the row and the account's key, which the forwarder believes only as it believes a list of kept accounts
/// (`KeptAccount::believed`). `catching_up`: this computer holds the account but does not answer it yet
/// (`computers::kept_accounts_bytes_catching_up`); false once it has caught up, and the forwarder may send it calls.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TellAgain {
    #[serde(rename = "announced")] pub told: KeptAccount,
    #[serde(default)]
    pub catching_up: bool,
}

/// What a writer posts to the forwarder on each renewal of its term (`announce_term_path`), on its session's proof: the term
/// it holds and when that term runs out, signed by the writer's own computer key (`proof_uses` `term`). The forwarder takes
/// it only when the signature checks against the sending computer and that computer holds the account, so a restarted
/// forwarder learns the writer within one renewal, without trusting the message's bearer alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TermAnnouncement {
    pub term: u64,
    pub expires_at_ms: i64,
    /// The time the writer signed at (its clock, within `computer_proof_window_ms` of the forwarder's).
    pub at: i64,
    pub signature: String,
}

impl TermAnnouncement {
    /// The parts a term announcement's signature covers, in order: the account's address, the term and its end.
    pub fn signed_parts(account: &str, term: u64, expires_at_ms: i64) -> [String; 3] {
        [account.to_owned(), term.to_string(), expires_at_ms.to_string()]
    }
}

/// The input of a `message_operation` message: who the forwarder says sent it (the computer checks the proof in the message
/// against this), and the message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MessageFrom {
    pub from: String,
    pub message: Message,
}

/// The input of an `http_operation` message: one HTTP request for a path under `/a/<address>`. `body` is base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpAsk {
    pub method: String,
    /// The path and query, as the forwarder received them.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// The forwarder will fetch the rest of a whole file larger than one answer by byte range and stream it: the
    /// computer then answers such a read with its first window and `HttpAnswer::whole`, not 413. Absent from a
    /// forwarder that does not stream, which a computer then answers as before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stream: bool,
}

/// The computer's answer to an `HttpAsk`. `body` is base64.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Set on a 200 whose `body` is only the first window of a file of this many bytes (an `HttpAsk` with `stream`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub whole: Option<u64>,
}

/// On the request a computer hands its routes for an `HttpAsk` with `stream`: the routes may answer a whole file larger
/// than one answer with its first window (a response extension `WholeLength` then names the file's size).
#[derive(Clone, Copy, Debug)]
pub struct StreamWhole;

/// On a route's response: the size of the whole file whose first window the body is (`StreamWhole`).
#[derive(Clone, Copy, Debug)]
pub struct WholeLength(pub u64);

/// Headers that belong to one connection and are never carried: the forwarder and the computer each make their own.
pub fn carried_header(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "transfer-encoding" | "te" | "trailer" | "upgrade" | "proxy-connection" | "content-length"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip_and_name_their_writer_term() {
        let ask = Ask { id: "places:lease:x".into(), prior: 3, term: 3, expires_at_ms: 10 };
        let renewal = Message::Vote { ask: ask.clone(), stamps: vec![("own-records".into(), 3, 7)] };
        let takeover = Message::Vote { ask: Ask { term: 4, ..ask }, stamps: Vec::new() };
        let push = Message::Push { term: 5, resource: "own-records".into(), after: 0, changes: Vec::new(), base: 0 };
        let rows = Message::SignIn { term: 5, base: 0, after: 0, changes: vec![RowChange { seq: 1, family: "personal_keys".into(), id: "k".into(), row: None }] };
        assert_eq!(rows.writer_term(), Some(5), "a sign-in push is a writer's message");
        for message in [&renewal, &takeover, &push, &rows, &Message::Stamps] {
            let text = serde_json::to_string(message).unwrap();
            assert_eq!(&serde_json::from_str::<Message>(&text).unwrap(), message);
        }
        assert_eq!(renewal.writer_term(), Some(3));
        assert_eq!(takeover.writer_term(), None, "a claim is not a writer's message yet");
        assert_eq!(push.writer_term(), Some(5));
        // A history page the writer pushes is a writer's message too; a copy's ask for one and a vouch ask are not.
        let past = Past { from: 1, to: 2, version: 1, deleted: false, value: Some(serde_json::json!({"text": "v1"})) };
        let history = Message::PushHistory { term: 6, resource: "own-records".into(), id: "x".into(), kept: 1, versions: vec![past], base: 0 };
        let ask = Message::History { writer: true, resource: "own-records".into(), id: "x".into(), version: 0, since: 0, before: 9, limit: 4 };
        let vouch = Message::Vouch { term: 6, stamp: 3 };
        for message in [&history, &ask, &vouch] {
            let text = serde_json::to_string(message).unwrap();
            assert_eq!(&serde_json::from_str::<Message>(&text).unwrap(), message);
        }
        assert_eq!(history.writer_term(), Some(6));
        assert_eq!((ask.writer_term(), vouch.writer_term()), (None, None));
        let vote = Answer::Vote { vote: Vote { accepted: true, term: 6 }, vouched: vec![("p".into(), 900)] };
        assert_eq!(serde_json::from_str::<Answer>(&serde_json::to_string(&vote).unwrap()).unwrap(), vote);
        assert!(serde_json::from_str::<Message>(r#"{"kind":"nothing"}"#).is_err());
        // A newer peer's extra field is ignored; an unknown kind is still refused, since the kind names the message.
        assert!(serde_json::from_str::<Message>(r#"{"kind":"pull","writer":true,"resource":"r","after":0,"limit":1,"extra":1}"#).is_ok());
        let command = serde_json::json!({"kind":"settle_command","request":{"id":"request-one","payload":{"sealed":"opaque"}}});
        let command: Message = serde_json::from_value(command).unwrap();
        let command_parts = Message::SettleCommandPart { transfer: 7, index: 0, count: 2, bytes: "opaque".into() };
        let receipt_part = Message::SettleCommandAnswerPart { transfer: 8, index: 1 };
        for message in [&command, &command_parts, &receipt_part] {
            assert!(message.command_settle());
            assert_eq!(message.writer_term(), None, "a submission claims no writer term");
            assert_eq!(&serde_json::from_str::<Message>(&serde_json::to_string(message).unwrap()).unwrap(), message);
        }
        for ordinary in [Message::Stamps,
            Message::Part { transfer: 7, index: 0, count: 2, bytes: "opaque".into() },
            Message::AnswerPart { transfer: 8, index: 1 }] {
            assert!(!ordinary.command_settle(), "ordinary parts grant no command-only membership exception");
        }
        assert!(serde_json::from_str::<Message>(r#"{"kind":"settle_command_answer_part","transfer":8,"index":1,"resource":"own-records"}"#).is_ok(), "an extra field from a newer peer is ignored");
        assert!(!carried_header("Transfer-Encoding") && carried_header("cookie"));
    }
}

/// A `Stamps` answer that does not say whether its computer joined comes from a computer that was not added to a running
/// account: it has always counted as caught up.
fn joined_by_default() -> bool {
    true
}
