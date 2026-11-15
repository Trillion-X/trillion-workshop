//! Copies: one account's records kept at several computers, one writer at a time, and a write that counts only once a
//! second copy holds it.
//!
//! A `Copies` runs at one computer for one account whose computers row names voters (`ComputersRow::voters`). It holds:
//! - the computer's writer turn on the writer row (`writer_row.rs`), taken by the account's first write (`claim_for_write`), renewed by
//!   `tick` every `renew_every_ms` only while requests keep the account active (`touch`, `step_if_active`), and given up
//!   once none came for `idle_release_ms`: an idle account holds no term and runs no renewal;
//! - the computer's copy of the account's records (the account's records store file, record store);
//! - a `Link` that sends a `Message` to another computer of the account through the forwarder (`messages.rs`); the forwarder only
//!   carries it, over the receiving computer's own session.
//!
//! The rules it adds to `writer_row.rs`:
//! - **A write and its acknowledgement are one unit.** A write runs inside a transaction that is not committed yet.
//!   Before it commits, the writer sends the changes it made (`Message::Push`) to the other copies, and commits only
//!   when one of them answers that it holds every one of them (`Ack`: the caught-up stamp that copy reported is at
//!   least the write's stamp), while its own term still holds. Before it answers, it also waits (up to `ack_wait_ms`)
//!   for every other computer that may answer to hold the write, or for its push to end without it (out of reach or
//!   refused; such a computer is not waited for again until it reports it caught up, `unreached`): a computer that may answer takes the writer turn next, so a write a copy-only computer alone held was
//!   lost once the writer died (`acknowledged_by`; `tests/answering_computers_hold_acknowledged_writes.rs`). If no copy answers within `ack_wait_ms`, the
//!   transaction rolls back: no write that is not acknowledged is ever visible at the writer. The writer then gives
//!   its writer turn up, because a copy may hold the change it rolled back; after the term runs out the most caught-up computer
//!   takes the writer turn, so such a change is present exactly once or not at all.
//! - **The other copy keepers pull.** A computer that does not hold the writer turn pulls the writer's feed (`Message::Pull`, a page after
//!   its caught-up stamp, with `follow::catch_up`) on each tick, and so reports its caught-up stamp to the writer.
//! - **A computer claims only when caught up.** Before it claims, it asks every other computer it can reach for its stamps
//!   and pulls from any computer that holds more (`CaughtUp`). A voter also refuses a takeover from a computer whose copy
//!   holds less than its own (the stamps travel with the vote), so a new writer always holds every acknowledged write.
//! - **A new writer tells its term** with an empty push to every copy, which moves each copy's term floor
//!   (`RecordStore::apply_from_writer` refuses a page below it), so a stale writer's late pages are refused.
//!
//! Stamps are compared per records resource. The resources a copy follows are `replicated_resources` from settings,
//! every resource a write touched, and every resource another computer names in a page.
//!
//! What travels besides each record's current version (`follow::Carried`): its kept request answers, so a retry at a new
//! writer is answered with its first answer; the versions it had in between; and whether it was erased, so the copy
//! moves every version into custody as the writer did. A change carries at most `feed_history_items` versions in
//! between, and none when one change with them does not fit `message_body_bytes`; a copy that needs more (it lags, or the
//! record changed many times) takes the changes before it, then the rest of the record's history in bounded pages
//! (`Message::History` when it pulls, `Answer::Needs` and `Message::PushHistory` when the writer pushes), and only then
//! the change: its stamp passes a change only once it holds every version in between the writer keeps, so a write is
//! acknowledged only when a majority holds it whole. Versions the writer no longer keeps (its undo window ended, or an
//! erase) leave the copy too (`Carried::kept`). Pages carry `base`, the stamp the writer held of the resource
//! when it took its term: a copy that first hears that term and holds more took a change no writer acknowledged
//! (it was out of reach while another computer took over), and rolls it back to `base` before it applies anything
//! (`RecordStore::roll_back_after`).
//!
//! Holds a copy versus may answer: the computers row names `may_answer`, the computers that may answer the account. Only such
//! a computer claims the writer turn, gets the account's own rows (`rows_copy.rs`: the computers rows and the account's
//! lists) and gets the secrets key, sealed to its own computer key (`secrets::secrets_key::seal_to_computer`). A computer
//! that only holds a copy gets the records and the vault's sealed held values (the vault store, `with_vault`), never the
//! root or one of the account's own rows. It may vote. (The wire and counter names `SignIn*`/`sign_in` predate the move
//! of sign-in to the Better Auth Workshop tool; they carry these rows.)
//!
//! Records at rest at a computer that only holds a copy are sealed (`sealed.rs`). The writer seals each record value,
//! version in between and kept request answers under a key derived from the secrets key before they go to such a computer
//! (`for_peer`, decided by the signed row); with no root it sends such a computer nothing. Such a computer takes only sealed
//! parts (`take_in`: a plain one refuses the page), keeps them as they came (`Carried::sealed`), keeps no erased value
//! even sealed, and passes them on as they are (a catch-up before a claim may pull from it). A computer that may answer
//! and holds the root opens sealed parts as they arrive, and opens what it kept sealed once the root reaches it
//! (`open_held`: a computer the row names may-answer later). Every open goes through `sealed::open_value` with the roots
//! this computer holds, keyed by identity (`add_secrets_key` adds an older one).
//!
//! The account's own rows: a change of a copied row is made only at the writer (`rows_write`), as one unit with its
//! acknowledgement: it is sent to every may-answer computer first, and made (and so answered as done) only once one of
//! them holds it and every other may-answer computer holds it too or can no longer admit from its copy. A computer other than
//! the writer admits from its copy only for `admit_ms` after it last caught up with the writer (`may_admit`); the writer
//! gives that time only while it holds the writer turn and never past its own term, so after a takeover no computer admits from
//! the old writer's rows. A change that is not acknowledged is not made, and the writer gives its writer turn up. A computers
//! row the voters did not take is not made either, but the writer keeps its turn: a proposed row is acted on nowhere.
//!
//! While no writer is known (the term ran out at a voter, plus the margin), a computer that may answer asks the voters to
//! vouch for its copy of the account's rows (`vouch`, `Message::Vouch`); with more than half of them it admits for
//! `vouch_ms`. A voter vouches only while no term is live in its own writer row and the asker's sign-in counter holds
//! at least its own; it names the time it gave in every vote it answers, and the writer that wins counts that computer as
//! one that may still admit (`vouched`), as it counts `granted`. So a change done before the ask is held by the asker
//! (two halves of the voters share one), and a change done after waits for it. The writer turn moves promptly too: the first
//! other computer that may answer claims as the term runs out (its turn leaves out the computer that held it), the computer's
//! timer runs a step when one is due (`next_step_ms`), and a computer that hears a new writer pulls from it at once.
//!
//! Adding and removing a computer while the account runs. The account's computers row is held in memory (`Placed`) and
//! changes without a restart (`adopt`): a row the account's key signed, newer by (revision, term it was made under),
//! is taken from the writer's `Message::Row`, from the account's rows, or from any computer that holds a newer one (the row
//! is an entry of the stamps, so a claim catches up on it and a voter refuses a takeover from a computer with an older
//! one). The writer makes a change of the row (`rows_write`) only as a write acknowledged under the old voters: it
//! moves one voter at most, and a majority of the old voters and of the new voters must have taken the writer's term
//! and hold the new row first (`computers_acknowledge`). A computer added to a running account (`joining`) starts with
//! nothing and catches up through the ordinary feed, which pages each record's current version from stamp 0 within
//! `message_body_bytes` (with every version in between, in history pages when a change does not carry them); it neither claims nor votes
//! for a takeover until it has caught up. A computer the row no longer names is removed: it gives the writer turn up and stops;
//! every other computer refuses its messages. A computer the row no longer lets answer forgets the root; when it held it, the
//! writer re-keys (`rekey`): a new root, the old ones kept in a keyring sealed under it (`secrets::secrets_key::Keyring`),
//! the secrets snapshot sealed again, and the new root sent only to the computers still may-answer.
//!
//! Clocks: the term numbers use this computer's clock (`clock`); see `writer_row.rs` for the skew rule. The skew is checked,
//! not assumed: a computer's proof carries its clock, and a voter refuses a vote from a computer whose proof time is more
//! than `clock_margin_ms` from its own clock (`clock_skew`), so such a computer can neither claim nor keep the writer turn.

use crate::refusal_cause::CodedError;
use super::{
    writer_row::{self, Ack, Ask, CaughtUp, WriterRowCopy, WriterError, WriterResult, WriterRole, StoreCopy, Vote, Wire, WriterRow},
    messages::{Answer, Message, Post, MessageFrom, OutsideRow, RowChange},
    sealed::{self, At, Part, SecretsKeys},
    settings,
    rows_copy::{self, Asked, Counter, Expect, Log},
    one_voter_step, random_below, KeptAccount, ComputersRow, Subject,
};
use crate::{
    account::rows::store::Store,
    secrets::{secrets_key::{self, Keyring, ComputerKey}, SecretsKey},
    records::{changes, Error, Read, Records},
    resource_authority::decode_message,
    storage::{
        record_store::{
            follow::{self, Carried, Past},
            record_log::RecordLog,
            record_sync::{self, SettleRequest, SettleState, SettleStore, Settled, SyncError},
            settings::{self as store_settings, Limits},
            RecordStore, RealClock,
        },
        record_store_resources::{self as placements, books::book_path, FileOf},
        sqlite::{self, Access, Connection},
        Intent, Storage,
    },
};
use serde_json::json;
use serde::{Deserialize, Serialize};
use super::messages::{GroupAnswer, GroupRequest, WireCommit, WireMap};
use super::ScopeClass;
use placements::carry::{commit_log, commit_log::{CapturedCommit, OpaqueCommit}, live_adopt};
use commit_log::opaque_map::{self, WrappedKey, MapDelta, OpaqueRow, OpaqueUpdate};
use placements::domains::{Identity as GroupIdentity, Bound as GroupDomain};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering}, Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::{Duration, Instant},
};

/// A re-key this computer resealed under its new root: the account, this computer, and the names of the held values it sealed
/// again (never a value). Its line is `computers-copies event=resealed-under-new-root`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RekeyReport {
    pub account: String,
    pub computer: String,
    pub names: Vec<String>,
}

impl std::fmt::Display for RekeyReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "computers-copies event=resealed-under-new-root account={} computer={} values={} names={}",
            self.account,
            self.computer,
            self.names.len(),
            self.names.join(",")
        )
    }
}

/// A records store open inside a write's own transaction (or write scope), not committed yet.
type OpenWrite<'a> = RecordStore<Box<dyn Storage + 'a>>;

/// A records store a computer opened: whichever storage the computer has, behind the storage seam.
pub type ComputerStore = Box<dyn Storage + Send>;

/// How a computer opens the store that keeps one of an account's records resources (`Stores::path` names it). By
/// default a computer opens SQLite files on its own disk (no opener). A computer whose storage is lent by its host
/// (`storage::hosted_sql`) opens each path as a hosted database instead, and its limits come from its own report;
/// every other step of the copies (the writer turn, pushes, pulls, votes, catching up) is the same code.
pub trait StoreOpener: Send + Sync {
    /// The store at `path`, made with its schema when it is not there yet.
    fn open(&self, path: &Path) -> Result<ComputerStore, Error>;
    /// The limits of every store this computer keeps (from its report's storage).
    fn limits(&self) -> Limits;
    /// Group eligibility requires atomic scopes and bounded qualified history
    /// discovery. An opener that has not supplied both refuses grouped work.
    fn supports_domains(&self) -> bool { false }
    fn histories_page(&self, _state: &Path, _owner: &str, _after: Option<&str>, _limit: usize)
        -> Result<(Vec<GroupIdentity>,Option<String>),Error> { Err(crate::cause!(Error::Unavailable)) }
}

/// The opener of a computer whose storage its host lends through one statement call (`storage::hosted_sql::HostSql`):
/// `lend(path)` asks the host for the database it keeps under that store's name (a Durable Object's own SQLite, or
/// the native stand-in `storage::sqlite::hosted_stand_in` in tests), and every store is the hosted-SQL supply over it.
/// The computer's adapter gives `lend`; nothing here knows what kind of host it is.
pub struct HostedStores<H, F> {
    lend: F,
    limits: Limits,
    _host: std::marker::PhantomData<fn() -> H>,
}

impl<H, F> HostedStores<H, F>
where
    H: crate::storage::hosted_sql::HostSql + Send + 'static,
    F: Fn(&Path) -> Result<H, Error> + Send + Sync,
{
    /// The opener over `lend`, with the limits the computer's report gives every store it keeps.
    pub fn new(lend: F, limits: Limits) -> Self {
        HostedStores { lend, limits, _host: std::marker::PhantomData }
    }
}

impl<H, F> StoreOpener for HostedStores<H, F>
where
    H: crate::storage::hosted_sql::HostSql + Send + 'static,
    F: Fn(&Path) -> Result<H, Error> + Send + Sync,
{
    fn open(&self, path: &Path) -> Result<ComputerStore, Error> {
        let host = (self.lend)(path)?;
        let supply = crate::storage::hosted_sql::open(host, SCHEMA, placements::bounds().value_bytes).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(Box::new(supply))
    }
    fn limits(&self) -> Limits {
        self.limits
    }
}

/// The schema of the records store file.
const SCHEMA: &str = "record_store";
/// How long a send's answer is waited for before the wait clock is read again (`send_all`).
const SEND_STEP_MS: i64 = 20;

/// Sends one message from this computer to computer `to` of the same account; `None` when no answer came.
pub trait Link: Send + Sync {
    fn send(&self, to: &str, message: &Message) -> Option<Answer>;
    /// `send` for one logical request under `request_key`: every try of that request (`send_once_more_when_lost`) carries the
    /// same key, so the answering computer returns the answer it kept for the key instead of running the message again.
    fn send_keyed(&self, to: &str, message: &Message, _request_key: &str) -> Option<Answer> {
        self.send(to, message)
    }
}

/// This computer's clock, in milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What one pull of a computer's sign-in feed ended with (`Copies::sign_in_follow`): through, or refused for a reason.
#[derive(Clone)]
pub(crate) enum PullOutcome {
    Pulled,
    Refused(PullReason),
}

impl PullOutcome {
    pub(crate) fn pulled(&self) -> bool {
        matches!(self, Self::Pulled)
    }
}

/// Why a sign-in pull was refused: the word the log names it by and the cause it was refused at. `backing-off` is the refusal
/// while the DATA backoff after an earlier refusal has not run out (no pull was asked).
#[derive(Clone)]
pub(crate) struct PullReason {
    word: &'static str,
    cause: crate::refusal_cause::Cause,
}

impl PullReason {
    fn new(word: &'static str, cause: crate::refusal_cause::Cause) -> Self {
        Self { word, cause }
    }
}

/// The refusals in a row from one computer's sign-in feed, and when its next pull may be asked (this computer's clock).
struct PullBackoff {
    failures: u32,
    retry_at: i64,
}

/// The wait after `failures` refusals in a row: the base, doubled for each refusal after the first, never more than the max.
fn pull_backoff_ms(failures: u32, base: i64, max: i64) -> i64 {
    let doubled = 1i64.checked_shl(failures.saturating_sub(1).min(40)).unwrap_or(i64::MAX);
    base.saturating_mul(doubled).min(max)
}

#[cfg(test)]
mod pull_backoff_tests {
    use super::pull_backoff_ms;

    #[test]
    fn a_refused_sign_in_pull_waits_the_base_doubled_per_refusal_up_to_the_max() {
        assert_eq!(pull_backoff_ms(1, 250, 30_000), 250);
        assert_eq!(pull_backoff_ms(2, 250, 30_000), 500);
        assert_eq!(pull_backoff_ms(3, 250, 30_000), 1_000);
        assert_eq!(pull_backoff_ms(8, 250, 30_000), 30_000, "capped at the max");
        assert_eq!(pull_backoff_ms(u32::MAX, 250, 30_000), 30_000, "a long run of refusals never overflows");
    }
}

/// What a `Copies` is made from.
pub struct CopiesConfig {
    /// The account's address (its computers row and writer row are named by it).
    pub address: String,
    /// The account's internal owner id: the account its records are kept under.
    pub owner: String,
    /// The account's user id: its account rows, its host-kind rows and its key row are kept under it.
    pub user: String,
    /// This computer's id.
    pub computer: String,
    /// The account's computers row (its voters and computers that keep a copy).
    pub row: ComputersRow,
    /// The account's records store file at this computer.
    pub records: PathBuf,
    /// The store's limits; `None` takes this computer's own (`record_store_resources::computer_limits`).
    pub limits: Option<Limits>,
    /// The account's account rows at this computer, where the writer row copy is kept.
    pub sign_in: Arc<dyn Storage + Send + Sync>,
    /// How this computer opens its records stores; `None` is SQLite files on this computer's disk.
    pub stores: Option<Arc<dyn StoreOpener>>,
}

/// The account's account rows in the account folder `folder` (where a computer keeps its writer row copy), opened the
/// way the account's routes open them.
pub fn sign_in_rows(folder: &std::path::Path) -> Result<Arc<dyn Storage + Send + Sync>, CodedError<&'static str>> {
    crate::account::rows::open(folder).map_err(|error| CodedError::with_cause("the account rows did not open", error.cause()))
}

pub(crate) struct CurrentDomainHead {pub through:i64,pub digest:Option<String>}
/// Called outside the account admission hold. Only a current authoritative
/// writer's fresh physical snapshot can qualify a replica's complete read.
pub(crate) fn current_domain_head(owner:&str,scope:&GroupIdentity)->Result<Option<CurrentDomainHead>,Error> {
    let copies=locked(running()).get(owner).and_then(Weak::upgrade);
    match copies {Some(copies)=>copies.observe_domain_head(scope),None=>Ok(None)}
}

/// Native maintenance must separately retain its admitted canonical authority.
/// Membership and encryption prove the computer, never permission to move data.
pub(crate) trait DomainMaintenance: Send + Sync {
    fn answer(&self, from: &str, term: u64, scope: &GroupIdentity, plaintext: &[u8]) -> Result<Vec<u8>, Error>;
    /// Replica repair is system copy work, not permission to make a canonical
    /// transition. Only the independent original owner can produce this handle.
    fn replica_authority(&self,_scope:&GroupIdentity)->Result<Option<crate::local_account::NativeDomainAuthority>,Error> {Ok(None)}
}

/// A full-history replica baseline sampled in the target's actual held write
/// scope. Only the current computer's Group owner constructs this witness.
/// Native canonical authority remains a separate retained controller witness.
pub(crate) struct QualifiedDomainReplica<'a> {
    copies: &'a Copies,
    storage: &'a dyn Storage,
    scope: GroupIdentity,
    source: String,
    term: u64,
    through: i64,
    base: i64,
    membership: (u64,u64),
}
impl live_adopt::ReplicaBaseline for QualifiedDomainReplica<'_> {
    fn assert_same(&self, target: &dyn Storage, plan: &live_adopt::Plan) -> crate::storage::Result<()> {
        if !std::ptr::eq(self.storage,target) || group_stream(&self.scope,&self.copies.owner).ok().as_deref() != Some(plan.slot.as_str())
            || self.copies.placed().mark() != self.membership { return Err(crate::cause!(crate::storage::Error::Moved)); }
        let (through,base) = self.copies.replica_baseline(target,&self.source,self.term,&self.scope)
            .map_err(|error| crate::carry_cause!(crate::storage::Error::Moved, error))?;
        if (through,base) != (self.through,self.base) { return Err(crate::cause!(crate::storage::Error::Conflict)); }
        Ok(())
    }
}

pub mod pending;
mod local_pending;

/// Why a write did not count.
#[derive(Clone, Debug)]
pub enum WriteRefused {
    /// This computer does not hold the writer turn now: the account's writer is elsewhere, or none is.
    NotWriter(crate::refusal_cause::Cause),
    /// No second copy held the write in time; it was rolled back and the writer turn given up.
    NotAcknowledged(crate::refusal_cause::Cause),
    /// The writer turn was asked for and not taken within the write's wait; nothing was written, so the request is retried
    /// by its request key.
    NotStarted(crate::refusal_cause::Cause),
    /// The records store refused the write itself; nothing was sent.
    Records(Error, crate::refusal_cause::Cause),
    /// The commit itself failed after the acknowledgement: the outcome is not known.
    OutcomeUnknown(crate::refusal_cause::Cause),
}

impl WriteRefused {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotWriter(cause) => cause.clone(),
            Self::NotAcknowledged(cause) => cause.clone(),
            Self::NotStarted(cause) => cause.clone(),
            Self::Records(error, _) => error.cause(),
            Self::OutcomeUnknown(cause) => cause.clone(),
        }
    }
}
impl PartialEq for WriteRefused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NotWriter(_), Self::NotWriter(_)) => true,
            (Self::NotAcknowledged(_), Self::NotAcknowledged(_)) => true,
            (Self::NotStarted(_), Self::NotStarted(_)) => true,
            (Self::Records(left, _), Self::Records(right, _)) => left == right,
            (Self::OutcomeUnknown(_), Self::OutcomeUnknown(_)) => true,
            _ => false,
        }
    }
}


/// One account's copies at this computer: see the module doc.
pub struct Copies {
    address: String,
    owner: String,
    /// The account's user id: the host-kind rows the placement reads are kept under it (`Placed::with_kinds`).
    user: String,
    me: String,
    /// The account's computers row as this computer holds it now, and what it says of this computer (`Placed`). It changes
    /// while the computer runs (`adopt`): a row edit takes effect at once, with no restart.
    placed: Mutex<Arc<Placed>>,
    /// The seal format this computer last chose for its peers (`roots`).
    seal_choice: Mutex<Option<SealChoice>>,
    /// The account's public key (64 hex), when known: rows travel with it (`KeptAccount`), so a receiver checks them
    /// against the account's address with nothing stored.
    account_key: Mutex<Option<String>>,
    /// Whether this computer's copy has caught up once since it started (`joining`). Until then it never claims the writer turn
    /// and refuses to vote for a takeover: a computer added to a running account starts with nothing.
    joined: AtomicBool,
    /// When this computer's copy caught up once after it was added (`joining`), on its own clock; `i64::MIN` for a computer
    /// that was not added. Its turn to claim counts from here too (`claim_times`).
    joined_at: AtomicI64,
    /// Set by the write path when this computer should claim the writer turn: the timer's next step claims it (`tick`), so a
    /// claim's peer calls never run on a request's thread (`claim_for_write`).
    claim_wanted: AtomicBool,
    /// What a write at this copy asks for first (`set_on_write`): the computer's timer takes the account into its steps.
    on_write: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// Until when a lost claim holds the next one back (`hold_claims`), in clock milliseconds; `i64::MIN` when none does.
    claim_held_until: AtomicI64,
    /// Whether this computer's account rows have matched the writer's by count and identity per family once since it
    /// started (`answers_now`): the read-back of old trillion's carry (src/resource-state-carry.mjs), before a computer
    /// added to the account takes calls. Always, for a computer that was not added (`joining`).
    read_back: AtomicBool,
    /// A re-key whose secrets snapshot was not sealed again yet: the writer retries on its timer step.
    reseal_due: AtomicBool,
    /// The last re-key this computer resealed (`reseal`), for its report.
    last_rekey: Mutex<Option<RekeyReport>>,
    /// The mark (revision, term) of a computers row a writer proposed and has not said it made. Never acted on.
    proposed: Mutex<Option<(u64, u64)>>,
    /// The writer row id.
    id: String,
    /// The writer turn. Its lock is never held while a message is out: a renewal or a claim runs on a copy of the writer turn,
    /// which is put back only if the writer turn was not given up meanwhile (`epoch`).
    writer_role: Mutex<WriterRole>,
    /// Counts each time the writer turn is given up.
    epoch: std::sync::atomic::AtomicU64,
    writer_rows: SharedCopy,
    records: Stores,
    link: Arc<dyn Link>,
    clock: Clock,
    waiting: Arc<dyn crate::storage::time_source::Clock>,
    /// The caught-up stamp each other computer last reported to this one, per (computer, resource).
    heard: Mutex<HashMap<(String, String), i64>>,
    /// The other computers that may answer which the writer's last write could not reach (its push to them ended without
    /// them holding it). A write still sends them its changes but does not wait for them, so a dead one costs one wait;
    /// each leaves this set once it holds a write in time or reports it caught up with the writer (`Message::CaughtUp`).
    unreached: Mutex<HashSet<String>>,
    resources: Mutex<BTreeSet<String>>,
    group_inventory_ready: AtomicBool,
    group_inventory_supported: AtomicBool,
    group_inventory: Mutex<Option<placements::domains::Inventory>>,
    group_inventory_cursor: Mutex<Option<String>>,
    domain_maintenance: Option<Arc<dyn DomainMaintenance>>,
    unmaterialized_groups: Mutex<BTreeSet<String>>,
    group_sources:Mutex<HashMap<String,Arc<Mutex<Option<GroupSnapshotSource>>>>>,
    group_targets:Mutex<HashMap<String,Arc<Mutex<GroupSnapshotTarget>>>>,
    /// Settle stores another computer's settle changed here, by copy key, with the last settle row before it
    /// (`take_settled`): what it took reaches this computer's records once it writes for the account.
    settled_since: Mutex<std::collections::BTreeMap<String, Option<String>>>,
    pending_handler: std::sync::OnceLock<Arc<dyn Fn(&pending::Command) -> Option<pending::Terminal> + Send + Sync>>,
    pending_active: AtomicBool,
    pending_refresh: Mutex<BTreeSet<(String,String,Option<placements::domains::Identity>)>>,
    /// The records book was looked at for stores kept there before they had files of their own (`carry_into_own_files`).
    carried_own: AtomicBool,
    /// The write in hand: its resources and stamps, which the acknowledgement waits on.
    pending: Mutex<Vec<(String, i64)>>,
    /// One write at a time.
    writing: Mutex<()>,
    /// Only the final quorum proof publication is shared across independent
    /// domain writers. No network operation holds this reservation.
    ack_proof: Mutex<()>,
    /// The account's account rows at this computer (raw: never through the account routes' view), where the copy log is kept.
    sign_in_raw: Arc<dyn Storage + Send + Sync>,
    /// One sign-in change at a time: the writer's changes, the pages and pushes a copy applies, and the updates a copy
    /// makes on its own. Never held while a message is out from a copy (a writer holds it through its push).
    sign_in: Mutex<SignInState>,
    /// The sign-in stamp each other may-answer computer last reported to the writer.
    sign_in_heard: Mutex<HashMap<String, u64>>,
    /// When each may-answer computer's time to admit from its copy ends, as the writer gave it (writer's clock).
    granted: Mutex<HashMap<String, i64>>,
    /// Until when this computer may admit a sign-in from its copy as a computer other than the writer (its own clock).
    fresh_until: AtomicI64,
    /// When this copy last heard the writer's sign-in feed (its own clock, from when the page was asked): a sign-in from
    /// this copy is admitted only within `revocation_settle_ms` of it, so a cut-off copy refuses rather than admit a revoked key.
    heard_at: AtomicI64,
    /// The sign-in pulls refused in a row from each computer (`sign_in_follow`): its count, and until when (this computer's clock)
    /// its next pull waits, from the DATA backoff. A pull that goes through clears its computer's entry.
    pull_backoff: Mutex<HashMap<String, PullBackoff>>,
    /// The computers that may admit from their copies on voters' word while no writer was known (`Message::Vouch`), and
    /// until when (this computer's clock): the ones this computer vouched for as a voter, and the ones other voters named
    /// in their votes. A writer counts them as computers that may still admit, as it counts `granted`.
    vouched: Mutex<HashMap<String, i64>>,
    /// A step is due at once (this computer just heard a new writer): `next_step_ms` answers 0.
    step_now: AtomicBool,
    /// When this computer last ran a step (`tick`), on its own clock.
    last_step: AtomicI64,
    /// When a request (a write or a read, from a person or an AI) last reached the account at this computer, on its own
    /// clock (`touch`); `i64::MIN` until one does. The computer's timer steps the account only while one came within
    /// `idle_release_ms`, and the writer turn is released after that (`step_if_active`).
    last_used: AtomicI64,
    /// This computer's last claim did not win, and no writer has been heard since (no page or push of a writer was
    /// taken): its turn to claim counts every computer that may claim (`claim_times`).
    split: AtomicBool,
    /// Computers that refused this computer's writer pull as `not_writer`, and when each is asked again.
    refused_until: Mutex<std::collections::HashMap<String, i64>>,
    /// Held while this computer claims the writer turn (`claim`): the timer's claim and a write's (`claim_for_write`)
    /// ran at once, and the second asked the voters for a newer term than the first had just won, so it lost its own
    /// turn (measured 2026-11-04 at full computers after an idle account woke: every sign-in change refused).
    claiming: Mutex<()>,
    /// The writer number this computer wrote under at its last step (0: none), so a step that finds it no longer writes
    /// says so once (`computers-writer event=lost`), whatever ended it.
    wrote_under: std::sync::atomic::AtomicU64,
    /// Messages longer than one message between computers may be, travelling in parts (`send`): the next transfer number this computer
    /// sends under, the parts it holds of one message from each computer (`Message::Part`), and the parts of one long
    /// answer it keeps for each computer (`Answer::Parts`).
    transfers: std::sync::atomic::AtomicU64,
    incoming: Mutex<HashMap<String, Incoming>>,
    outgoing: Mutex<HashMap<String, Outgoing>>,
    /// The secrets key and this computer's key (`with_secrets_key`).
    vault: Mutex<VaultKeys>,
    /// The account's policy and key-value stores at this computer, which travel as records of one resource
    /// (`with_account_stores`, `account_stores.rs`).
    account_stores: OnceLock<super::account_stores::AccountStoresCopy>,
}

/// Send `message` to `peer` over `link`: as one message when it fits one message's bound, else in parts (`Message::Part`), each
/// within it, up to `carried_bytes` in all; and take an answer kept in parts (`Answer::Parts`) part by part. Every
/// message's parts go under transfer number `transfer`. Answers `None` when any part got no answer.
fn send_on(link: &dyn Link, transfer: u64, peer: &str, message: &Message) -> Option<Answer> {
    let command = matches!(message, Message::SettleCommand { .. });
    let posted = serde_json::to_vec(&Post { message: message.clone() }).ok()?;
    let answer = if posted.len() <= settings().message_body_bytes {
        send_once_more_when_lost(link, peer, message)?
    } else {
        let whole = serde_json::to_vec(message).ok()?;
        if whole.len() > settings().carried_bytes {
            return None;
        }
        let size = part_bytes();
        let count = u32::try_from(whole.len().div_ceil(size)).ok()?;
        let mut last = None;
        for (index, chunk) in whole.chunks(size).enumerate() {
            let index = u32::try_from(index).ok()?;
            let part = if command { Message::SettleCommandPart { transfer, index, count, bytes: base64_of(chunk) } }
                else { Message::Part { transfer, index, count, bytes: base64_of(chunk) } };
            match link.send(peer, &part)? {
                answer if index + 1 == count => last = Some(answer),
                Answer::Done => {}
                _ => return None,
            }
        }
        last?
    };
    let Answer::Parts { transfer, count, bytes } = answer else { return Some(answer) };
    let mut whole = bytes_of(&bytes)?;
    for index in 1..count {
        let ask = if command { Message::SettleCommandAnswerPart { transfer, index } } else { Message::AnswerPart { transfer, index } };
        let Answer::Part { bytes } = link.send(peer, &ask)? else { return None };
        whole.extend(bytes_of(&bytes)?);
        if whole.len() > settings().carried_bytes {
            return None;
        }
    }
    match serde_json::from_slice::<Answer>(&whole).ok()? {
        Answer::Parts { .. } | Answer::Part { .. } => None,
        answer => Some(answer),
    }
}

/// `send_on` for a sender that is not one account's copies (a computer that joins an account by itself asks
/// `Message::Holding`, src/native_entry/computer/join_itself.rs): its transfer number from the clock, so two asks never
/// share one. A long answer comes back in parts (`Answer::Parts`), taken part by part.
pub fn send_in_parts(link: &dyn Link, peer: &str, message: &Message) -> Option<Answer> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let now = u64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_micros())).unwrap_or(0);
    let transfer = NEXT.fetch_max(now, Ordering::AcqRel).max(now) + 1;
    NEXT.fetch_max(transfer, Ordering::AcqRel);
    send_on(link, transfer, peer, message)
}

/// Part `index` of `count` of transfer `transfer` from `from`, in order: kept until the last, which answers the whole
/// message. A computer keeps the parts of one message from each computer, for at most `part_hold_ms`, at most
/// `carried_bytes` in all; a part 0 starts that computer's message again.

/// `link.send`, sent again (at most `resend_when_lost` times) when no answer came back and the try failed within half
/// of the wait for one message: a connection that broke, not a computer that is slow to answer (a slow one is not asked twice,
/// so a renewal never waits twice as long). Measured 2026-11-04 on three computers behind one forwarder: about every
/// 2 to 5 minutes one post to the other computer that may answer failed after about 125 ms (`WouldBlock`), the write it
/// carried was not acknowledged, and the writer stopped writing; with two of three voters left, every write needs
/// that one computer. Taking a message twice is safe for every message here (see `settings.json`).
///
/// A refusal `not_answering_yet` is also sent again: the computer refused it before the message ran (a session that is
/// handing the account over to the computer's own session), so a retry cannot run it twice (gRPC's retry rule: a call refused
/// before it reaches the handler is safe to retry; an unknown outcome is not).
fn send_once_more_when_lost(link: &dyn Link, peer: &str, message: &Message) -> Option<Answer> {
    let early = Duration::from_millis(settings().message_wait_ms / 2);
    let request_key = new_request_key()?;
    let mut tries = 0;
    loop {
        let started = Instant::now();
        let answer = link.send_keyed(peer, message, &request_key);
        let never_started = matches!(&answer, Some(Answer::Refused { code, .. }) if code == NOT_ANSWERING_YET);
        if (answer.is_some() && !never_started) || tries >= settings().resend_when_lost || started.elapsed() >= early {
            return answer;
        }
        tries += 1;
    }
}

/// The refusal a computer gives a message it refused before the message ran (`native_entry/computer.rs` MAY_NOT_ANSWER_YET).
pub(crate) const NOT_ANSWERING_YET: &str = "not_answering_yet";

/// A new key for one logical request: 128 random bits, hex (`Link::send_keyed`).
pub fn new_request_key() -> Option<String> {
    let mut bytes = [0_u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// How many parts after the first `message` goes in (`send_on`): 0 when it fits one message.
fn extra_parts(message: &Message) -> u64 {
    let Ok(posted) = serde_json::to_vec(&Post { message: message.clone() }) else { return 0 };
    if posted.len() <= settings().message_body_bytes {
        return 0;
    }
    u64::try_from(posted.len().div_ceil(part_bytes())).unwrap_or(u64::MAX).saturating_sub(1)
}

/// The parts of one long message from a computer (`Message::Part`), as they came: the next index it waits for.
struct Incoming {
    transfer: u64,
    count: u32,
    next: u32,
    bytes: Vec<u8>,
    at: i64,
}

/// One long answer kept for a computer (`Answer::Parts`): its parts, base64, and when it was kept.
struct Outgoing {
    transfer: u64,
    parts: Vec<String>,
    at: i64,
}

// Ports placed-lists.mjs:10-41 through the existing full-domain Storage
// and Copies owners. Sessions exist only for active bounded work. A source
// owns its ONE snapshot; a target owns its ONE unpublished write transaction.
enum GroupSnapshotCursor { Physical(opaque_map::PhysicalCursor,sealed::OpaqueTokenKey), Opaque(opaque_map::MapCursor) }
struct GroupSnapshotSource {
    store:Option<RecordStore<ComputerStore>>,cursor:GroupSnapshotCursor,
    scope:GroupIdentity,writer:bool,term:u64,base:i64,mark:(u64,u64),at:i64,key:WrappedKey,
    last:Option<GroupAnswer>,
}
impl Drop for GroupSnapshotSource {fn drop(&mut self){if let Some(store)=&self.store {let _=store.storage().close_scope(false);}}}
struct GroupSnapshotReceive {computer:String,scope:GroupIdentity,writer:bool,term:u64,base:i64,mark:(u64,u64),at:i64,head:opaque_map::MapHead,next:u64}
enum GroupInstallCursor {Plain(opaque_map::MaterializationCursor,sealed::OpaqueTokenKey),Opaque(opaque_map::OpaqueInstallCursor)}
struct GroupSnapshotInstall {store:RecordStore<ComputerStore>,cursor:Option<GroupInstallCursor>,scope:GroupIdentity,mark:(u64,u64),at:i64,retired:bool}
impl Drop for GroupSnapshotInstall {fn drop(&mut self){let _=self.store.storage().close_scope(false);}}
#[derive(Default)]
struct GroupSnapshotTarget {receive:Option<GroupSnapshotReceive>,install:Option<GroupSnapshotInstall>,at:i64,retry_bootstrap:bool}

/// The most raw bytes one part carries, so the part (base64, in its envelope) fits one message's bound.
fn part_bytes() -> usize {
    let envelope = serde_json::to_vec(&Post { message: Message::Part { transfer: u64::MAX, index: u32::MAX, count: u32::MAX, bytes: String::new() } })
        .map_or(0, |bytes| bytes.len())
        .max(serde_json::to_vec(&Answer::Parts { transfer: u64::MAX, count: u32::MAX, bytes: String::new() }).map_or(0, |bytes| bytes.len()));
    (settings().message_body_bytes.saturating_sub(envelope) / 4 * 3).max(3)
}

fn base64_of(bytes: &[u8]) -> String {
    use base64::prelude::*;
    BASE64_STANDARD.encode(bytes)
}

fn bytes_of(text: &str) -> Option<Vec<u8>> {
    use base64::prelude::*;
    BASE64_STANDARD.decode(text).ok()
}

/// A copy's sign-in state that is not kept in rows: while it starts again from nothing, the rows the writer's feed
/// named so far, with their stamps.
#[derive(Default)]
struct SignInState {
    resync: Option<HashMap<(String, String), u64>>,
}

/// What a computer keeps to receive and send the secrets key.
#[derive(Default)]
struct VaultKeys {
    computer_key: Option<Arc<ComputerKey>>,
    state: Option<PathBuf>,
    root: Option<SecretsKey>,
    /// The older roots a re-key left, newest first (`Keyring`).
    older: Vec<SecretsKey>,
    /// The roots this computer opens sealed record values with, keyed by identity: the root above (which seals) and any
    /// older root added (`add_secrets_key`).
    roots: SecretsKeys,
}

/// The account's computers row as one computer holds it, and what it says about that computer.
struct Placed {
    row: ComputersRow,
    /// The writer term the row was made or sent under; 0 for a row read at start.
    term: u64,
    voters: Vec<String>,
    /// The other computers that hold a copy or vote, sorted.
    peers: Vec<String>,
    /// Whether the row lets this computer answer the account.
    may_answer: bool,
    /// The other computers the row lets answer, sorted: they get the account rows and the root.
    may_answer_peers: Vec<String>,
    /// Whether the row names this computer as a computer that keeps a copy. A computer the row no longer names is removed: it stops writing,
    /// following, voting and may-answer for the account.
    keeps_copy: bool,
    /// The host kind of each computer the row names, read from the account's account rows; an unreadable one is kept as its reason.
    kinds: Result<std::collections::BTreeMap<String, String>, String>,
}

impl Placed {
    fn of(row: &ComputersRow, term: u64, me: &str) -> Placed {
        let mut peers: Vec<String> = row.copy_keepers.iter().chain(row.voters.iter()).filter(|computer| *computer != me).cloned().collect();
        peers.sort();
        peers.dedup();
        let mut may_answer_peers: Vec<String> = row.may_answer.iter().filter(|computer| *computer != me).cloned().collect();
        may_answer_peers.sort();
        may_answer_peers.dedup();
        Placed {
            row: row.clone(),
            term,
            voters: row.voters.clone(),
            peers,
            may_answer: row.may_answer.iter().any(|computer| computer == me),
            may_answer_peers,
            keeps_copy: row.copy_keepers.iter().any(|computer| computer == me),
            kinds: Ok(std::collections::BTreeMap::new()),
        }
    }

    /// The one constructor a placement is made with: the row as `of` makes it, plus the host kind of every computer it names,
    /// read from the account's account rows (`user`) through the list-row helper (`copy_rule::host_kind_row`).
    fn with_kinds(sign_in: &dyn Storage, user: &str, row: &ComputersRow, term: u64, me: &str) -> Placed {
        let mut placed = Placed::of(row, term, me);
        let store = crate::account::rows::store::Store::new(sign_in);
        let mut kinds = std::collections::BTreeMap::new();
        for computer in row.copy_keepers.iter().chain(&row.may_answer).chain(&row.voters) {
            match crate::account::computers::copy_rule::host_kind_row(&store, user, computer) {
                Ok(Some(kind)) => {
                    kinds.insert(computer.clone(), kind);
                }
                Ok(None) => {}
                Err(error) => {
                    placed.kinds = Err(format!("{error:?}"));
                    return placed;
                }
            }
        }
        placed.kinds = Ok(kinds);
        placed
    }

    /// Shadow only: whether the policy lets `me` answer for the account. The row must name it as answering, and its host kind
    /// (its own kind row, or `existing_kind` for a computer the row names) must allow `answer`.
    fn policy_answers(&self, me: &str) -> bool {
        match &self.kinds {
            Ok(kinds) if self.may_answer => {
                let names = &crate::account::computers::settings().host_kinds;
                let kind = kinds.get(me).map_or(names.existing_kind.as_str(), String::as_str);
                crate::account::computers::copy_rule::host_kind_allows(kind, crate::account::computers::copy_rule::ANSWER)
            }
            _ => false,
        }
    }

    /// The mark copies compare rows by: the revision, then the term it was made under.
    fn mark(&self) -> (u64, u64) {
        (self.row.revision, self.term)
    }
}

/// The seal format a computer chose, with the peers and the heard-report revision it chose it from.
#[derive(Clone)]
struct SealChoice {
    revision: u64,
    peers: Vec<String>,
    version: u32,
    /// The peer that holds the write format back, when one does.
    held_back: Option<String>,
}

/// The roots a computer opens sealed record values with: `current` seals, `older` (a re-key's keyring) only open.
fn secrets_keys_of(current: Option<&SecretsKey>, older: &[SecretsKey]) -> SecretsKeys {
    let Some(current) = current else { return SecretsKeys::default() };
    let mut roots = SecretsKeys::of(current).unwrap_or_default();
    for root in older {
        let _ = roots.add(root);
    }
    roots
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Copies {
    /// The copies of the account `config` names, at this computer. Refused when the row does not name this computer as a
    /// computer that keeps a copy or names no voters (a one-computer account needs no copies).
    pub fn new(config: CopiesConfig, link: Arc<dyn Link>, clock: Clock) -> Result<Self, CodedError<&'static str>> {
        Self::open(config, link, clock, false)
    }

    /// Reopen the hosting door's local command owner even after this computer
    /// was removed from the signed row. The unchanged placement marks it removed:
    /// it cannot copy canonical rows, vote, admit them or claim a writer turn.
    /// Only its caller-authorized pending commands use the existing settle link.
    pub(crate) fn for_local_commands(config: CopiesConfig, link: Arc<dyn Link>, clock: Clock) -> Result<Self, CodedError<&'static str>> {
        Self::open(config, link, clock, true)
    }

    fn open(config: CopiesConfig, link: Arc<dyn Link>, clock: Clock, local_commands: bool) -> Result<Self, CodedError<&'static str>> {
        // Transfer numbers start from the clock, so a restarted computer does not reuse one a peer still holds parts of.
        let first_transfer = u64::try_from(clock()).unwrap_or(0);
        let row = &config.row;
        if row.account != config.address || row.pursuit.is_some() {
            return Err(CodedError::new("the computers row is not the account's own row"));
        }
        if row.voters.is_empty() {
            return Err(CodedError::new("the computers row names no voters"));
        }
        if !local_commands && row.copy_keepers.binary_search(&config.computer).is_err() {
            return Err(CodedError::new("the computers row does not name this computer as a copy keeper"));
        }
        let placed = Placed::with_kinds(&*config.sign_in, &config.user, row, 0, &config.computer);
        let subject = Subject::Account(config.address.clone());
        let writer_role = WriterRole::new(&subject, &config.computer, &row.voters);
        Ok(Copies {
            id: writer_role.id().to_string(),
            writer_role: Mutex::new(writer_role),
            epoch: std::sync::atomic::AtomicU64::new(0),
            placed: Mutex::new(Arc::new(placed)),
            seal_choice: Mutex::new(None),
            account_key: Mutex::new(None),
            joined: AtomicBool::new(true),
            joined_at: AtomicI64::new(i64::MIN),
            claim_wanted: AtomicBool::new(false),
            on_write: OnceLock::new(),
            claim_held_until: AtomicI64::new(i64::MIN),
            read_back: AtomicBool::new(true),
            reseal_due: AtomicBool::new(false),
            last_rekey: Mutex::new(None),
            proposed: Mutex::new(None),
            writer_rows: SharedCopy { storage: config.sign_in.clone(), account: config.owner.clone() },
            records: Stores { records: config.records, vault: None, state: None, owner: config.owner.clone(), limits: config.limits, opener: config.stores },
            sign_in_raw: config.sign_in,
            address: config.address,
            owner: config.owner,
            user: config.user,
            me: config.computer,
            link,
            clock,
            waiting: Arc::new(crate::storage::time_source::RealClock),
            heard: Mutex::new(HashMap::new()),
            unreached: Mutex::new(HashSet::new()),
            resources: Mutex::new(settings().replicated_resources.iter().cloned().collect()),
            group_inventory_ready: AtomicBool::new(true),
            group_inventory_supported: AtomicBool::new(true),
            group_inventory: Mutex::new(None),
            group_inventory_cursor: Mutex::new(None),
            domain_maintenance: None,
            unmaterialized_groups: Mutex::new(BTreeSet::new()),
            group_sources:Mutex::new(HashMap::new()),
            group_targets:Mutex::new(HashMap::new()),
            settled_since: Mutex::new(std::collections::BTreeMap::new()),
            pending_handler: std::sync::OnceLock::new(),
            pending_active: AtomicBool::new(false),
            pending_refresh: Mutex::new(BTreeSet::new()),
            carried_own: AtomicBool::new(false),
            pending: Mutex::new(Vec::new()),
            writing: Mutex::new(()),
            ack_proof: Mutex::new(()),
            sign_in: Mutex::new(SignInState::default()),
            sign_in_heard: Mutex::new(HashMap::new()),
            granted: Mutex::new(HashMap::new()),
            fresh_until: AtomicI64::new(i64::MIN),
            heard_at: AtomicI64::new(i64::MIN),
            pull_backoff: Mutex::new(HashMap::new()),
            vouched: Mutex::new(HashMap::new()),
            step_now: AtomicBool::new(false),
            split: AtomicBool::new(false),
            refused_until: Mutex::new(std::collections::HashMap::new()),
            claiming: Mutex::new(()),
            wrote_under: std::sync::atomic::AtomicU64::new(0),
            transfers: std::sync::atomic::AtomicU64::new(first_transfer),
            incoming: Mutex::new(HashMap::new()),
            outgoing: Mutex::new(HashMap::new()),
            last_step: AtomicI64::new(i64::MIN),
            last_used: AtomicI64::new(i64::MIN),
            vault: Mutex::new(VaultKeys::default()),
            account_stores: OnceLock::new(),
        })
    }

    /// Use the same injected clock for lease reads and waits for a grant to end.
    pub fn with_clock(mut self, clock: Arc<dyn crate::storage::time_source::Clock>) -> Self {
        let reading = clock.clone();
        self.clock = Arc::new(move || reading.now_ms());
        self.waiting = clock;
        self
    }

    /// Keep the account's policy and key-value stores in `folder` (its policy database at `policy_file`, relative) as
    /// records the writer's feed carries (`account_stores.rs`): the writer writes their changes, every other computer that
    /// may answer takes them into its own stores.
    pub fn with_account_stores(self, folder: PathBuf, policy_file: PathBuf) -> Self {
        let _ = self.account_stores.set(super::account_stores::AccountStoresCopy::new(folder, policy_file));
        self
    }

    /// One step of the account stores (`account_stores.rs`): at the writer, their changes are written as records; at
    /// any other computer that may answer, the records are taken into them. Nothing when this computer keeps none.
    pub fn account_stores_step(&self) -> super::account_stores::Stepped {
        match self.account_stores.get() {
            Some(stores) if !self.removed() => stores.step(self),
            _ => super::account_stores::Stepped::default(),
        }
    }

    /// The account stores step on a thread of its own, when one has anything to do (`AccountStoresCopy::step_soon`): for a
    /// caller that must not wait for the copies, as the answer to a request that ran.
    pub fn account_stores_step_soon(self: &Arc<Self>) {
        if let Some(stores) = self.account_stores.get().filter(|_| !self.removed()) {
            stores.step_soon(self);
        }
    }

    /// The size and change time of the file that keeps `resource` here and of its write-ahead log: equal twice means no record of it
    /// changed between (a stat of two files, where `stamp` opens the store).
    pub(crate) fn records_marks(&self, resource: &str) -> Vec<Option<(u64, std::time::SystemTime)>> {
        let file = self.records.path(resource);
        let mut log = file.clone().into_os_string();
        log.push("-wal");
        [file, PathBuf::from(log)].into_iter()
            .map(|file| std::fs::metadata(file).ok().and_then(|meta| meta.modified().ok().map(|changed| (meta.len(), changed))))
            .collect()
    }

    pub(crate) fn account_stores_of(&self) -> Option<&super::account_stores::AccountStoresCopy> {
        self.account_stores.get()
    }

    /// Whether this computer's account stores are there (`account_stores.rs`), after one step that takes what its copy holds.
    /// False when this computer keeps none.
    pub fn account_stores_held(&self) -> bool {
        let Some(stores) = self.account_stores.get() else { return false };
        stores.step(self);
        stores.held()
    }

    /// The account's owner id: the scope its records are kept under.
    pub fn owner(&self) -> &str {
        &self.owner
    }

    /// Every live record of `resource` in this computer's own copy, by id (a value that is sealed here reads as it is
    /// kept). Read in pages of `feed_page_items`.
    pub fn records_of(&self, resource: &str) -> Result<std::collections::BTreeMap<String, serde_json::Value>, Error> {
        self.with_group_read(resource, |store| {
        let mut records = std::collections::BTreeMap::new();
        let mut after: Option<String> = None;
        loop {
            let (ids, next) = store.ids(&self.owner, &named(resource), after.as_deref(), settings().feed_page_items.max(1))?;
            let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
            for record in store.get_many(&self.owner, &named(resource), &asked)?.into_iter().flatten() {
                records.insert(record.id, record.value);
            }
            match next {
                Some(next) => after = Some(next),
                None => return Ok(records),
            }
        }
        })
    }

    /// Follow every store of the account kept in its state folder `state` at this computer (`Stores::path`): the lists,
    /// own work, the files store, the budget and computer grants, each in the file its placement row names, and the
    /// further stores of a volume. Without it every resource but the vault is kept in the records book.
    pub fn with_state(mut self, state: PathBuf) -> Self {
        self.records.state = Some(state);
        if self.records.opener.as_ref().is_some_and(|opener| !opener.supports_domains()) {
            self.group_inventory_supported.store(false,Ordering::Release);
            return self;
        }
        self.group_inventory_ready.store(false, Ordering::Release);
        if self.discover_groups().is_err() {
            self.group_inventory_supported.store(false, Ordering::Release);
            if self.records.opener.is_none() { self.group_inventory_ready.store(false, Ordering::Release); }
        }
        self
    }

    /// One bounded recovery page per turn; ordinary writes never enumerate.
    fn discover_groups(&self) -> Result<(), Error> {
        let Some(state) = &self.records.state else { return Ok(()); };
        let install = |scope: GroupIdentity| {
            self.group_position(&scope)?;
            let key = group_key(&scope, &scope.resource(&self.owner)?)?;
            self.refresh_group_materialized(&scope)?;
            locked(&self.resources).insert(key);
            Ok(())
        };
        let complete = match &self.records.opener {
            // Unlike supplies must provide their equivalent qualified inventory.
            Some(opener) => {
                let mut after = locked(&self.group_inventory_cursor);
                let limits = group_limits()?;
                let (histories,next) = opener.histories_page(state,&self.owner,after.as_deref(),limits.page_rows)?;
                if histories.len() > limits.page_rows || serde_json::to_vec(&histories).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.len() > limits.page_bytes
                    || next.as_ref().is_some_and(|next| Some(next) == after.as_ref()
                        || next.len() > store_settings::shipped().map_or(0,|s|s.identity_text_bytes)) { return Err(crate::cause!(Error::Unavailable)); }
                for scope in histories { install(scope)?; }
                let complete = next.is_none();
                *after = next;
                complete
            },
            None => {
                let mut inventory = locked(&self.group_inventory);
                if inventory.is_none() {
                    let resources = Arc::new(placements::StateResources::new(state,crate::sqlite_work::WorkMeter::new())?);
                    *inventory = Some(placements::domains::Inventory::copies(resources,self.owner.clone())?);
                }
                let (histories,complete) = inventory.as_mut().ok_or(crate::cause!(Error::Unavailable))?.page(
                    group_limits()?.page_rows, Arc::new(AtomicBool::new(false)),
                    Instant::now() + Duration::from_millis(settings().message_wait_ms))?;
                for scope in histories { install(scope)?; }
                if complete { *inventory = None; }
                complete
            }
        };
        self.group_inventory_ready.store(complete, Ordering::Release);
        self.group_inventory_supported.store(true, Ordering::Release);
        Ok(())
    }

    /// Physical handle only. The maintenance controller must separately prove
    /// original admission, full history, current canonical authority and term.
    /// Uses exactly the same logical path as ordinary native/Copies commands.
    pub(crate) fn open_domain_records(&self,scope:&GroupIdentity)->Result<RecordStore<ComputerStore>,Error> {
        if !self.group_inventory_supported.load(Ordering::Acquire) || self.records.state.is_none() {return Err(crate::cause!(Error::Unavailable));}
        let resource=scope.resource(&self.owner)?;
        self.records.open(&group_key(scope,&resource)?)
    }

    /// Select a complete existing replica for native destination preparation.
    /// This constructor grants no management right and accepts no caller proof.
    pub(crate) fn qualify_domain_replica<'a>(&'a self, storage: &'a dyn Storage, from: &str, term: u64, scope: &GroupIdentity)
        -> Result<QualifiedDomainReplica<'a>,Error> {
        let membership = self.placed().mark();
        let (through,base) = self.replica_baseline(storage,from,term,scope)?;
        let stream = group_stream(scope,&self.owner)?;
        live_adopt::command_access(storage,&stream).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if self.placed().mark() != membership { return Err(crate::cause!(Error::Unavailable)); }
        Ok(QualifiedDomainReplica {copies:self,storage,scope:scope.clone(),source:from.to_owned(),term,through,base,membership})
    }

    fn replica_baseline(&self, storage: &dyn Storage, from: &str, term: u64, scope: &GroupIdentity) -> Result<(i64,i64),Error> {
        let placed = self.placed();
        if !storage.scoped() || !storage.writing().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? || !placed.may_answer
            || !placed.may_answer_peers.iter().any(|peer|peer == from)
            || !self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|row|row.writer == from && row.term == term) {
            return Err(crate::cause!(Error::Unavailable));
        }
        let root = scope.resource(&self.owner)?;
        let path = self.records.path(&group_key(scope,&root)?);
        let limits = self.records.limits(&storage,&path)?;
        let store = RecordStore::new(storage,Box::new(RealClock),limits)?;
        if !group_header_matches(&store,&self.owner,scope)? { return Err(crate::cause!(Error::Conflict)); }
        let stream = group_stream(scope,&self.owner)?;
        let expected = group_binding(scope,&self.owner)?;
        let limits = group_limits()?;
        for slot in [scope.copy_namespace(&self.owner)?,stream.clone()] {
            if commit_log::stream_binding(storage,&slot,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.as_deref() != Some(expected.as_slice()) { return Err(crate::cause!(Error::Conflict)); }
        }
        let front = commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (accepted,base) = store.accepted(&self.owner,&root)?;
        if front.stored < 0 || front.materialized != front.stored || accepted != term || base < 0 || base > front.stored {
            return Err(crate::cause!(Error::Conflict));
        }
        Ok((front.stored,base))
    }

    pub(crate) fn with_domain_maintenance(mut self, handler: Arc<dyn DomainMaintenance>) -> Self {
        self.domain_maintenance = Some(handler);
        self
    }

    /// The entire original management context stays inside authenticated
    /// ciphertext, including its request identity and canonical move witnesses.
    pub(crate) fn maintenance_exchange(&self, target: &str, scope: &GroupIdentity, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        let placed = self.placed();
        let term = self.holding().ok_or(crate::cause!(Error::Unavailable))?;
        if !placed.may_answer || !placed.may_answer_peers.iter().any(|peer|peer == target)
            || !self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|row|row.writer == self.me && row.term == term) {
            return Err(crate::cause!(Error::Unavailable));
        }
        let nonce = self.transfers.fetch_add(1,Ordering::AcqRel).to_string();
        let frame = self.seal_maintenance(&self.me,target,scope,term,&nonce,false,plaintext)?;
        match self.send(target,&Message::Group {request:GroupRequest::Maintenance {scope:scope.clone(),term,nonce:nonce.clone(),frame}}) {
            Some(Answer::Group { answer:GroupAnswer::Maintenance {frame} }) => {
                self.open_maintenance(&self.me,target,scope,term,&nonce,true,&frame)
            }
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    /// Read-only controller query to the actual current writer after a
    /// handoff. The controller independently admits the original browser and
    /// permits only persisted activated status on this transport path.
    pub(crate) fn maintenance_query(&self,target:&str,scope:&GroupIdentity,plaintext:&[u8])->Result<Vec<u8>,Error> {
        let placed=self.placed();
        let row=self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
        if !placed.may_answer || !placed.may_answer_peers.iter().any(|peer|peer==target)
            || row.writer!=target || row.expires_at_ms<=(self.clock)() {return Err(crate::cause!(Error::Unavailable));}
        let nonce=self.transfers.fetch_add(1,Ordering::AcqRel).to_string();
        let frame=self.seal_maintenance(&self.me,target,scope,row.term,&nonce,false,plaintext)?;
        match self.send(target,&Message::Group {request:GroupRequest::Maintenance {scope:scope.clone(),term:row.term,nonce:nonce.clone(),frame}}) {
            Some(Answer::Group {answer:GroupAnswer::Maintenance {frame}})=>self.open_maintenance(&self.me,target,scope,row.term,&nonce,true,&frame),
            _=>Err(crate::cause!(Error::Unavailable)),
        }
    }

    fn seal_maintenance(&self, source: &str, target: &str, scope: &GroupIdentity, term: u64, nonce: &str, reply: bool, plaintext: &[u8]) -> Result<String,Error> {
        use base64::Engine;
        if plaintext.len() > settings().carried_bytes { return Err(crate::cause!(Error::Unavailable)); }
        let resource = group_key(scope,&scope.resource(&self.owner)?)?;
        let id = serde_json::to_string(&("domain-maintenance/v1",source,target,term,nonce,reply)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at = At {owner:&self.owner,resource:&resource,id:&id,version:0,from:0,part:Part::Value};
        let value = json!({"payload":base64::engine::general_purpose::STANDARD.encode(plaintext)});
        let sealed = sealed::seal_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let frame = serde_json::to_vec(&sealed).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if frame.len() > settings().carried_bytes { return Err(crate::cause!(Error::Unavailable)); }
        Ok(base64::engine::general_purpose::STANDARD.encode(frame))
    }

    fn open_maintenance(&self, source: &str, target: &str, scope: &GroupIdentity, term: u64, nonce: &str, reply: bool, frame: &str) -> Result<Vec<u8>,Error> {
        use base64::Engine;
        if frame.len() > settings().carried_bytes { return Err(crate::cause!(Error::Unavailable)); }
        let resource = group_key(scope,&scope.resource(&self.owner)?)?;
        let id = serde_json::to_string(&("domain-maintenance/v1",source,target,term,nonce,reply)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at = At {owner:&self.owner,resource:&resource,id:&id,version:0,from:0,part:Part::Value};
        let bytes = base64::engine::general_purpose::STANDARD.decode(frame).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let opened = sealed::open_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let payload = opened.get("payload").and_then(serde_json::Value::as_str).ok_or(crate::cause!(Error::Unavailable))?;
        let plain = base64::engine::general_purpose::STANDARD.decode(payload).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if plain.len() > settings().carried_bytes { return Err(crate::cause!(Error::Unavailable)); }
        Ok(plain)
    }

    fn answer_maintenance(&self, from: &str, scope: &GroupIdentity, term: u64, nonce: &str, frame: &str) -> Answer {
        let placed = self.placed();
        if !placed.may_answer || !placed.may_answer_peers.iter().any(|peer|peer == from)
            || nonce.len() > store_settings::shipped().map_or(0,|s|s.identity_text_bytes)
            || !self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row|row.term == term && (row.writer == from || row.writer==self.me && self.holding()==Some(term))) {
            return refused("domain_maintenance_not_authorized", crate::cause!());
        }
        let Some(handler) = &self.domain_maintenance else { return refused("domain_maintenance_unavailable", crate::cause!()); };
        let plain = match self.open_maintenance(from,&self.me,scope,term,nonce,false,frame) { Ok(value) => value, Err(error) => { return refused("domain_maintenance_not_opened", error.cause()); } };
        let reply = match handler.answer(from,term,scope,&plain) { Ok(value) => value, Err(error) => { return refused("domain_maintenance_refused", error.cause()); } };
        if !self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row|row.term==term && (row.writer==from || row.writer==self.me && self.holding()==Some(term))) { return refused("stale_writer", crate::cause!()); }
        match self.seal_maintenance(from,&self.me,scope,term,nonce,true,&reply) {
            Ok(frame) => Answer::Group {answer:GroupAnswer::Maintenance {frame}},
            Err(error) => refused("domain_maintenance_not_sealed", crate::refusal_cause::Caused::cause(&error)),
        }
    }

    /// Follow the account's vault too: its store file `file` (the `secrets` resource), whose records are held
    /// values sealed under the secrets key. Every computer that holds a copy gets them; only a computer that may answer
    /// gets the root that opens them (`with_secrets_key`).
    pub fn with_vault(mut self, file: PathBuf) -> Self {
        if let Ok(resource) = crate::secrets::resource() {
            self.resources.get_mut().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(resource.to_string());
        }
        self.records.vault = Some(file);
        self
    }

    /// This computer's key and the account's state folder at this computer, and the secrets key when this computer holds it.
    /// A computer that may answer and holds no root asks the writer for it; it arrives sealed to this computer's own key,
    /// and is kept sealed to it in `state` (`secrets::secrets_key::write_sealed`). A writer that holds the root sends it
    /// only to a computer the account's row lets answer.
    /// A computer that may answer and holds the root opens every record value it kept sealed (`open_held`).
    pub fn with_secrets_key(self, computer_key: Arc<ComputerKey>, state: PathBuf, root: Option<SecretsKey>) -> Self {
        // The older roots a re-key left, kept in the state folder sealed under the current root.
        let (root, older) = match root {
            Some(root) => match secrets_key::read_keyring(&state, root.duplicate()) {
                Ok(keyring) => (Some(root), keyring.older().iter().map(SecretsKey::duplicate).collect()),
                Err(_) => (Some(root), Vec::new()),
            },
            None => (None, Vec::new()),
        };
        let roots = secrets_keys_of(root.as_ref(), &older);
        *locked(&self.vault) = VaultKeys { computer_key: Some(computer_key), state: Some(state), root, older, roots };
        let _ = self.open_held();
        self
    }

    /// The account's public key (64 hex), so this computer can send the account's computers row to another computer with the
    /// key the receiver checks it against.
    pub fn with_account_key(self, public_hex: String) -> Self {
        *locked(&self.account_key) = Some(public_hex);
        self
    }

    /// This computer was just added to a running account and starts with nothing: it neither claims the writer turn nor votes
    /// for a takeover until its copy has caught up once (`joined`).
    pub fn joining(self) -> Self {
        self.joined.store(false, Ordering::Release);
        self.read_back.store(false, Ordering::Release);
        self
    }

    /// Whether this computer may take the account's calls now (the forwarder sends them elsewhere until it does, `computers::
    /// kept_accounts_bytes_catching_up`). The writer does. Any other computer does once it holds and may answer the
    /// account, holds the secrets key (when it was given a computer key), and its
    /// account rows matched the writer's once by count and identity per family (`read_back`, checked on each sign-in
    /// pull from the writer: `Log::census`). This is old trillion's switch after the read-back (src/resource-state-
    /// carry.mjs): a computer added to the account takes calls only after its copy, the account rows included, matches.
    /// Before, a computer took calls as soon as its session opened: with the root sent but none of the account rows it
    /// refused the account's own key (401), and without the root it answered 503, while the old computer was live.
    pub fn answers_now(&self) -> bool {
        if !self.group_inventory_ready.load(Ordering::Acquire) { return false; }
        let placed = self.placed();
        if !placed.keeps_copy || !placed.may_answer {
            return false;
        }
        if self.holding().is_some() {
            return true;
        }
        let keyed = locked(&self.vault).computer_key.is_some();
        (!keyed || self.holds_secrets_key()) && self.read_back.load(Ordering::Acquire)
    }

    /// Whether this computer's copy has caught up since it was added (always, for a computer that was not added).
    pub fn joined(&self) -> bool {
        self.joined.load(Ordering::Acquire) && self.group_inventory_ready.load(Ordering::Acquire)
    }

    /// Whether this computer's copy has not caught up with the writer yet, or still holds groups it has not materialized:
    /// its answers may then leave out records (`still_filling`).
    pub fn filling(&self) -> bool {
        !self.joined() || !locked(&self.unmaterialized_groups).is_empty()
    }

    /// This computer's copy caught up once since it was added: it may claim from now on (`joined_at`).
    fn mark_joined(&self) {
        self.joined_at.store((self.clock)(), Ordering::Release);
        self.joined.store(true, Ordering::Release);
        crate::quiet_eprintln!("computers-join event=joined account={} computer={}", self.address, self.me);
    }

    /// Whether the account's computers row no longer names this computer: it was removed, and does nothing more for the
    /// account.
    pub fn removed(&self) -> bool {
        !self.placed().keeps_copy
    }

    /// The account's computers row as this computer holds it now.
    pub fn row(&self) -> ComputersRow {
        self.placed().row.clone()
    }

    /// The copy holders a writer's vault prune waits for (`record_store::holders`): every computer on the account's row
    /// that keeps a copy or votes, except this one.
    pub fn holders(&self) -> Vec<String> {
        let row = self.row();
        let mut listed: Vec<String> = row.copy_keepers.iter().chain(row.voters.iter()).filter(|computer| computer.as_str() != self.id).cloned().collect();
        listed.sort();
        listed.dedup();
        listed
    }

    /// The writer's match index for a copy's caught-up report (`record_store::holders`): the stamp the copy pulled through
    /// is kept in the vault's own file, and the file's guard lists the holders, so the prune waits for them. Only the
    /// writer records it; a copy's report does nothing here.
    fn record_pull(&self, resource: &str, holder: &str, stamp: i64) {
        let Ok(vault) = crate::secrets::resource() else { return };
        if resource != vault || !self.is_writer() {
            return;
        }
        let Ok(store) = self.records.open(resource) else { return };
        if store.record_holder_pull(&self.owner, &named(resource), holder, stamp).is_err() {
            return;
        }
        if let Some(path) = self.records.vault.as_deref() {
            crate::storage::record_store::holders::set_guard(path, crate::storage::record_store::HolderGuard::Writer(self.holders()));
        }
    }

    /// The secrets key and the older roots a re-key left, when this computer holds the root: what opening a value sealed
    /// under any of them takes (a value names its root by `key_identity`).
    pub fn keyring(&self) -> Option<Keyring> {
        let vault = locked(&self.vault);
        let root = vault.root.as_ref()?;
        Keyring::new(root.duplicate(), vault.older.iter().map(SecretsKey::duplicate).collect()).ok()
    }

    fn placed(&self) -> Arc<Placed> {
        locked(&self.placed).clone()
    }

    /// Add an older secrets key to the roots this computer opens sealed record values with (it never seals under it).
    /// A sealed value names the root it was sealed under (`sealed::SecretsKeys`), so values sealed under a root that was
    /// replaced keep opening while that root is added here. Answers whether it was added.
    pub fn add_secrets_key(&self, root: &SecretsKey) -> bool {
        let added = {
            let mut vault = locked(&self.vault);
            let added = vault.roots.add(root).is_ok();
            // Kept in the keyring too, so it travels with the root to the other may-answer computers.
            let known = |held: &SecretsKey| secrets_key::key_identity(held).ok() == secrets_key::key_identity(root).ok();
            if added && !vault.older.iter().any(known) && !vault.root.as_ref().is_some_and(known) {
                vault.older.push(root.duplicate());
            }
            added
        };
        if added {
            let _ = self.open_held();
        }
        added
    }

    /// The roots this computer opens sealed record values with (empty when it holds none).
    /// Shadow only (changes nothing): the placement's policy answer for this computer against the root it holds, as a log line
    /// when they differ. `None` when they agree.
    pub fn shadow_mismatch(&self) -> Option<String> {
        let placed = self.placed();
        let policy = placed.policy_answers(&self.me);
        let holds = self.may_answer() && self.holds_secrets_key();
        (policy != holds).then(|| {
            let kinds = match &placed.kinds {
                Ok(_) => "read".to_owned(),
                Err(reason) => format!("unread: {reason}"),
            };
            format!("key-custody event=shadow-mismatch account={} computer={} policy_answers={policy} holds_root={holds} kinds={kinds}", self.address, self.me)
        })
    }

    /// The seal format this computer last chose for its peers (`roots`); the previous one before any choice.
    pub fn sealed_version(&self) -> u32 {
        locked(&self.seal_choice).as_ref().map_or_else(sealed::legacy_version, |choice| choice.version)
    }

    /// The roots this computer opens sealed record values with (empty when it holds none), sealing in the format its peers can
    /// open (`sealed::choose_write_version`). The choice is kept while the peers and the heard reports stay the same, so it is
    /// recomputed only when a report changes.
    fn roots(&self) -> SecretsKeys {
        let placed = self.placed();
        let revision = crate::account::computers::copy_rule::heard_revision();
        let choice = {
            let mut kept = locked(&self.seal_choice);
            match kept.as_ref() {
                Some(choice) if choice.revision == revision && choice.peers == placed.peers => choice.clone(),
                _ => {
                    // Every other computer that holds the account, copy-only ones included: they receive sealed values too.
                    let peers: Vec<(String, Option<Vec<u32>>)> = placed.peers.iter()
                        .map(|peer| (peer.clone(), crate::account::computers::copy_rule::heard_sealed_versions(peer))).collect();
                    let previous = kept.as_ref().and_then(|choice| choice.held_back.clone());
                    let (version, refused) = sealed::choose_write_version(&peers);
                    // A peer that stays held back is named once, not on every report that moves the revision.
                    let held_back = refused.map(|(computer, refused)| {
                        if previous.as_deref() != Some(computer.as_str()) {
                            crate::quiet_eprintln!("sealed-writer event=peer-cannot-open account={} computer={computer} cause={refused:?}", self.address);
                        }
                        computer
                    });
                    let choice = SealChoice { revision, peers: placed.peers.clone(), version, held_back };
                    *kept = Some(choice.clone());
                    choice
                }
            }
        };
        locked(&self.vault).roots.clone().with_write_version(choice.version)
    }

    /// At a computer that may answer and holds a root: open every record value and kept request answer it keeps sealed (it held only a
    /// copy before, or took pages from such a computer), in each resource it follows, and build what a write builds from
    /// them (`RecordStore::open_sealed`). A computer that only holds a copy keeps them sealed. Answers how many rows were opened.
    pub fn open_held(&self) -> Result<usize, Error> {
        let roots = self.roots();
        if !self.placed().may_answer || roots.is_empty() {
            return Ok(0);
        }
        let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
        let mut opened = 0;
        let mut failed = None;
        // One resource that does not open (or whose store is not there yet) never stops the others.
        for resource in resources {
            if let Some(address) = group_address(&resource) {
                match self.materialize_group_page(&address.history) {
                    Ok(count) => opened += count,
                    Err(error) => failed = failed.or(Some(error)),
                }
                continue;
            }
            let step = self.records.open(&resource).and_then(|mut store| {
                if !store.holds_sealed(&self.owner, &named(&resource))? {
                    return Ok(0);
                }
                store.open_sealed(&self.owner, &named(&resource), &OpenWith { roots: &roots, owner: &self.owner, resource: &resource })
            });
            match step {
                Ok(count) => opened += count,
                Err(error) => failed = failed.or(Some(error)),
            }
        }
        match failed {
            Some(error) if opened == 0 => Err(error),
            _ => Ok(opened),
        }
    }

    /// The changes of `resource` as they go to computer `peer`: as they are to a computer that may answer; to a computer that
    /// only holds a copy, every plain value, version in between and kept request answers sealed under the current root (a part
    /// already sealed goes as it is). `None` when a plain part must be sealed and this computer holds no root: nothing
    /// plain ever goes to such a computer.
    fn for_peer(&self, peer: &str, resource: &str, mut changes: Vec<Carried>) -> Option<Vec<Carried>> {
        for carried in &mut changes {
            carried.sealed = false;
        }
        if self.placed().may_answer_peers.iter().any(|computer| computer == peer) {
            return Some(changes);
        }
        let roots = self.roots();
        for carried in &mut changes {
            let id = carried.change.id.clone();
            let at = |version: i64, from: i64, part: Part| At { owner: &self.owner, resource, id: &id, version, from, part };
            let (version, from) = (carried.change.version, carried.change.sequence);
            if let Some(value) = carried.change.value.as_ref().filter(|value| !sealed::is_sealed(value)) {
                carried.change.value = Some(sealed::seal_value(&roots, &at(version, from, Part::Value), value).ok()?);
            }
            if let Some(text) = carried.receipts.as_ref().filter(|text| !sealed::is_sealed_text(text)) {
                carried.receipts = Some(sealed::seal_text(&roots, &at(version, from, Part::Receipts), text).ok()?);
            }
            for past in &mut carried.history {
                if let Some(value) = past.value.as_ref().filter(|value| !sealed::is_sealed(value)) {
                    past.value = Some(sealed::seal_value(&roots, &at(past.version, past.from, Part::Value), value).ok()?);
                }
            }
        }
        Some(changes)
    }

    /// The versions in between of record `id` of `resource` as they go to computer `peer` (`for_peer`, for a history page):
    /// to a computer that only holds a copy, each sealed under its own version and stamp. `None` with no root to seal under.
    fn pasts_for_peer(&self, peer: &str, resource: &str, id: &str, mut pasts: Vec<Past>) -> Option<Vec<Past>> {
        if self.placed().may_answer_peers.iter().any(|computer| computer == peer) {
            return Some(pasts);
        }
        let roots = self.roots();
        for past in &mut pasts {
            if let Some(value) = past.value.as_ref().filter(|value| !sealed::is_sealed(value)) {
                let at = At { owner: &self.owner, resource, id, version: past.version, from: past.from, part: Part::Value };
                past.value = Some(sealed::seal_value(&roots, &at, value).ok()?);
            }
        }
        Some(pasts)
    }

    /// The versions in between of record `id` another computer sent, as this computer keeps them (`take_in`, for a history
    /// page). Answers whether this computer keeps them sealed.
    fn take_in_pasts(&self, resource: &str, id: &str, pasts: &mut [Past]) -> Result<bool, CodedError<&'static str>> {
        let roots = self.roots();
        let open = self.placed().may_answer && !roots.is_empty();
        let any_sealed = pasts.iter().filter_map(|past| past.value.as_ref()).any(sealed::is_sealed);
        if open {
            for past in pasts.iter_mut() {
                if let Some(value) = past.value.as_ref().filter(|value| sealed::is_sealed(value)) {
                    let at = At { owner: &self.owner, resource, id, version: past.version, from: past.from, part: Part::Value };
                    past.value = Some(sealed::open_value(&roots, &at, value).map_err(|error| CodedError::with_cause("sealed_value_refused", error.cause()))?);
                }
            }
            Ok(false)
        } else if !self.placed().may_answer {
            if !pasts.iter().filter_map(|past| past.value.as_ref()).all(sealed::is_sealed) {
                return Err(CodedError::new("plain_value_refused"));
            }
            Ok(true)
        } else {
            Ok(any_sealed)
        }
    }

    /// The changes of `resource` another computer sent, as this computer keeps them. A computer that may answer and holds a root
    /// opens every sealed part (one that does not open refuses the page). A computer that only holds a copy takes only
    /// sealed values and kept request answers (a plain one refuses the page) and keeps them sealed (`Carried::sealed`). A computer that
    /// may answer and holds no root yet keeps sealed what came sealed, and opens it when the root arrives.
    fn take_in(&self, resource: &str, changes: &[Carried]) -> Result<Vec<Carried>, CodedError<&'static str>> {
        let roots = self.roots();
        let open = self.placed().may_answer && !roots.is_empty();
        let mut kept = Vec::with_capacity(changes.len());
        for carried in changes {
            let mut carried = carried.clone();
            let id = carried.change.id.clone();
            let at = |version: i64, from: i64, part: Part| At { owner: &self.owner, resource, id: &id, version, from, part };
            let (version, from) = (carried.change.version, carried.change.sequence);
            let values = carried.change.value.iter().chain(carried.history.iter().filter_map(|past| past.value.as_ref()));
            let any_sealed = values.clone().any(sealed::is_sealed) || carried.receipts.as_deref().is_some_and(sealed::is_sealed_text);
            let all_sealed = values.clone().all(sealed::is_sealed) && carried.receipts.as_deref().is_none_or(sealed::is_sealed_text);
            if open {
                let refused = |error: sealed::Refused| CodedError::with_cause("sealed_value_refused", error.cause());
                if let Some(value) = carried.change.value.as_ref().filter(|value| sealed::is_sealed(value)) {
                    carried.change.value = Some(sealed::open_value(&roots, &at(version, from, Part::Value), value).map_err(refused)?);
                }
                if let Some(text) = carried.receipts.as_ref().filter(|text| sealed::is_sealed_text(text)) {
                    carried.receipts = Some(sealed::open_text(&roots, &at(version, from, Part::Receipts), text).map_err(refused)?);
                }
                for past in &mut carried.history {
                    if let Some(value) = past.value.as_ref().filter(|value| sealed::is_sealed(value)) {
                        past.value = Some(sealed::open_value(&roots, &at(past.version, past.from, Part::Value), value).map_err(refused)?);
                    }
                }
                carried.sealed = false;
            } else if !self.placed().may_answer {
                if !all_sealed {
                    return Err(CodedError::new("plain_value_refused"));
                }
                carried.sealed = true;
            } else {
                carried.sealed = any_sealed || carried.erased;
            }
            kept.push(carried);
        }
        Ok(kept)
    }

    /// Whether this computer holds the secrets key.
    pub fn holds_secrets_key(&self) -> bool {
        locked(&self.vault).root.is_some()
    }

    /// Whether the account's row lets this computer answer.
    pub fn may_answer(&self) -> bool {
        self.placed().may_answer
    }

    /// Whether this computer may admit a sign-in from its own copy of the account rows now: it may answer, and it holds the
    /// writer turn or caught up with the writer within `admit_ms` (and within the writer's own term).
    pub fn may_admit(&self) -> bool {
        if !self.group_inventory_ready.load(Ordering::Acquire) { return false; }
        let placed = self.placed();
        placed.keeps_copy && placed.may_answer && (self.holding().is_some() || (self.clock)() < self.fresh_until.load(Ordering::Acquire))
    }

    /// Whether this copy heard the writer's sign-in feed within `revocation_settle_ms` (its own clock), or holds the writer
    /// turn itself. A copy that cannot show this refuses: a revocation it never heard may still be in force elsewhere.
    fn heard_within_settle(&self) -> bool {
        if self.holding().is_some() { return true; }
        let heard = self.heard_at.load(Ordering::Acquire);
        heard != i64::MIN && (self.clock)().saturating_sub(heard) <= settings().revocation_settle_ms
    }

    /// The account's address.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// This computer's id.
    pub fn computer(&self) -> &str {
        &self.me
    }

    /// The term number this computer writes under now, if it holds the writer turn.
    pub fn holding(&self) -> Option<u64> {
        locked(&self.writer_role).holding((self.clock)())
    }

    /// Whether this computer may write for the account now: it holds a live term and is in the account's current voter set, the
    /// same view a claim is judged by (`claim_for_write`). A term alone is not enough once the voters have removed this computer.
    pub(crate) fn writes_here(&self) -> bool {
        self.holding().is_some() && self.placed().voters.contains(&self.me)
    }

    /// The term number this computer writes under now and when it stops writing under it, if it holds the writer turn (what a
    /// renewal announces to the forwarder, `computer.rs` `announce_term`).
    pub fn holding_until(&self) -> Option<(u64, i64)> {
        let now = (self.clock)();
        let writer_role = locked(&self.writer_role);
        Some((writer_role.holding(now)?, writer_role.valid_until(now)?))
    }

    /// The writer row as this computer's copy holds it.
    pub fn writer_row(&self) -> Option<(String, u64, i64)> {
        self.writer_rows.read(&self.id).ok().flatten().map(|row| (row.writer, row.term, row.expires_at_ms))
    }

    /// One record of this computer's own copy.
    pub fn read(&self, resource: &str, id: &str) -> Result<Read, Error> {
        self.with_group_read(resource, |store| store.get(&self.owner, &named(resource), id))
    }

    /// The record `id` of `resource` as it was at stamp `at`, in this computer's own copy.
    pub fn read_as_of(&self, resource: &str, id: &str, at: i64) -> Result<Read, Error> {
        self.with_group_read(resource, |store| store.as_of(&self.owner, &named(resource), id, at))
    }

    /// The caught-up stamp of `resource` in this computer's own copy.
    pub fn stamp(&self, resource: &str) -> i64 { self.held(resource).1 }

    /// How far this computer's copy holds, per resource it follows: the newest writer term it took changes from and its
    /// caught-up stamp; and, at a computer that may answer, the same of its account rows (the entry named `copied_row`).
    pub fn stamps(&self) -> Vec<(String, u64, i64)> {
        let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
        let mut stamps: Vec<(String, u64, i64)> = resources.into_iter().map(|resource| {
            let (term, stamp) = self.held(&resource);
            (resource, term, stamp)
        }).collect();
        let placed = self.placed();
        if placed.may_answer || placed.voters.contains(&self.me) {
            // At a voter that may not answer: the mark of the newest sign-in change it was told is made.
            let counter = { let _one = locked(&self.sign_in); self.log().counter().unwrap_or_default() };
            stamps.push((settings().copied_row.clone(), counter.term, i64::try_from(counter.stamp).unwrap_or(i64::MAX)));
        }
        // The computers row: its revision and the term it was made under, in the same two entries. A voter refuses a
        // takeover from a computer that holds an older row, as from one that holds older records.
        let (revision, term) = self.placed().mark();
        stamps.push((self.row_entry(), revision, i64::try_from(term).unwrap_or(i64::MAX)));
        stamps
    }

    /// Give the writer turn up at once (this computer stops writing).
    pub fn give_up(&self) {
        let mut writer_role = locked(&self.writer_role);
        writer_role.give_up();
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        drop(writer_role);
        self.expire_group_sessions(true);
    }

    /// Hand the writer turn at `term` over (`Message::Release`): no write of this computer is between its push and its commit
    /// (the write and sign-in locks are taken first), the writer turn is given up, and every voter, this computer among them, ends
    /// that term in its writer row now. A voter that does not hear it ends it when the term runs out, as before.
    fn hand_over(&self, term: u64, now: i64) {
        {
            let _write = locked(&self.writing);
            let _sign_in = locked(&self.sign_in);
            self.give_up();
        }
        crate::quiet_eprintln!("computers-writer event=hand-over account={} computer={} term={term}", self.address, self.me);
        for voter in self.placed().voters.clone() {
            if voter == self.me {
                self.release_row(&self.me.clone(), term, now);
            } else {
                let _ = self.send(&voter, &Message::Release { term });
            }
        }
    }

    /// Hand the writer turn over now when this computer holds it (`hand_over`): a computer about to stop (a trillion-local
    /// release, src/native_entry/computer/releases.rs) ends its term at every voter at once, so another computer that may
    /// answer claims it on its next step instead of after the term runs out. Answers the term handed over, if any.
    pub fn hand_over_held(&self) -> Option<u64> {
        let term = self.holding()?;
        self.hand_over(term, (self.clock)());
        Some(term)
    }

    /// Invite the selected eligible copy to claim through the unchanged
    /// quorum writer owner after this writer actually releases. The invite
    /// grants no vote and never counts as routing or a successful handover.
    pub(crate) fn hand_over_domain_to(&self,scope:&GroupIdentity,target:&str)->Result<bool,Error> {
        let placed=self.placed();
        if !placed.may_answer || !placed.may_answer_peers.iter().any(|peer|peer==target) {return Err(crate::cause!(Error::Unavailable));}
        let row=self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
        if row.writer==target && row.expires_at_ms>(self.clock)() {return Ok(true);}
        let term=match self.holding() {
            Some(term) if row.writer==self.me && row.term==term=>{self.hand_over(term,(self.clock)());term},
            None if row.writer==self.me && row.expires_at_ms.saturating_add(settings().clock_margin_ms)<(self.clock)()=>row.term,
            _=>return Ok(false),
        };
        let answer=self.send(target,&Message::Group {request:GroupRequest::TakeWriter {scope:scope.clone(),released_term:term}});
        let Some(Answer::Group {answer:GroupAnswer::Writer {term:new_term}})=answer else{return Ok(false);};
        Ok(new_term>term && self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|row|
            row.writer==target&&row.term==new_term&&row.expires_at_ms>(self.clock)()))
    }

    /// End the term `term` of `from` in this computer's writer row now, when the row names `from` at that term (one
    /// compare-and-set). Answers whether it did.
    fn release_row(&self, from: &str, term: u64, now: i64) -> bool {
        let Ok(Some(row)) = self.writer_rows.read(&self.id) else { return false };
        let ended = now - settings().clock_margin_ms - 1;
        if row.writer != from || row.term != term || row.expires_at_ms <= ended {
            return false;
        }
        let after = WriterRow { expires_at_ms: ended, ..row.clone() };
        self.writer_rows.replace(&self.id, Some(&row), &after).unwrap_or(false)
    }

    /// A row this computer took no longer names the writer its writer row holds as a voter (the account moved off that
    /// computer): end that term here now, as its `Message::Release` would, so a computer the row names claims at once
    /// instead of after the term and the clock margin. Measured on two full computers (tests/computer_forwarder.rs
    /// `an_account_moves_from_a_to_b_on_two_full_computers_with_every_probe_read_answered`): the removed writer gave its
    /// turn up without a release (its renewal was refused by the new voters, and once removed it steps no more), and B
    /// refused the account's key for about 6 s until the term ran out. Safe: the row change was acknowledged by a majority
    /// of the new voters, which refuse the removed computer, so no write or renewal of that term can be acknowledged any more.
    fn end_term_of_removed_writer(&self, voters: &[String]) {
        let Ok(Some(row)) = self.writer_rows.read(&self.id) else { return };
        if row.term == 0 || row.writer == self.me || voters.contains(&row.writer) {
            return;
        }
        if self.release_row(&row.writer, row.term, (self.clock)()) {
            crate::quiet_eprintln!("computers-voter event=removed-writer-term-ended account={} computer={} writer={} term={}",
                self.address, self.me, row.writer, row.term);
            self.step_now.store(true, Ordering::Release);
        }
    }

    /// Run a renewal or a claim on a copy of the writer turn, with no lock held while its messages are out, and put the
    /// result back unless the writer turn was given up meanwhile (then the result is kept given up).
    fn writer_role_step<R>(&self, step: impl FnOnce(&mut WriterRole) -> R) -> R {
        use std::sync::atomic::Ordering;
        let epoch = self.epoch.load(Ordering::Acquire);
        let mut working = locked(&self.writer_role).clone();
        let result = step(&mut working);
        let mut writer_role = locked(&self.writer_role);
        if self.epoch.load(Ordering::Acquire) != epoch {
            working.give_up();
        }
        // Membership alone does not end a live term: a valid one-voter change preserves quorum intersection and is
        // settled and jointly acknowledged (`computers_acknowledge`). Giving up on every adoption would discard a safe
        // concurrent renewal. A later term cannot overlap this lease; a claim also compare-and-sets its durable writer
        // row after voting (`WriterRole::win`), refusing a newer row received while its replies were out. Actual releases
        // still invalidate this result through epoch above. Keep the newest voters so every later acknowledgement uses them.
        let voters = writer_role.voters().to_vec();
        working.set_voters(&voters);
        *writer_role = working;
        result
    }

    /// A request (a write or a read) reached the account at this computer now: it is active for `idle_release_ms` more.
    pub fn touch(&self) {
        self.last_used.fetch_max((self.clock)(), Ordering::AcqRel);
    }

    /// Whether no request reached the account at this computer within `idle_release_ms` (less the clock margin, so the
    /// last term has run out at every voter by then).
    pub fn idle(&self) -> bool {
        let last = self.last_used.load(Ordering::Acquire);
        last == i64::MIN || (self.clock)().saturating_sub(last) > settings().idle_release_ms - settings().clock_margin_ms
    }

    /// The step the computer's timer runs for an active account: `tick` while a request came within `idle_release_ms`.
    /// Once none did, the writer turn is given up (its term runs out at the voters, and nothing renews it) and no step runs:
    /// an account nobody uses costs no renewal, no pull and no timer. Answers whether the account is still active (the
    /// timer forgets it when not, until the next request wakes it, `wake`).
    pub fn step_if_active(&self) -> bool {
        if self.has_pending() { self.touch(); }
        if self.idle() {
            if self.holding().is_some() {
                self.give_up();
                crate::quiet_eprintln!("computers-writer role event=released-idle account={}", self.address);
            }
            return false;
        }
        // The computer that keeps a copy renews only while the renewed term ends within `idle_release_ms` of the last request, so once the
        // account goes idle its term has already run out at every voter (plus the clock margin), and the next write,
        // at any computer that may claim, takes the writer turn at once.
        let last = self.last_used.load(Ordering::Acquire);
        let ends = (self.clock)().saturating_add(settings().term_ms);
        if self.holding().is_some() && ends > last.saturating_add(settings().idle_release_ms) {
            return true;
        }
        self.tick();
        true
    }

    /// A request reached the account at this computer: it is active (`touch`), and when this computer may not admit from its
    /// copy now (the account was idle, so nobody kept it fresh), it catches up so the request can be answered: from the
    /// live writer it knows, or, with none, on the voters' word (`vouch`). The writer turn itself is taken by the first write
    /// (`write`), not here.
    pub fn wake(&self) {
        self.touch();
        if self.removed() || self.holding().is_some() || (self.may_admit() && self.heard_within_settle()) {
            return;
        }
        let now = (self.clock)();
        match self.writer_rows.read(&self.id).ok().flatten() {
            Some(row) if row.writer != self.me && now <= row.expires_at_ms + settings().clock_margin_ms => {
                self.follow(&row.writer);
            }
            _ => {
                self.vouch();
            }
        }
    }

    /// Whether a claim may run now: no lost claim holds it back (`hold_claims`).
    fn claim_allowed(&self, now: i64) -> bool {
        now >= self.claim_held_until.load(Ordering::Acquire)
    }

    /// After a lost claim, hold the next one back for `claim_backoff_ms` plus a random jitter of up to `claim_backoff_jitter_ms`,
    /// so computers that lost together do not claim again together.
    fn hold_claims(&self, now: i64) {
        let settings = settings();
        let wait = i64::try_from(settings.claim_backoff_ms.saturating_add(random_below(settings.claim_backoff_jitter_ms)))
            .unwrap_or(i64::MAX);
        self.claim_held_until.store(now.saturating_add(wait), Ordering::Release);
    }

    /// The first write of an account nobody holds the writer turn of: claim it now, as `tick` would once this computer's turn
    /// came, when no term is live in this computer's writer row and this computer may claim (it may answer, votes and has
    /// caught up). A claim the voters refuse leaves the write refused (`NotWriter`), as before.
    fn claim_for_write(&self) {
        self.touch();
        if let Some(on_write) = self.on_write.get() {
            on_write();
        }
        let now = (self.clock)();
        let placed = self.placed();
        if self.removed() || !self.joined() || !placed.may_answer || !placed.voters.contains(&self.me) || !self.no_live_term(now) {
            crate::quiet_eprintln!("computers-writer event=write-claim-skipped account={} computer={} joined={} inventory_ready={} may_answer={} voter={}",
                self.address, self.me, self.joined(), self.group_inventory_ready.load(Ordering::Acquire), placed.may_answer, placed.voters.contains(&self.me));
            return;
        }
        // Only when this computer's turn has come (`claim_due`), as the timer claims: after a writer died, calls reach
        // every computer that may answer, and two claiming on a write at once split the votes, so neither won and the
        // takeover waited a whole turn more (measured 2026-11-04 at full computers: writes back 21.7 s after the kill
        // instead of 10.6 s). An idle account's row ran out long ago, so every turn has come and the first write claims.
        if self.claim_due().is_some_and(|due| now <= due) {
            return;
        }
        // A claim is asked of the timer (`tick`), never run here: a request must not wait on the writer's peers, and requests
        // share the listener's workers. The write is refused for now (`NotWriter`), as a write is while no term is held.
        self.claim_wanted.store(true, Ordering::Release);
    }

    /// Set what a write at this copy asks for first: the computer's timer takes the account into its steps (`Computer::wake`), so
    /// the writer turn the write asks for is claimed as a request's is, not left to an account the timer does not step.
    pub fn set_on_write(&self, on_write: Box<dyn Fn() + Send + Sync>) {
        let _ = self.on_write.set(on_write);
    }

    /// Waits, at most `claim_wait_ms`, for the timer to take the writer turn that a write asked for (`claim_for_write`): the
    /// write goes through once the turn is held. A write that asked for no claim is refused `NotWriter` at once. When the
    /// claim is still pending at the end of the wait, nothing was written and the write answers `NotStarted`, so the caller
    /// retries it by its request key.
    fn await_claim(&self) -> Result<(), WriteRefused> {
        if self.holding().is_some() {
            return Ok(());
        }
        if !self.claim_wanted.load(Ordering::Acquire) {
            return Err(crate::cause!(WriteRefused::NotWriter));
        }
        let deadline = Instant::now() + Duration::from_millis(settings().claim_wait_ms);
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(settings().claim_poll_ms));
            if self.holding().is_some() {
                return Ok(());
            }
        }
        Err(crate::cause!(WriteRefused::NotStarted))
    }

    /// Admission takes the writer turn without a voter round trip: a held term admits the command. The commit fence
    /// (`before_commit_checked`) renews an aging term and refuses the effect when it cannot, so no write becomes visible
    /// without the term and the second copy's acknowledgement.
    pub(crate) fn prepare_write_turn(&self) -> Result<(), WriteRefused> {
        self.touch();
        if self.holding().is_none() {
            self.claim_for_write();
            self.await_claim()?;
        }
        self.holding().map(|_| ()).ok_or(crate::cause!(WriteRefused::NotWriter))
    }

    /// The renewal timer's step, run every `renew_every_ms`: the computer that keeps a copy renews (a failed renewal stops its writes at
    /// once); every other copy keeper pulls the writer's feed; when no live writer is known, a caught-up computer claims, each voter a
    /// little after the one before it (its rank among the voters times `renew_every_ms`), so two do not split votes.
    pub fn tick(&self) {
        self.expire_group_sessions(false);
        let now = (self.clock)();
        if self.claim_wanted.load(Ordering::Acquire) && self.claim_allowed(now) && self.holding().is_none() {
            self.claim_wanted.store(false, Ordering::Release);
            self.claim(now);
        }
        if !self.group_inventory_ready.load(Ordering::Acquire) && self.discover_groups().is_err() { return; }
        self.tick_records();
        // A computer that holds no writer turn hands the sign-in changes it made outside its copies to the writer it knows, so
        // a key made here reaches the writer and every copy (the writer's own changes travel from `tick_records`).
        if self.holding().is_none() && self.placed().may_answer {
            let _ = self.hand_outside_changes();
        }
        self.account_stores_step();
        if !self.carried_own.swap(true, Ordering::AcqRel) && !self.carry_own_files().1 {
            // A refused pass is still work to do; only a complete pass stays done. Each resource's carry below
            // either commits whole or rolls back, so the next timer step can safely ask again.
            self.carried_own.store(false, Ordering::Release);
        }
        self.take_settled();
    }

    fn tick_records(&self) {
        self.step_now.store(false, Ordering::Release);
        self.last_step.store((self.clock)(), Ordering::Release);
        if self.removed() {
            return;
        }
        // Catch-up before claiming still qualifies a new writer. A held writer renews first: domain maintenance
        // can wait on a physical source and must not consume the remainder of the current voting term first.
        if self.holding().is_none() { let _ = self.open_held(); }
        let now = (self.clock)();
        let writes_under = self.holding().unwrap_or(0);
        let wrote_under = self.wrote_under.swap(writes_under, Ordering::AcqRel);
        if wrote_under != 0 && writes_under != wrote_under {
            crate::quiet_eprintln!("computers-writer event=lost cause={}", crate::cause!(writer holding_term_changed));
        }
        if let Some(term) = self.holding().filter(|_| !self.placed().may_answer) {
            // The owner's row no longer lets this computer answer (the account moves to another computer): it stops writing
            // and hands the writer turn over, so a computer that may answer takes it at once.
            self.hand_over(term, now);
            return;
        }
        if self.holding().is_some() {
            // Sign-in rows made at this computer outside its copies (the sign-in command line runs as another process)
            // travel as an acknowledged sign-in change (`copy_outside_changes`), not only as log rows another copy keeper pulls
            // when it next steps: a copy keeper that takes no requests does not step, so a key the command line issued at
            // the writer was refused at the next computer once the writer died (#63).
            let started = Instant::now();
            let renewed = self.writer_role_step(|writer_role| writer_role.renew(now, &self.writer_rows, &VoteWire { copies: self }));
            let took = started.elapsed().as_millis();
            if renewed != Ok(true) || took > u128::from(settings().message_wait_ms) {
                let cause = match &renewed {
                    Err(error) => error.cause(),
                    Ok(false) => crate::cause!(writer renewal_not_won),
                    Ok(true) => crate::cause!(writer renewal_wait_exceeded),
                };
                crate::quiet_eprintln!("computers-writer event=renewal cause={cause}");
            }
            self.wrote_under.store(self.holding().unwrap_or(0), Ordering::Release);
            if self.holding().is_some() { let _ = self.open_held(); }
            if self.reseal_due.load(Ordering::Acquire) && self.holding().is_some() {
                self.reseal();
            }
            // After the renewal, never before it: an acknowledgement may wait for a computer that may answer and does
            // not, and the renewal must not wait behind it.
            if self.holding().is_some() && self.placed().may_answer {
                let _ = self.copy_outside_changes();
            }
            return;
        }
        if !self.joined() {
            self.take_root_from_peers();
            crate::quiet_eprintln!("computers-writer event=not-joined account={} computer={} inventory_ready={}", self.address, self.me, self.group_inventory_ready.load(Ordering::Acquire));
            // Added to a running account: catch up first, from the writer when one is known, else from any computer
            // that holds more. It claims nothing until then.
            match self.writer_rows.read(&self.id).ok().flatten() {
                Some(row) if row.writer != self.me && now <= row.expires_at_ms + settings().clock_margin_ms => {
                    self.follow(&row.writer);
                }
                _ => self.join_from_peers(),
            }
            return;
        }
        let row = self.writer_rows.read(&self.id).ok().flatten();
        let margin = settings().clock_margin_ms;
        // A computer that only holds a copy never takes the writer turn, and neither does one that does not vote (a computer that keeps a copy the
        // owner names a voter only once it has caught up): each keeps following the last writer it knows.
        let never_claims = !self.placed().may_answer || !self.placed().voters.contains(&self.me);
        match &row {
            Some(row) if row.writer != self.me && now <= row.expires_at_ms + margin => {
                self.follow(&row.writer);
            }
            Some(row) if never_claims && row.writer != self.me && self.follow(&row.writer) => {}
            // A computer that never claims and knows no live writer (one that does not vote learns the writer from its
            // pages, and the writer pushes only to voters): it looks for the writer among the voters, and meanwhile
            // catches up from the computers that hold more.
            _ if never_claims => self.find_writer(now),
            _ => {
                // No live writer known: admit on the voters' word meanwhile (`vouch`), and claim when this computer's turn
                // comes (`claim_due`).
                self.vouch();
                if self.claim_due().is_some_and(|due| now > due) && self.claim_allowed(now) {
                    self.claim(now);
                }
            }
        }
    }

    /// A computer that never claims (it only holds a copy, or it does not vote) and knows no live writer: ask each voter
    /// for the writer's feed (only the writer answers it, `not_writer` from any other). The one that answers every
    /// resource is the writer: this computer keeps it as the writer it follows (as it learns one from a writer's page,
    /// `take_writer_page`), and its pulls report this computer's caught-up stamps to it, which is what the writer reads
    /// before it lets the owner name this computer a voter (`caught_up`). With none may-answer, catch up from the computers
    /// that hold more.
    fn find_writer(&self, now: i64) {
        let placed = self.placed();
        for peer in placed.voters.iter().filter(|peer| **peer != self.me && placed.peers.contains(peer)) {
            if self.follow(peer) {
                let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
                let term = resources.iter()
                    .filter_map(|resource| self.records.open(resource).ok()?.accepted_term(&self.owner, &named(resource)).ok())
                    .max().unwrap_or(0);
                let before = self.writer_rows.read(&self.id).ok().flatten();
                if term > 0 && before.as_ref().is_none_or(|row| row.term <= term) {
                    let learned = WriterRow { writer: peer.clone(), term, expires_at_ms: now + settings().term_ms };
                    let _ = self.writer_rows.replace(&self.id, before.as_ref(), &learned);
                }
                return;
            }
        }
        self.join_from_peers();
    }

    /// The refusal of a writer's pull (`Message::Pull` or `Message::History` with `writer`) at a computer that does not hold the
    /// writer turn. It names the writer its own writer row holds, while that row is live and names another computer, so the
    /// puller follows that writer rather than asking this computer again.
    fn refused_not_writer(&self, from: &str, now: i64) -> Answer {
        let writer = self.writer_rows.read(&self.id).ok().flatten()
            .filter(|row| row.writer != self.me && now <= row.expires_at_ms + settings().clock_margin_ms)
            .map(|row| super::messages::RefusedWriter { computer: row.writer, term: row.term });
        let cause = crate::cause!(peer refusal);
        crate::quiet_eprintln!("computer-refusal code=not_writer from={from} account={} cause={cause}", self.address);
        Answer::Refused { code: "not_writer".to_string(), cause, writer }
    }

    /// A writer's pull that `from` refused as `not_writer`, with the writer `from` named, if any. The writer named is followed
    /// from now on, unless its term is older than this copy's row. Otherwise, or when none is named, `from` is not asked again
    /// for one renewal, and a row that still names `from` is cleared, so the next step asks the voters instead of `from`.
    fn heed_not_writer(&self, from: &str, writer: Option<&super::messages::RefusedWriter>, now: i64) {
        locked(&self.refused_until).insert(from.to_string(), now + settings().renew_every_ms);
        let before = self.writer_rows.read(&self.id).ok().flatten();
        let placed = self.placed();
        match followable_writer(writer, from, &self.me, &placed.voters, before.as_ref()) {
            Some(named) => {
                if before.as_ref().is_none_or(|row| row.term <= named.term) {
                    let learned = WriterRow { writer: named.computer.clone(), term: named.term, expires_at_ms: now + settings().term_ms };
                    let _ = self.writer_rows.replace(&self.id, before.as_ref(), &learned);
                }
            }
            None => {
                if let Some(row) = before.as_ref().filter(|row| row.writer == from) {
                    let cleared = WriterRow { expires_at_ms: 0, ..row.clone() };
                    let _ = self.writer_rows.replace(&self.id, Some(row), &cleared);
                }
            }
        }
    }

    /// Pull the writer's feed of every followed resource into this copy, and so report its caught-up stamp. Answers
    /// whether every pull was answered (only the writer answers them).
    fn follow(&self, writer: &str) -> bool {
        // A computer that refused this computer's writer pull is not asked again until its backoff ends.
        if locked(&self.refused_until).get(writer).is_some_and(|until| (self.clock)() < *until) {
            crate::quiet_eprintln!("computers-writer event=follow-backoff account={} computer={} writer={writer}", self.address, self.me);
            return false;
        }
        let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
        let mut caught = true;
        // Sign-in rows and the secrets key come before records: they decide whether this computer may answer the account's calls.
        if self.placed().may_answer {
            let signed_in = self.sign_in_follow(writer, true).pulled();
            let keyed = locked(&self.vault).computer_key.is_some();
            let secrets = !keyed || self.holds_secrets_key();
            if !signed_in || !secrets {
                crate::quiet_eprintln!("computers-writer event=follow-incomplete account={} computer={} writer={writer} sign_in={signed_in} secrets_key={secrets}",
                    self.address, self.me);
            }
            caught &= signed_in && secrets;
        }
        let mut pulled = true;
        for resource in resources {
            if let Err(error) = self.catch_up_from(writer, &resource, true) {
                crate::quiet_eprintln!("computers-writer event=catch-up-failed account={} computer={} writer={writer} resource={resource} cause={}",
                    self.address, self.me, error.cause());
                pulled = false;
            }
        }
        caught &= pulled;
        // Resources the writer's pages named that this computer did not follow yet: caught up only once they are too.
        let learned = locked(&self.resources).len();
        if caught && !self.joined() && learned == locked(&self.resources).len() {
            self.mark_joined();
        }
        pulled
    }

    /// Every computer of `peers` asked for its stamps at once (`send_all`, up to one and a half `message_wait_ms`, a
    /// send's own wait and its one resend): one out of reach delays no
    /// other. Answers the stamps of each that answered, in the order of `peers`, so catching up from them goes the same
    /// way at every computer.
    pub(crate) fn stamps_of_all(&self, peers: &[String]) -> Vec<(String, Vec<(String, u64, i64)>)> {
        self.stamps_from(peers, peers, peers.len())
    }

    /// Ask every peer, retaining each answer heard before `enough` of `required` answered. A claim needs a voting
    /// majority; bootstrap still needs every reachable peer (`stamps_of_all`). Returned answers keep the peers' order,
    /// including any non-voter heard meanwhile, so every newer resource and row they name is caught up before voting.
    fn stamps_from(&self, peers: &[String], required: &[String], enough: usize) -> Vec<(String, Vec<(String, u64, i64)>)> {
        if enough == 0 {
            return Vec::new();
        }
        let mut heard: HashMap<String, Vec<(String, u64, i64)>> = HashMap::new();
        let wait = settings().message_wait_ms;
        let deadline = self.deadline_in(wait.saturating_add(wait / 2));
        let first = peers.iter().map(|peer| (peer.clone(), Message::Stamps)).collect();
        self.send_all(first, deadline, &mut |peer, answer, _| {
            if let Some(Answer::Stamps { stamps, .. }) = answer {
                heard.insert(peer.to_string(), stamps);
            }
            heard.keys().filter(|peer| required.contains(peer)).count() >= enough
        });
        peers.iter().filter_map(|peer| heard.remove(peer).map(|stamps| (peer.clone(), stamps))).collect()
    }

    /// A computer that may answer, holds a computer key and holds no root asks each may-answer peer for the root on a sign-in
    /// pull, until it holds it. The root comes only on that pull, so this runs whatever writer its row names: a row that names a
    /// silent computer must not keep a joining computer from its root.
        // It asks even when its account rows hold as much as that computer's: the root comes only on a sign-in pull. Before, a computer joining an
        // account whose computers had no writer yet waited for ever: no computer was ahead on account rows (the old computer had
        // not claimed, so had logged none), so no pull was made and the root never came; it could not count as caught
        // up without the root, and so never voted, and with two voters the old computer could not claim without its vote
        // (measured: a joining computer answered 503 for over 80 s with the old computer live).
    fn take_root_from_peers(&self) {
        if self.holds_secrets_key() {
            return;
        }
        let placed = self.placed();
        let keyed = locked(&self.vault).computer_key.is_some();
        if !placed.may_answer || !keyed {
            crate::quiet_eprintln!("computers-join event=root-not-asked account={} computer={} may_answer={} keyed={keyed}", self.address, self.me, placed.may_answer);
            return;
        }
        for peer in &placed.may_answer_peers {
            self.sign_in_follow(peer, false);
            if self.holds_secrets_key() {
                return;
            }
        }
        crate::quiet_eprintln!("computers-join event=root-not-held account={} computer={} peers={}", self.address, self.me, placed.may_answer_peers.len());
    }

    /// A computer added to a running account that knows no live writer: it asks every other computer for its stamps, catches
    /// up from any that holds more, and counts as caught up once a majority of the voters answered and none holds more.
    fn join_from_peers(&self) {
        let placed = self.placed();
        let keyed = locked(&self.vault).computer_key.is_some();
        self.take_root_from_peers();
        let mut answered = usize::from(placed.voters.contains(&self.me));
        let mut behind = false;
        for (peer, stamps) in self.stamps_of_all(&placed.peers) {
            if placed.voters.contains(&peer) {
                answered += 1;
            }
            behind |= !self.catch_up_stamps(&peer, &stamps).is_empty();
        }
        let secrets_key_ready = !placed.may_answer || !keyed || self.holds_secrets_key();
        if !behind && secrets_key_ready && answered * 2 > placed.voters.len() && !self.joined() {
            self.mark_joined();
        }
    }

    /// Catch up from `peer`, which answered `stamps`, in every entry where it holds more than this computer: records,
    /// account rows (only from a computer that may answer) and the computers row. Answers whether this computer is still behind.
    fn catch_up_stamps(&self, peer: &str, stamps: &[(String, u64, i64)]) -> Vec<ClaimGap> {
        let mut gaps = Vec::new();
        let row_entry = self.row_entry();
        // Sign-in rows first: they decide whether this computer may answer the account's calls.
        let mut ordered: Vec<&(String, u64, i64)> = stamps.iter().collect();
        ordered.sort_by_key(|(resource, _, _)| *resource != settings().copied_row);
        for (resource, term, stamp) in ordered {
            let (term, stamp) = (*term, *stamp);
            if *resource == settings().copied_row {
                if !self.placed().may_answer {
                    continue;
                }
                // Sign-in rows: catch up from a computer that holds more (it may be a computer that only voted, never one
                // that may not answer: such a computer holds none).
                if (term, stamp) > self.sign_in_held() {
                    if self.placed().may_answer_peers.iter().any(|computer| computer == peer) {
                        self.sign_in_follow(peer, false);
                    } else {
                        // A voter that may not answer holds only the mark: catch up from any may-answer computer that
                        // holds the rows.
                        for other in self.placed().may_answer_peers.clone() {
                            if (term, stamp) <= self.sign_in_held() {
                                break;
                            }
                            self.sign_in_follow(&other, false);
                        }
                    }
                }
                let held = self.sign_in_held();
                if (term, stamp) > held {
                    gaps.push(ClaimGap::Stamp { resource: resource.clone(), theirs: (term, stamp), held });
                }
                continue;
            }
            if *resource == row_entry {
                let mark = self.placed().mark();
                if (term, u64::try_from(stamp).unwrap_or(0)) > mark {
                    self.pull_row(peer);
                }
                let (theirs, held) = ((term, u64::try_from(stamp).unwrap_or(0)), self.placed().mark());
                if theirs > held {
                    gaps.push(ClaimGap::Mark { theirs, held });
                }
                continue;
            }
            locked(&self.resources).insert(resource.clone());
            if (term, stamp) > self.held(resource) {
                let caught = self.catch_up_from(peer, resource, false);
                let held = self.held(resource);
                if (term, stamp) > held {
                    let cause = match caught {
                        Err(error) => error.cause(),
                        Ok(_) => crate::cause!(writer catch_up_still_behind),
                    };
                    crate::quiet_eprintln!("computers-writer event=behind cause={cause}");
                    gaps.push(ClaimGap::Stamp { resource: resource.clone(), theirs: (term, stamp), held });
                }
            }
        }
        gaps
    }

    fn catch_up_from(&self, computer: &str, resource: &str, writer: bool) -> Result<i64, Error> {
        if let Some(address) = group_address(resource) {
            return self.catch_up_group(computer, &address.history, &address.resource, writer, true);
        }
        let mut store = self.records.open(resource)?;
        let floor = store.accepted_term(&self.owner, &named(resource))?;
        let source = FeedByMessages { copies: self, to: computer, key: resource, writer, floor };
        follow::catch_up(&mut store, &source, &self.owner, &named(resource), settings().feed_page_items)
    }

    /// Claim the writer turn: catch up from every computer that holds more, then ask the voters. On a win, tell the term.
    fn claim(&self, now: i64) -> bool {
        if !self.group_inventory_ready.load(Ordering::Acquire) {
            crate::quiet_eprintln!("computers-writer event=claim-refused account={} computer={} cause=group-inventory-not-ready", self.address, self.me);
            return false;
        }
        let _one = locked(&self.claiming);
        if self.holding().is_some() {
            // Another claim of this computer won while this one waited.
            return true;
        }
        let placed = self.placed();
        let own = usize::from(placed.voters.contains(&self.me));
        let enough = (placed.voters.len() / 2 + 1).saturating_sub(own);
        let heard = self.stamps_from(&placed.peers, &placed.voters, enough);
        let mut gaps = Vec::new();
        // An acknowledged write is held by a voting majority (`majority_holds`), which intersects this majority.
        // A paused minority therefore need not delay a claim. Every heard newer stamp is still pulled first, and the
        // voters separately refuse a takeover from a copy that holds less, is joining, or cannot take the writer term.
        for (peer, stamps) in &heard {
            gaps.extend(self.catch_up_stamps(peer, stamps));
        }
        // A newer computers row may have come in while catching up: the claim is asked of its voters. The term is asked
        // from now, not from before the stamps were heard and caught up from: that wait is not taken out of the term won
        // (a claim that waited on a stalled peer won a term already as good as over).
        let placed = self.placed();
        // Catch-up can change the voters: an answer from a voter of the old row counts only if it still votes now.
        // If these answers no longer form a majority, leave the claim refused for the next step under that new row.
        let answered = usize::from(placed.voters.contains(&self.me))
            + heard.iter().filter(|(peer, _)| placed.voters.contains(peer)).count();
        let now = (self.clock)().max(now);
        if !(placed.keeps_copy && placed.may_answer) {
            gaps.push(ClaimGap::Placement);
        }
        // A joining computer whose configured account stores are not held yet is not complete: its writer turn would answer no
        // door. A creator, or a copy with no stores configured, is complete as it stands.
        if !self.joined() && self.account_stores.get().is_some_and(|stores| !stores.held()) {
            gaps.push(ClaimGap::Stores);
        }
        let groups = locked(&self.unmaterialized_groups).len();
        if groups > 0 {
            gaps.push(ClaimGap::Unmaterialized { groups });
        }
        if answered * 2 <= placed.voters.len() {
            gaps.push(ClaimGap::NoMajority { answered, voters: placed.voters.len() });
        }
        for gap in &gaps {
            crate::quiet_eprintln!("computers-writer event=claim-behind account={} computer={} gap={}", self.address, self.me, gap.describe());
        }
        let gate = Gate(gaps.is_empty());
        let claimed = self.writer_role_step(|turn| turn.claim(now, &self.writer_rows, &VoteWire { copies: self }, &gate));
        let won = claimed == Ok(true);
        // A claim that did not win (no majority, or another claimer moved this computer's own row first) leaves the
        // voters' rows naming different computers, so the turns to claim no longer agree: each computer counts every
        // computer that may claim from now on, until it hears a writer.
        self.split.store(!won && claimed.is_ok(), Ordering::Release);
        if !won {
            self.hold_claims(now);
            let cause = match &claimed {
                Err(error) => error.cause(),
                Ok(_) => crate::cause!(writer claim_not_won),
            };
            crate::quiet_eprintln!("computers-writer event=claim-lost cause={cause}");
        }
        if won {
            if let Some(term) = self.holding() {
                let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
                for resource in &resources {
                    if let Ok(mut store) = self.records.open(resource) {
                        let base = if group_address(resource).is_some() { self.held(resource).1 }
                            else { store.stamp(&self.owner, &named(resource)).unwrap_or(0) };
                        let _ = store.take_term(&self.owner, &named(resource), term, base);
                    }
                }
                self.take_sign_in_term(term);
                crate::quiet_eprintln!("computers-writer event=claimed account={} computer={}", self.address, self.me);
                self.tell(term);
            }
        }
        won
    }

    /// A new writer's empty page to every copy: each moves its term floor, and answers its stamp.
    fn tell(&self, term: u64) {
        let peers = self.placed().peers.clone();
        self.tell_to(term, &peers);
    }

    fn term_announcement(&self, term: u64, resource: &str) -> Message {
        if let Some(address) = group_address(resource) {
            let held = self.held(resource).1;
            Message::Group { request: GroupRequest::Push { scope: address.history,
                term, base: held, after: held, commits: Vec::new() } }
        } else {
            Message::Push { term, resource: resource.to_owned(), after: 0,
                changes: Vec::new(), base: self.base_of(term, resource) }
        }
    }

    /// The empty page of term `term` to each of `peers`; answers the computers that took it for every resource.
    fn tell_to(&self, term: u64, peers: &[String]) -> Vec<String> {
        // Every peer at once (`send_all`): a computer out of reach delays no other. Each peer's resources go one after
        // another, since its answers name no resource.
        let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
        let mut answered: HashMap<String, usize> = HashMap::new();
        let mut failed: HashSet<String> = HashSet::new();
        let mut by_peer: HashMap<String, std::collections::VecDeque<String>> =
            peers.iter().map(|peer| (peer.clone(), resources.iter().cloned().collect())).collect();
        let mut first = Vec::new();
        for peer in peers {
            if let Some(resource) = by_peer.get(peer).and_then(|queue| queue.front()).cloned() {
                first.push((peer.clone(), self.term_announcement(term, &resource)));
            }
        }
        let deadline = self.deadline_in(settings().message_wait_ms.saturating_mul(resources.len().max(1) as u64));
        self.send_all(first, deadline, &mut |peer, answer, more| {
            let Some(queue) = by_peer.get_mut(peer) else { return false };
            let Some(resource) = queue.pop_front() else { return false };
            match answer {
                Some(Answer::Applied { stamp }) | Some(Answer::Behind { stamp })
                | Some(Answer::Group { answer: GroupAnswer::Applied { through: stamp } }) => {
                    self.hear(peer, &resource, stamp);
                    *answered.entry(peer.to_string()).or_default() += 1;
                }
                _ => {
                    failed.insert(peer.to_string());
                    // This peer cannot count as told for every resource once one announcement failed. Sending each
                    // remaining resource to the same unavailable peer only repeats its full transport wait while a
                    // new writer's claim is held up. The peer catches up from the ordinary feed when reachable again.
                    return false;
                }
            }
            if let Some(next) = queue.front().cloned() {
                more.push((peer.to_string(), self.term_announcement(term, &next)));
            }
            false
        });
        peers.iter().filter(|peer| !failed.contains(*peer) && answered.get(*peer).copied().unwrap_or(0) == resources.len()).cloned().collect()
    }

    fn hear(&self, computer: &str, resource: &str, stamp: i64) {
        let mut heard = locked(&self.heard);
        let entry = heard.entry((computer.to_string(), resource.to_string())).or_insert(stamp);
        *entry = (*entry).max(stamp);
    }

    fn heard(&self, computer: &str, resource: &str) -> Option<i64> {
        locked(&self.heard).get(&(computer.to_string(), resource.to_string())).copied()
    }

    /// The computers this voter vouched for, or heard were vouched for, that may still admit, and for how many more
    /// milliseconds (`Answer::Vote`). Ended ones are forgotten.
    fn vouched_now(&self, now: i64) -> Vec<(String, i64)> {
        let mut held = locked(&self.vouched);
        held.retain(|_, until| *until > now);
        held.iter().map(|(computer, until)| (computer.clone(), until - now)).collect()
    }

    /// Whether no term is live in this computer's own writer row at `now`: none, or it ran out more than
    /// `clock_margin_ms` ago (as a voter accepts a takeover). Then no computer that keeps a copy can still renew with this voter, and no
    /// computer that keeps a copy can still write under a term this voter took part in.
    fn no_live_term(&self, now: i64) -> bool {
        match self.writer_rows.read(&self.id) {
            Ok(Some(row)) => now > row.expires_at_ms + settings().clock_margin_ms,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    /// A voter's answer to `Message::Vouch` from `from`: how long, from its ask, `from` may admit from its copy on this
    /// voter's word; 0 when it may not. This voter vouches only when it votes, vouching is on (`vouch_ms`), no term is
    /// live in its own writer row, `from` is a computer the row lets answer, and `from`'s sign-in counter holds at least
    /// what this voter holds (its rows, or its mark at a voter that may not answer). It keeps the time it gave
    /// (`vouched`) and names it in every vote it answers while it runs.
    ///
    /// Why a turned-off key stays off: a change is done only once more than half of the voters hold it (rows or mark)
    /// and every may-answer computer holds it or can no longer admit. A computer vouched for by more than half of the voters
    /// shares a voter with every such half, so it holds every change done before it asked. A change done later needs a
    /// live term: a term live when it asked was live at more than half of the voters, one of which then refused to
    /// vouch; a term taken after it asked was taken with the vote of a voter that vouched, which named the time, so
    /// that writer waits until `from` holds the change or can no longer admit.
    fn vouch_for(&self, from: &str, now: i64, term: u64, stamp: u64) -> i64 {
        let placed = self.placed();
        let ms = settings().vouch_ms;
        if ms <= 0 || !placed.voters.contains(&self.me) || !placed.may_answer_peers.iter().any(|computer| computer == from) || !self.joined() {
            return 0;
        }
        if locked(&self.writer_role).holding(now).is_some() {
            return 0;
        }
        let held = {
            let _one = locked(&self.sign_in);
            match self.log().counter() {
                Ok(counter) => (counter.term, counter.stamp),
                Err(_) => return 0,
            }
        };
        if (term, stamp) < held {
            return 0;
        }
        // The check of the writer row and the record of the time given are one step under the `vouched` lock, as a
        // vote is: a vote this voter answers is either before it (its term is then live here and this refuses) or
        // after it (and names it).
        let mut vouched = locked(&self.vouched);
        if !self.no_live_term(now) {
            return 0;
        }
        let entry = vouched.entry(from.to_string()).or_insert(now + ms);
        *entry = (*entry).max(now + ms);
        ms
    }

    /// While no writer is known: ask the voters to vouch for this computer's copy of the account rows (`vouch_for`). Once
    /// more than half of them (this computer among them, when it votes) vouch, it may admit from its copy for `vouch_ms`
    /// after it asked. Answers whether it may.
    fn vouch(&self) -> bool {
        let placed = self.placed();
        if settings().vouch_ms <= 0 || !placed.may_answer || !placed.keeps_copy || !self.joined() {
            return false;
        }
        let (term, stamp) = {
            let state = locked(&self.sign_in);
            if state.resync.is_some() {
                return false;
            }
            match self.log().counter() {
                Ok(counter) => (counter.term, counter.stamp),
                Err(_) => return false,
            }
        };
        let sent = (self.clock)();
        let until = sent.saturating_add(settings().vouch_ms);
        let mut yes = 0;
        for voter in &placed.voters {
            let ms = if *voter == self.me {
                // Its own vote, on the same rule a voter answers by: no term live in its writer row, checked and kept
                // in one step before any other voter is asked, so a vote it answers meanwhile names it.
                let mut vouched = locked(&self.vouched);
                if self.no_live_term(sent) {
                    let entry = vouched.entry(self.me.clone()).or_insert(until);
                    *entry = (*entry).max(until);
                    settings().vouch_ms
                } else {
                    0
                }
            } else {
                match self.send(voter, &Message::Vouch { term, stamp }) {
                    Some(Answer::Vouch { ms }) => ms,
                    _ => 0,
                }
            };
            if ms >= settings().vouch_ms {
                yes += 1;
            }
        }
        if yes * 2 <= placed.voters.len() {
            return false;
        }
        let _ = self.fresh_until.fetch_max(until, Ordering::AcqRel);
        // A majority vouched for this copy's sign-in changes at `sent`: that is hearing the group, as a page from the writer is.
        let _ = self.heard_at.fetch_max(sent, Ordering::AcqRel);
        true
    }

    /// How long until this computer's next step (`tick`) is due, in milliseconds: `renew_every_ms` at most; 0 when it
    /// just heard a new writer; and, when no live writer is known and this computer may claim, the moment its claim is
    /// due, so a caught-up computer claims as its turn comes rather than on the next whole step. The computer's timer runs
    /// `tick` when this reaches 0.
    /// Whether a message asked for a step now (`step_now`): a row change ended a removed writer's term here, so this
    /// computer may claim at once. Its computer wakes the timer for it (`computer_message`).
    pub fn step_due(&self) -> bool {
        self.step_now.load(Ordering::Acquire)
    }

    pub fn next_step_ms(&self) -> i64 {
        let every = settings().renew_every_ms;
        let now = (self.clock)();
        let last = self.last_step.load(Ordering::Acquire);
        let regular = last.saturating_add(every).saturating_sub(now).clamp(0, every);
        if self.step_now.load(Ordering::Acquire) {
            return 0;
        }
        if self.holding().is_some() || !self.placed().may_answer || !self.joined() {
            return regular;
        }
        // When the writer's term runs out (plus the margin) this computer may ask the voters to vouch, and when its turn
        // comes it claims: a step right after each (`tick` acts when the time is past it). A step that ran after that
        // moment already acted on it, so the next one waits the whole step again.
        let (ends, due) = self.claim_times();
        [ends, due].into_iter().filter(|at| *at >= last).fold(regular, |next, at| next.min(at.saturating_add(1).saturating_sub(now).max(0)))
    }

    /// When this computer's claim is due, if no live writer is known: the term in its row ran out, plus the clock
    /// margin, plus its turn. Its turn counts only the voters that may claim (they may answer) before it, leaving out
    /// the computer that keeps a copy its row names (that term ran out: it is the computer that went away), so the first other computer that
    /// may answer claims at once and the next one step later, which keeps two from splitting the votes.
    fn claim_due(&self) -> Option<i64> {
        Some(self.claim_times().1)
    }

    /// When the term in this computer's writer row runs out, plus the clock margin (0 with no row), and when this computer's
    /// claim is due (`claim_due`).
    fn claim_times(&self) -> (i64, i64) {
        let placed = self.placed();
        let row = self.writer_rows.read(&self.id).ok().flatten();
        let named_in_row = row.as_ref().map(|row| row.writer.clone()).unwrap_or_default();
        let ends = row.as_ref().map_or(0, |row| row.expires_at_ms + settings().clock_margin_ms);
        // The computer the row names is left out (the one that went away), so the first other computer claims at once.
        // After a claim that did not win, the rows of the voters name different computers (each the claimer that reached
        // that voter first), so leaving out the one each row names gave two claimers the same turn, and they split the
        // votes again on every turn (measured 2026-11-03, three computers restarted at once: writer numbers 33 to 53 in
        // 3 minutes with no writer, each claimer's own row moved by the other's ask before its own vote). Then every
        // computer that may claim counts, in the voters' order, which is the same at every computer.
        let split = self.split.load(Ordering::Acquire);
        // The named writer is left out only while it is another computer: a writer whose own term ran out (a lone holder that
        // is not used) is the first claimer of its own turn, so it takes the term back (the row still names it).
        let may_claim = |computer: &String| (split || *computer != named_in_row) && (*computer == self.me && placed.may_answer || placed.may_answer_peers.contains(computer));
        let claimers: Vec<&String> = placed.voters.iter().filter(|voter| may_claim(voter)).collect();
        let rank = claimers.iter().position(|voter| **voter == self.me).unwrap_or(claimers.len()) as i64;
        // A computer added to the account counts its turn from when it caught up, plus the margin and one step, when that
        // is after the term ran out: the computers already there get a step to claim with its vote first. A new account
        // has no writer row (the term "ran out" at 0), so a computer that had just joined it claimed at once beside the
        // computer that made it, they split the votes and the joiner often won; a account row made at the maker outside
        // its copies then never travelled (measured 2026-11-04, tests/computer_forwarder.rs: B claimed, A lost with all
        // three voters that may answer, and the first key A issued was refused through the forwarder).
        let joined_at = self.joined_at.load(Ordering::Acquire);
        let from = if joined_at == i64::MIN { ends } else {
            ends.max(joined_at.saturating_add(settings().clock_margin_ms + settings().renew_every_ms))
        };
        (ends, from + rank * settings().renew_every_ms)
    }

    /// Run one write on this computer's copy as one unit with its acknowledgement (see the module doc). `write` writes
    /// into the records store inside a transaction that commits only once a second copy holds every change it made.
    pub fn write<T>(&self, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>) -> Result<T, WriteRefused> {
        let path = self.records.records.clone();
        self.write_at(&path, write, false)
    }

    /// `write`, on the account's vault store (`with_vault`): its sealed secrets travel as records do.
    /// `write` on the store that keeps copy key `key` (`Stores::path`: a list, an own work, a further store of a
    /// volume), as one unit with its acknowledgement. Inside, the store names the resource by its own name (`named`).
    pub fn write_in<T>(&self, key: &str, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>) -> Result<T, WriteRefused> {
        self.write_in_class(key, &ScopeClass::of_key(key), write)
    }

    /// `write_in` under scope class `class`. A `crdt-merge` write commits here on any computer and merges by stamps when
    /// the copies settle (plan 4a, B-2); a lease-writer write waits for the writer turn and its acknowledgement.
    pub(crate) fn write_in_class<T>(&self, key: &str, class: &ScopeClass, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>) -> Result<T, WriteRefused> {
        // A store first written here (a new list) is made with its schema first, as a copy makes it (`Stores::open`).
        self.records.open(key).map_err(|value| WriteRefused::Records(value, crate::cause!()))?;
        let path = self.records.path(key);
        self.write_at(&path, write, class.is_crdt_merge())
    }

    pub fn write_vault<T>(&self, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>) -> Result<T, WriteRefused> {
        let path = self.records.vault.clone().ok_or(WriteRefused::Records(crate::cause!(Error::Unavailable), crate::cause!()))?;
        self.write_at(&path, write, false)
    }

    /// `merge`: a `crdt-merge` write commits on this computer with no writer turn and no acknowledgement; its changes merge
    /// with the other copies by stamps when they settle (`settle_all`).
    fn write_at<T>(&self, path: &Path, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>, merge: bool) -> Result<T, WriteRefused> {
        self.touch();
        if !merge {
            if self.holding().is_none() {
                // The writer term is taken on the account's first write (it was released while the account was idle).
                self.claim_for_write();
                // The wait is taken before the write lock, so the timer's claim and a hand-over are never kept out by it.
                self.await_claim()?;
            }
        }
        let _one = locked(&self.writing);
        if !merge && self.holding().is_none() {
            return Err(crate::cause!(WriteRefused::NotWriter));
        }
        if let Some(opener) = self.records.opener.clone() {
            return self.write_scoped(opener.as_ref(), path, write, merge);
        }
        let connection = Connection::open(path).map_err(|_| WriteRefused::Records(crate::cause!(Error::Unavailable), crate::cause!()))?;
        connection.busy_timeout(Duration::from_millis(settings().ack_wait_ms)).map_err(|_| WriteRefused::Records(crate::cause!(Error::Unavailable), crate::cause!()))?;
        connection.execute_batch("BEGIN IMMEDIATE").map_err(|_| WriteRefused::Records(crate::cause!(Error::Unavailable), crate::cause!()))?;
        let held = changes::HeldChanges::begin();
        let written = (|| {
            let lent = sqlite::lend(&connection, SCHEMA, Access::Write).map_err(|error| Error::Unavailable(error.cause()))?;
            let limits = self.records.limits(&lent, path)?;
            let mut store = RecordStore::new(Box::new(lent) as Box<dyn Storage + '_>, Box::new(RealClock), limits)?.mirrored(true);
            write(&mut store)
        })();
        let value = match written {
            Ok(value) => value,
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(WriteRefused::Records(error, crate::cause!()));
            }
        };
        let resources = changes::held_resources(&self.owner);
        if merge {
            connection.execute_batch("COMMIT").map_err(|_| WriteRefused::OutcomeUnknown(crate::cause!()))?;
            held.published();
            return Ok(value);
        }
        match self.acknowledge(&connection, &resources) {
            Ok(()) => {
                connection.execute_batch("COMMIT").map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
                held.published();
                Ok(value)
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                if matches!(error, WriterError::NotAcknowledged(_)) {
                    crate::quiet_eprintln!("computers-writer event=gave-up code=write-not-acknowledged cause={}", error.cause());
                    self.give_up();
                    Err(WriteRefused::NotAcknowledged(error.cause()))
                } else {
                    Err(WriteRefused::NotWriter(error.cause()))
                }
            }
        }
    }

    /// The acknowledgement of a write held in the open write transaction on `connection` (not committed yet), which
    /// changed `resources`: send its changes to the other copies until one holds them all, then check, as
    /// `WriterRole::commit` does, that this computer still holds the writer turn. `Ok` means the caller may commit; any error means
    /// it must roll back.
    pub(crate) fn acknowledge(&self, connection: &Connection, resources: &[String]) -> WriterResult<()> {
        let read = sqlite::lend(connection, SCHEMA, Access::Read).map_err(|error| WriterError::Storage(error.cause()))?;
        let write = sqlite::lend(connection, SCHEMA, Access::Write).map_err(|error| WriterError::Storage(error.cause()))?;
        self.acknowledge_on(&read, &write, connection.path().map(PathBuf::from), resources)
    }

    /// `write` on a computer whose stores are opened by `opener` (`StoreOpener`): the same unit, with the store's own
    /// write scope (`Storage::open_scope`) where a file write holds its open transaction. Rolled back unless one copy
    /// acknowledged it, exactly as a file write is.
    fn write_scoped<T>(&self, opener: &dyn StoreOpener, path: &Path, write: impl FnOnce(&mut OpenWrite<'_>) -> Result<T, Error>, merge: bool) -> Result<T, WriteRefused> {
        let handle = opener.open(path).map_err(|value| WriteRefused::Records(value, crate::cause!()))?;
        handle.open_scope(Intent::Write).map_err(|error| { let cause = error.cause(); WriteRefused::Records(Error::Unavailable(cause.clone()), cause) })?;
        let held = changes::HeldChanges::begin();
        let written = (|| {
            let mut store = RecordStore::new(Box::new(&*handle) as Box<dyn Storage + '_>, Box::new(RealClock), opener.limits())?.mirrored(true);
            write(&mut store)
        })();
        let value = match written {
            Ok(value) => value,
            Err(error) => {
                let _ = handle.close_scope(false);
                return Err(WriteRefused::Records(error, crate::cause!()));
            }
        };
        let resources = changes::held_resources(&self.owner);
        if merge {
            handle.close_scope(true).map_err(|_| WriteRefused::OutcomeUnknown(crate::cause!()))?;
            held.published();
            return Ok(value);
        }
        match self.acknowledge_on(&*handle, &*handle, Some(path.to_path_buf()), &resources) {
            Ok(()) => {
                handle.close_scope(true).map_err(|error| WriteRefused::OutcomeUnknown(error.cause()))?;
                held.published();
                Ok(value)
            }
            Err(error) => {
                let _ = handle.close_scope(false);
                if matches!(error, WriterError::NotAcknowledged(_)) {
                    crate::quiet_eprintln!("computers-writer event=gave-up code=write-not-acknowledged cause={}", error.cause());
                    self.give_up();
                    Err(WriteRefused::NotAcknowledged(error.cause()))
                } else {
                    Err(WriteRefused::NotWriter(error.cause()))
                }
            }
        }
    }

    /// A complete source frame is already durable with the original effect,
    /// keys, indexes and protected receipt in this held transaction. Copies
    /// transports that exact frame; it never reconstructs derived state.
    pub(super) fn acknowledge_captured(&self, storage: &dyn Storage, domain: &GroupDomain,
        captured: Option<&CapturedCommit>) -> WriterResult<()> {
        let scope = domain.selection().identity();
        if !self.group_inventory_supported.load(Ordering::Acquire) || !storage.scoped()
            || !storage.writing().map_err(|error| WriterError::Storage(error.cause()))? { return Err(crate::cause!(WriterError::Storage)); }
        // Qualify this held source as the selected complete history before
        // writer eligibility or any peer traffic. A source from the primary
        // namespace cannot become a domain frame even when no term is held.
        let path = domain.readers().map_err(|error| WriterError::Storage(error.cause()))?.path().to_path_buf();
        let limits = self.records.limits(&storage, &path).map_err(|error| WriterError::Storage(error.cause()))?;
        let mut store = RecordStore::new(storage, Box::new(RealClock), limits).map_err(|error| WriterError::Storage(error.cause()))?;
        if !group_header_matches(&store, &self.owner, &scope).map_err(|error| WriterError::Storage(error.cause()))? { return Err(crate::cause!(WriterError::Storage)); }
        let term = self.holding().ok_or(crate::cause!(WriterError::NotWriter))?;
        if !self.writer_rows.read(&self.id)?.is_some_and(|row| row.writer == self.me && row.term == term) { return Err(crate::cause!(WriterError::NotWriter)); }
        let Some(captured) = captured else {
            // The existing logical change owner, not caller JSON, proves an
            // unchanged retry. Any changed resource requires a complete frame.
            return if changes::held_resources(&self.owner).is_empty() { Ok(()) } else { Err(crate::cause!(WriterError::Storage)) };
        };
        let stream = group_stream(&scope, &self.owner).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        let bound = group_binding(&scope, &self.owner).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        let budget = group_limits().map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        commit_log::bind_stream(storage, &scope.copy_namespace(&self.owner).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?, &bound, budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        commit_log::bind_stream(storage, &stream, &bound, budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        let front = commit_log::frontiers(storage, &stream, budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        if front.materialized != captured.sequence || front.stored != captured.sequence { return Err(crate::cause!(WriterError::Storage)); }
        let page = commit_log::commits_after(storage, &stream, captured.sequence - 1, budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        if page.commits.first() != Some(captured) { return Err(crate::cause!(WriterError::Storage)); }
        // Stable token custody is committed with the source frame. A domain
        // already bootstrapped as an opaque map advances incrementally; an
        // ordinary rootful source exports its actual physical snapshot instead.
        self.token_key(storage,&scope).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        // New streams start with the complete newly created namespace. An
        // existing namespace without captured history needs qualified bootstrap.
        if captured.sequence == 1 && !captured.effects.iter().any(|effect|
            effect.family == "versions" && effect.row.is_some() && effect.key.starts_with(&[
                live_adopt::Cell::Text(self.owner.clone()), live_adopt::Cell::Text(crate::local_account::own_records::IDENTITY.into()),
                live_adopt::Cell::Text("command-domain".into())])) { return Err(crate::cause!(WriterError::Storage)); }
        let root = scope.resource(&self.owner).map_err(|error| WriterError::Storage(error.cause()))?;
        if store.accepted_term(&self.owner, &root).map_err(|error| WriterError::Storage(error.cause()))? < term {
            store.take_term(&self.owner, &root, term, captured.sequence - 1).map_err(|error| WriterError::Storage(error.cause()))?;
        }
        let key = group_key(&scope, &root).map_err(|error| WriterError::Storage(error.cause()))?;
        let written = vec![(key.clone(), captured.sequence)];
        locked(&self.resources).insert(key);
        let prepared=commit_log::Pending {source:self.me.clone(),term,sequence:captured.sequence,
            digest:commit_log::digest_of(captured,budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?,base:captured.sequence-1};
        commit_log::prepare(storage,&stream,&prepared,budget).map_err(|error| crate::carry_cause!(WriterError::Storage, error))?;
        let placed = self.placed();
        let deadline = self.deadline_in(settings().ack_wait_ms);
        let first = placed.peers.iter().filter(|peer| placed.voters.contains(peer) || placed.may_answer_peers.contains(peer))
            .map(|peer| (peer.clone(), Message::Group { request: GroupRequest::Probe { scope: scope.clone() } })).collect();
        let mut ended = locked(&self.unreached).clone();
        let mut confirmed = HashSet::new();
        self.send_all(first, deadline, &mut |peer, answer, more| {
            let through = match answer {
                Some(Answer::Group { answer: GroupAnswer::Stamps { through, .. } }) => Some(through),
                Some(Answer::Group { answer: GroupAnswer::Applied { through } }) => {
                    if through == captured.sequence {
                        confirmed.insert(peer.to_string());
                        self.hear(peer, &written[0].0, through);
                        ended.insert(peer.to_string());
                        None
                    } else { Some(through) }
                }
                _ => { ended.insert(peer.to_string()); None }
            };
            if let Some(after) = through {
                if after < 0 || after > captured.sequence || self.waiting.now_ms() >= deadline { ended.insert(peer.to_string()); }
                else {
                    // Even an already-current peer must confirm this delivery;
                    // replay its exact retained last frame after a lost reply.
                    let after = after.min(captured.sequence.saturating_sub(1));
                    match self.group_wire_page(&scope, term, storage, after,true) {
                        Ok(GroupAnswer::Page { base, commits, .. }) if !commits.is_empty() =>
                            more.push((peer.into(), Message::Group { request: GroupRequest::Prepare { scope: scope.clone(), term, base, after, commits } })),
                        _ => { ended.insert(peer.to_string()); }
                    }
                }
            }
            self.group_acknowledged(&confirmed, &ended)
        });
        if !self.group_acknowledged(&confirmed, &ended) { return Err(crate::cause!(WriterError::NotAcknowledged)); }
        // Only final proof publication is shared; no network or resource hold
        // runs under this short reservation.
        let _proof = locked(&self.ack_proof);
        *locked(&self.pending) = written;
        let result = locked(&self.writer_role).commit((self.clock)(), &self.writer_rows, self, || Ok(((), captured.sequence)));
        locked(&self.pending).clear();
        result?;
        drop(_proof);
        Ok(())
    }

    fn group_committed_position(&self,scope:&GroupIdentity)->Result<(u64,i64),Error> {
        let store=self.records.open(&group_key(scope,&scope.resource(&self.owner)?)?)?;let storage=&**store.storage();
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result=(||Ok((store.accepted_term(&self.owner,&scope.resource(&self.owner)?)?,
            commit_log::committed_through(storage,&group_stream(scope,&self.owner)?,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)))();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;result
    }
    #[cfg(test)]
    fn group_ready(&self,scope:&GroupIdentity)->bool {
        self.group_snapshot(scope).is_ok_and(|(_,front,_,committed)|front.materialized==committed)
    }
    /// A physical read failure cannot assert a different materialization frontier. Keep its source failure
    /// distinct from a successfully observed lag; callers still propagate that failure for the affected work.
    /// New histories remain fenced by inventory discovery and the existing explicit installation marks.
    fn refresh_group_materialized(&self,scope:&GroupIdentity)->Result<bool,Error> {
        let key=group_key(scope,&scope.resource(&self.owner)?)?;
        let (_,front,_,committed)=self.group_snapshot(scope).map_err(|cause| {
            // A successfully proved binding/refusal remains a closed admission gate. Only an unavailable physical
            // sample supplies no replacement frontier; the affected operation still returns that source error.
            if !matches!(&cause,Error::Unavailable(_)) {self.mark_group_materialized(&key,false);}
            let code=match &cause {Error::Unavailable(_)=>"source-unavailable",Error::Conflict(_)=>"binding-conflict",_=>"source-refused"};
            crate::quiet_eprintln!("record-writer event=readiness-source-refused code={code} cause={}", cause.cause());
            cause
        })?;
        let ready=front.materialized==committed;
        if !ready {crate::quiet_eprintln!("record-writer event=readiness-lag materialized={} committed={}",front.materialized,committed);}
        self.mark_group_materialized(&key,ready);
        Ok(ready)
    }

    fn apply_finalized_wire<S:Storage>(&self,store:&RecordStore<S>,scope:&GroupIdentity,wire:&WireCommit,publish:bool)->Result<(),Error> {
        let storage=&*store.storage();let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
        let plain=if self.placed().may_answer && !self.roots().is_empty() {Some(self.open_commit(scope,wire)?)}else{None};
        let map=opaque_map::map_info(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if map.is_none() && (plain.is_none() || !group_header_matches(store,&self.owner,scope)?) {
            opaque_map::initialize_empty_opaque_map(storage,&stream,&wire.map.key.identity,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        }
        opaque_map::bind_wrapped_key(storage,&stream,&wire.map.key,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        if commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_none() {
            commit_log::align_opaque_base(storage,&stream,wire.sequence-1,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        }
        commit_log::retain_opaque(storage,&stream,&opaque_commit(wire)?,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        let front=commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if let Some(plain)=plain {
            if front.materialized>=wire.sequence-1 {
                commit_log::materialize_opaque(storage,&stream,&plain,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            }
        }
        if opaque_map::map_info(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some() {
            opaque_map::update_opaque_map(storage,&stream,&wire.map.key.identity,&wire.map.delta,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        }
        if publish {commit_log::clear_pending(storage,&stream,wire.sequence,&wire.digest,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;}
        let safe=wire.sequence.saturating_sub(1);
        let front=commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if front.materialized>=safe {commit_log::trim_through(storage,&stream,safe,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;}
        commit_log::trim_opaque_through(storage,&stream,safe,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        Ok(())
    }

    fn answer_group_finalize(&self,from:&str,scope:&GroupIdentity,term:u64,wire:&WireCommit)->Answer {
        if let Err(answer)=self.take_writer_identity(from,&self.id,(self.clock)(),term) {return answer;}
        let result=(||->Result<i64,Error>{
            let root=scope.resource(&self.owner)?;let key=group_key(scope,&root)?;let mut store=self.records.open(&key)?;
            let storage=&**store.storage();self.flush_group_notice(storage,scope)?;storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let applied=(|| {
                let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
                live_adopt::command_access(storage,&stream).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                if commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|held|held.sequence!=wire.sequence||held.digest!=wire.digest) {return Err(crate::cause!(Error::Conflict));}
                self.apply_finalized_wire(&store,scope,wire,true)?;
                if !self.roots().is_empty() && commit_log::physical_commit(storage,&stream,wire.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some() {
                    commit_log::mark_notice(storage,&stream,wire.sequence,&wire.digest).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                }
                Ok(wire.sequence)
            })();
            storage.close_scope(applied.is_ok()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let through=applied?;self.flush_group_notice(storage,scope)?;store.take_term(&self.owner,&root,term,through.saturating_sub(1))?;
            self.refresh_group_materialized(scope)?;locked(&self.resources).insert(key);Ok(through)
        })();
        match result {Ok(through)=>Answer::Group {answer:GroupAnswer::Applied {through}},Err(error)=>refused("group_finalization_refused", crate::refusal_cause::Caused::cause(&error))}
    }

    fn answer_group_abort(&self,from:&str,scope:&GroupIdentity,term:u64,sequence:i64,digest:&str)->Answer {
        if let Err(answer)=self.take_writer_identity(from,&self.id,(self.clock)(),term) {return answer;}
        let result=(||->Result<i64,Error>{
            let key=group_key(scope,&scope.resource(&self.owner)?)?;let store=self.records.open(&key)?;let storage=&**store.storage();
            storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let aborted=(|| {let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
                if let Some(held)=commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                    if held.source!=from||held.term!=term||held.sequence!=sequence||held.digest!=digest {return Err(crate::cause!(Error::Conflict));}
                    commit_log::abort_prepared(storage,&stream,&held,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                }
                commit_log::committed_through(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))})();
            storage.close_scope(aborted.is_ok()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;let through=aborted?;
            self.refresh_group_materialized(scope)?;Ok(through)
        })();
        match result {Ok(through)=>Answer::Group {answer:GroupAnswer::Applied {through}},Err(error)=>refused("group_abort_refused", crate::refusal_cause::Caused::cause(&error))}
    }

    /// The original source's real physical writer orders any in-flight native
    /// transaction before this observation. A read snapshot alone cannot prove
    /// absence while a paused old writer still owns a transaction.
    fn answer_group_resolve(&self,from:&str,scope:&GroupIdentity,sequence:i64,digest:&str)->Answer {
        if !self.placed().peers.iter().any(|peer|peer==from) || self.roots().is_empty() {return refused("group_resolution_refused", crate::cause!());}
        let result=(||->Result<bool,Error>{
            let store=self.records.open(&group_key(scope,&scope.resource(&self.owner)?)?)?;let storage=&**store.storage();
            storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let result=(|| {let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
                match commit_log::physical_commit(storage,&stream,sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                    Some(frame)=>Ok(commit_log::digest_of(&frame,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?==digest),
                    None=>{
                        // An old committed frame can have left the retained
                        // tail. Physical absence there is not rollback proof.
                        let front=commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                        if sequence<front.retained_from {return Err(crate::cause!(Error::OutcomeUnknown));}
                        Ok(false)
                    }
                }})();
            storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;result
        })();
        match result {Ok(committed)=>Answer::Group {answer:GroupAnswer::Resolved {sequence,digest:digest.into(),committed}},Err(error)=>refused("group_resolution_unknown", crate::refusal_cause::Caused::cause(&error))}
    }

    /// Called ONLY after the source transaction ended. Its fresh physical
    /// snapshot, not the precommit borrowed transaction, is the commit proof.
    pub(super) fn finalize_captured(&self,storage:&dyn Storage,domain:&GroupDomain)->Result<(),Error> {
        self.finalize_group_storage(storage,&domain.selection().identity())
    }
    fn finalize_group_storage(&self,storage:&dyn Storage,scope:&GroupIdentity)->Result<(),Error> {
        if storage.scoped() {return Err(crate::cause!(Error::Conflict));}
        let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
        self.flush_group_notice(storage,scope)?;
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let proof=(|| {let Some(pending)=commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? else{return Ok(None);};
            let frame=commit_log::physical_commit(storage,&stream,pending.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Conflict))?;
            if commit_log::digest_of(&frame,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?!=pending.digest || !group_header_matches(&RecordStore::new(storage,Box::new(RealClock),self.records.limits(&storage,&self.records.path(&group_key(scope,&scope.resource(&self.owner)?)?))?)?,&self.owner,&scope)? {return Err(crate::cause!(Error::Conflict));}
            Ok(Some((pending,self.seal_commit(&scope,&frame,storage)?)))})();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let Some((pending,wire))=proof? else {
            group_key(scope,&scope.resource(&self.owner)?)?;
            self.refresh_group_materialized(scope)?;
            return Ok(());
        };
        let term=self.holding().ok_or(crate::cause!(Error::OutcomeUnknown))?;
        let placed=self.placed();let mark=placed.mark();let mut confirmed=HashSet::new();let mut ended=locked(&self.unreached).clone();
        let messages=placed.peers.iter().filter(|peer|placed.voters.contains(peer)||placed.may_answer_peers.contains(peer))
            .map(|peer|(peer.clone(),Message::Group {request:GroupRequest::Finalize {scope:scope.clone(),term,commit:wire.clone()}})).collect();
        let deadline=self.deadline_in(settings().ack_wait_ms);
        self.send_all(messages,deadline,&mut |peer,answer,_| {
            if matches!(answer,Some(Answer::Group {answer:GroupAnswer::Applied {through}}) if through>=pending.sequence) {confirmed.insert(peer.into());}
            ended.insert(peer.into());self.group_acknowledged(&confirmed,&ended)
        });
        if !self.group_acknowledged(&confirmed,&ended)||self.holding()!=Some(term)||self.placed().mark()!=mark {return Err(crate::cause!(Error::OutcomeUnknown));}
        storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;
        let published=(|| {
            match commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                Some(held) if held==pending=>{},
                None if commit_log::committed_through(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?>=pending.sequence=>return Ok(()),
                _=>return Err(crate::cause!(Error::Conflict)),
            }
            if opaque_map::map_info(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some() {
                opaque_map::update_opaque_map(storage,&stream,&wire.map.key.identity,&wire.map.delta,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            }
            commit_log::clear_pending(storage,&stream,pending.sequence,&pending.digest,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            commit_log::mark_notice(storage,&stream,pending.sequence,&pending.digest).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            commit_log::trim_through(storage,&stream,pending.sequence-1,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            Ok(())
        })();
        storage.close_scope(published.is_ok()).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;published?;
        self.flush_group_notice(storage,scope)?;
        group_key(scope,&scope.resource(&self.owner)?)?;
        self.refresh_group_materialized(scope)?;
        Ok(())
    }

    fn resolve_group_pending(&self,scope:&GroupIdentity)->Result<(),Error> {
        let key=group_key(scope,&scope.resource(&self.owner)?)?;let store=self.records.open(&key)?;let storage=&**store.storage();
        let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
        let Some(pending)=commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? else{return Ok(());};
        // A source-owned local transaction already committed; it must finish
        // postcommit quorum rather than ask itself to declare its own absence.
        if pending.source==self.me {
            if self.holding().is_some() {return self.finalize_group_storage(storage,scope);}
            let expected=self.observe_domain_head(scope)?.ok_or(crate::cause!(Error::OutcomeUnknown))?;
            if expected.through!=pending.sequence || expected.digest.as_deref()!=Some(pending.digest.as_str()) {return Err(crate::cause!(Error::OutcomeUnknown));}
            storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let result=(|| {
                let frame=commit_log::physical_commit(storage,&stream,pending.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Conflict))?;
                if commit_log::digest_of(&frame,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?!=pending.digest {return Err(crate::cause!(Error::Conflict));}
                commit_log::clear_pending(storage,&stream,pending.sequence,&pending.digest,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))
            })();
            storage.close_scope(result.is_ok()).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;result?;
            self.refresh_group_materialized(scope)?;return Ok(());
        }
        let mark=self.placed().mark();
        let Some(Answer::Group {answer:GroupAnswer::Resolved {sequence,digest,committed}})=self.send(&pending.source,
            &Message::Group {request:GroupRequest::Resolve {scope:scope.clone(),sequence:pending.sequence,digest:pending.digest.clone()}}) else{return Err(crate::cause!(Error::OutcomeUnknown));};
        if sequence!=pending.sequence||digest!=pending.digest||self.placed().mark()!=mark {return Err(crate::cause!(Error::Conflict));}
        storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result=(|| {
            if commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.as_ref()!=Some(&pending) {return Err(crate::cause!(Error::Conflict));}
            if committed {
                let opaque=commit_log::opaque_commit(storage,&stream,pending.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Conflict))?;
                self.apply_finalized_wire(&store,scope,&wire_from_opaque(&opaque)?,true)?;
                if commit_log::physical_commit(storage,&stream,pending.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some() {
                    commit_log::mark_notice(storage,&stream,pending.sequence,&pending.digest).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                }
            } else {commit_log::abort_prepared(storage,&stream,&pending,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;}
            Ok(())})();
        storage.close_scope(result.is_ok()).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;result?;
        self.flush_group_notice(storage,scope)?;
        self.refresh_group_materialized(scope)?;Ok(())
    }

    pub(super) fn abort_captured(&self,storage:&dyn Storage,domain:&GroupDomain,frame:&CapturedCommit)->Result<(),Error> {
        if storage.scoped() {return Err(crate::cause!(Error::Conflict));}
        let scope=domain.selection().identity();let stream=group_stream(&scope,&self.owner)?;let limits=group_limits()?;
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let absent=commit_log::physical_commit(storage,&stream,frame.sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
            .is_none_or(|actual|commit_log::digest_of(&actual,limits).ok()!=commit_log::digest_of(frame,limits).ok());
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !absent {return Err(crate::cause!(Error::Conflict));}
        let term=self.holding().ok_or(crate::cause!(Error::Unavailable))?;
        let digest=commit_log::digest_of(frame,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let peers=self.placed().peers.clone();let deadline=self.deadline_in(settings().ack_wait_ms);
        let messages=peers.iter().map(|peer|(peer.clone(),Message::Group {request:GroupRequest::Abort {scope:scope.clone(),term,sequence:frame.sequence,digest:digest.clone()}})).collect();
        let mut remaining=peers.len();
        self.send_all(messages,deadline,&mut |_,_,_|{remaining=remaining.saturating_sub(1);remaining==0});Ok(())
    }

    fn flush_group_notice(&self,storage:&dyn Storage,scope:&GroupIdentity)->Result<(),Error> {
        if storage.scoped() {return Err(crate::cause!(Error::Conflict));}
        let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let sampled=(|| {
            let Some((sequence,digest))=commit_log::notice(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? else{return Ok(None);};
            let frame=commit_log::physical_commit(storage,&stream,sequence,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Conflict))?;
            if commit_log::digest_of(&frame,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?!=digest {return Err(crate::cause!(Error::Conflict));}
            Ok(Some((sequence,digest,frame)))
        })();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let Some((sequence,digest,frame))=sampled? else{return Ok(());};
        let scope=serde_json::to_value(scope).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let events=frame.effects.iter().filter_map(|effect| {
            if effect.family!="versions" {return None;}
            let row=effect.row.as_ref()?;
            let [live_adopt::Cell::Text(account),live_adopt::Cell::Text(resource),live_adopt::Cell::Text(id),live_adopt::Cell::Integer(until),live_adopt::Cell::Integer(at),..]=row.as_slice() else{return None;};
            if account!=&self.owner || *until!=i64::MAX {return None;}
            let kind=match row.get(9) {Some(live_adopt::Cell::Text(kind))=>Some(kind.clone()),_=>None};
            Some(changes::Changed {resource:resource.clone(),scope:Some(scope.clone()),kind,id:id.clone(),sequence:*at})
        }).collect::<Vec<_>>();
        {
            // The registered native account owner owns this process's account
            // bus. Other transport copies (including a replaced old owner)
            // must not inject the same materialized frame into that bus.
            // Keep only this bounded memory publication under the registry
            // hold so replacement cannot race the identity check. No supply
            // or network operation runs under it.
            let local=locked(running());
            if local.get(&self.owner).and_then(Weak::upgrade)
                .is_some_and(|copies|std::ptr::eq(self,Arc::as_ref(&copies))) {
                let notifier=changes::AccountChanges::of(&self.owner).ok_or(crate::cause!(Error::Unavailable))?;
                notifier.publish(events);
            }
        }
        storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result=commit_log::clear_notice(storage,&stream,sequence,&digest,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error));
        storage.close_scope(result.is_ok()).map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))?;result
    }

    fn group_acknowledged(&self, confirmed: &HashSet<String>, ended: &HashSet<String>) -> bool {
        let placed = self.placed();
        let count = usize::from(placed.voters.contains(&self.me)) + placed.voters.iter().filter(|peer| **peer != self.me && confirmed.contains(*peer)).count();
        count * 2 > placed.voters.len() && placed.may_answer_peers.iter().filter(|peer| placed.peers.contains(peer)).all(|peer| confirmed.contains(peer) || ended.contains(peer))
    }

    fn token_key(&self,storage:&dyn Storage,scope:&GroupIdentity)->Result<(sealed::OpaqueTokenKey,WrappedKey),Error> {
        let stream=group_stream(scope,&self.owner)?;
        let roots=self.roots();
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;
        let at=At {owner:&self.owner,resource:&resource,id:"opaque-map-key/v1",version:0,from:0,part:Part::Value};
        let key=match opaque_map::wrapped_key(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
            Some(wrapped)=>sealed::OpaqueTokenKey::open(&roots,&at,&wrapped.envelope,&wrapped.identity).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
            None=>roots.mint_opaque_key(&self.owner,&stream).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        };
        let wrapped=WrappedKey {identity:key.identity(),envelope:key.wrap(&roots,&at).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?};
        if storage.writing().map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
            opaque_map::bind_wrapped_key(storage,&stream,&wrapped,group_limits()?).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
        }
        Ok((key,wrapped))
    }

    fn seal_map_row(&self,scope:&GroupIdentity,key:&sealed::OpaqueTokenKey,effect:&live_adopt::Effect,sequence:i64)->Result<OpaqueRow,Error> {
        let physical=serde_json::to_vec(&(&effect.family,&effect.key)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let token=key.token(&physical);
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;
        let id=serde_json::to_string(&("opaque-map-row/v1",key.identity(),&token)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at=At {owner:&self.owner,resource:&resource,id:&id,version:sequence,from:sequence,part:Part::Value};
        let value=serde_json::to_value(effect).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let payload=serde_json::to_vec(&sealed::seal_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(OpaqueRow {token,sequence,payload})
    }

    fn open_map_row(&self,scope:&GroupIdentity,key:&sealed::OpaqueTokenKey,row:&OpaqueRow)->Result<live_adopt::Effect,Error> {
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;
        let id=serde_json::to_string(&("opaque-map-row/v1",key.identity(),&row.token)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at=At {owner:&self.owner,resource:&resource,id:&id,version:row.sequence,from:row.sequence,part:Part::Value};
        let value=serde_json::from_slice(&row.payload).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let opened=sealed::open_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let effect:live_adopt::Effect=serde_json::from_value(opened).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if key.token(&serde_json::to_vec(&(&effect.family,&effect.key)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)!=row.token
            || effect.row.is_none() || opaque_map::is_transport_family(&effect.family) {return Err(crate::cause!(Error::Conflict));}
        Ok(effect)
    }

    fn seal_commit(&self, scope: &GroupIdentity, commit: &CapturedCommit, storage:&dyn Storage) -> Result<WireCommit, Error> {
        use base64::Engine;
        let limits=group_limits()?;
        let digest=commit_log::digest_of(commit,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (key,wrapped)=self.token_key(storage,scope)?;
        let mut updates=Vec::new();
        for effect in commit.effects.iter().filter(|effect|!opaque_map::is_transport_family(&effect.family)) {
            let row=self.seal_map_row(scope,&key,effect,commit.sequence)?;
            updates.push(OpaqueUpdate {token:row.token,payload:effect.row.as_ref().map(|_|row.payload)});
        }
        let map=WireMap {key:wrapped,delta:MapDelta {sequence:commit.sequence,digest:digest.clone(),updates}};
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;
        let id=serde_json::to_string(&("complete-frame/v1",&digest)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at=At {owner:&self.owner,resource:&resource,id:&id,version:commit.sequence,from:commit.sequence,part:Part::Value};
        // Authenticate the exact complete map delta without encrypting a
        // second copy of its ciphertext. The original physical frame remains
        // inside AEAD; a relay cannot substitute the committed map bytes.
        let map_digest=content_crypto::advanced::blake3::hash(&serde_json::to_vec(&map).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).to_hex().to_string();
        let value=serde_json::to_value(&(commit,&map_digest)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let sealed=sealed::seal_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let payload=serde_json::to_vec(&sealed).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(WireCommit {sequence:commit.sequence,digest,payload:base64::engine::general_purpose::STANDARD.encode(payload),map})
    }

    fn open_commit(&self, scope: &GroupIdentity, wire: &WireCommit) -> Result<CapturedCommit, Error> {
        use base64::Engine;
        opaque_commit(wire)?;
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;
        let id=serde_json::to_string(&("complete-frame/v1",&wire.digest)).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let at=At {owner:&self.owner,resource:&resource,id:&id,version:wire.sequence,from:wire.sequence,part:Part::Value};
        let payload=base64::engine::general_purpose::STANDARD.decode(&wire.payload).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let value=serde_json::from_slice(&payload).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let opened=sealed::open_value(&self.roots(),&at,&value).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let (commit,map_digest):(CapturedCommit,String)=serde_json::from_value(opened).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let expected_map_digest=content_crypto::advanced::blake3::hash(&serde_json::to_vec(&wire.map).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).to_hex().to_string();
        if commit.sequence!=wire.sequence || commit_log::digest_of(&commit,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?!=wire.digest || map_digest!=expected_map_digest {return Err(crate::cause!(Error::Conflict));}
        Ok(commit)
    }

    fn group_wire_page(&self, scope: &GroupIdentity, term: u64, storage: &dyn Storage, after: i64, preparing:bool) -> Result<GroupAnswer, Error> {
        let limits = group_limits()?;
        let stream = group_stream(scope, &self.owner)?;
        let bound = group_binding(scope, &self.owner)?;
        if commit_log::stream_binding(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.as_deref() != Some(bound.as_slice()) { return Err(crate::cause!(Error::Conflict)); }
        let front = commit_log::frontiers(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let root = scope.resource(&self.owner)?;
        let path = self.records.path(&group_key(scope, &root)?);
        let record_limits = self.records.limits(&storage, &path)?;
        let store = RecordStore::new(storage, Box::new(RealClock), record_limits)?;
        let (held_term, held_base) = store.accepted(&self.owner, &root)?;
        let base = if held_term == term { held_base } else { front.stored };
        let (mut commits, mut through, retained_from, mut further) = if front.stored > front.materialized && commit_log::pending(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_none() || self.roots().is_empty() {
            let page = commit_log::opaque_after(storage, &stream, after, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            (page.commits.iter().map(wire_from_opaque).collect::<Result<Vec<_>,_>>()?, page.through, page.retained_from, page.further)
        } else {
            let page = commit_log::commits_after(storage, &stream, after, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let commits = page.commits.iter().map(|commit| self.seal_commit(scope, commit, storage)).collect::<Result<Vec<_>,_>>()?;
            (commits, page.through, page.retained_from, page.further)
        };
        if !preparing {
            let committed=commit_log::committed_through(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if after>committed {return Err(crate::cause!(Error::Conflict));}
            commits.retain(|commit|commit.sequence<=committed);through=committed;
            further=commits.last().map_or(after,|commit|commit.sequence)<committed;
        }
        Ok(GroupAnswer::Page { term, base, commits, through, retained_from, further })
    }

    fn group_position(&self, scope:&GroupIdentity)->Result<(u64,commit_log::Frontiers),Error> {
        self.group_head(scope).map(|(term,front,_)|(term,front))
    }
    fn group_head(&self, scope: &GroupIdentity) -> Result<(u64, commit_log::Frontiers, Option<String>), Error> {
        self.group_snapshot(scope).map(|(term,front,digest,_)|(term,front,digest))
    }
    /// Read readiness and its committed prefix in this SAME qualified physical
    /// snapshot. Comparing two snapshots can turn an intervening valid commit
    /// into a false unmaterialized group and hide live account rows.
    fn group_snapshot(&self, scope: &GroupIdentity) -> Result<(u64, commit_log::Frontiers, Option<String>, i64), Error> {
        let key = group_key(scope, &scope.resource(&self.owner)?)?;
        let store = self.records.open(&key)?;
        let storage = &**store.storage();
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result = (|| {
            let stream = group_stream(scope, &self.owner)?;
            let expected = group_binding(scope, &self.owner)?;
            let limits = group_limits()?;
            let namespace = commit_log::stream_binding(storage, &scope.copy_namespace(&self.owner)?, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if namespace.as_deref().is_some_and(|binding| binding != expected.as_slice()) { return Err(crate::cause!(Error::Conflict)); }
            if let Some(header) = store.current_record(&self.owner,crate::local_account::own_records::IDENTITY,"command-domain")? {
                if header.value != serde_json::to_value(scope).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? { return Err(crate::cause!(Error::Conflict)); }
            }
            let binding = commit_log::stream_binding(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let front = commit_log::frontiers(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if binding.as_deref().is_some_and(|binding| binding != expected.as_slice()) || (front.stored > 0 && binding.is_none()) { return Err(crate::cause!(Error::Conflict)); }
            if front.materialized > 0 {
                if !group_header_matches(&store, &self.owner, scope)? { return Err(crate::cause!(Error::Conflict)); }
            }
            let committed=commit_log::committed_through(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            Ok((store.accepted_term(&self.owner, &scope.resource(&self.owner)?)?, front, commit_log::last_digest(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?, committed))
        })();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        result
    }

    fn mark_group_materialized(&self, key: &str, ready: bool) {
        let mut pending = locked(&self.unmaterialized_groups);
        if ready { pending.remove(key); } else { pending.insert(key.to_owned()); }
    }

    fn observe_domain_head(&self,scope:&GroupIdentity)->Result<Option<CurrentDomainHead>,Error> {
        let placed=self.placed();
        if !placed.may_answer || self.roots().is_empty(){return Err(crate::cause!(Error::Unavailable));}
        let row=self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
        if self.holding()==Some(row.term) && row.writer==self.me {return Ok(None);}
        if row.writer==self.me || row.expires_at_ms<=(self.clock)(){return Err(crate::cause!(Error::Unavailable));}
        let mark=placed.mark();
        let Some(Answer::Group {answer:GroupAnswer::Current {term,through,digest}})=self.send(&row.writer,
            &Message::Group {request:GroupRequest::Current {scope:scope.clone(),term:row.term}}) else{return Err(crate::cause!(Error::Unavailable));};
        if term!=row.term || through<0 || (through==0&&digest.is_some())
            || (through>0&&digest.as_deref().is_none_or(|value|value.len()!=64||!value.bytes().all(|byte|byte.is_ascii_digit()||(b'a'..=b'f').contains(&byte))))
            || self.placed().mark()!=mark || !self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?
                .is_some_and(|now|now.writer==row.writer&&now.term==row.term&&now.expires_at_ms>(self.clock)()) {return Err(crate::cause!(Error::Unavailable));}
        Ok(Some(CurrentDomainHead {through,digest}))
    }

    /// Authority is sampled before the read scope; frontier, digest and values
    /// are then checked in the very same physical snapshot.
    /// Reads a resource from this copy. A group this copy does not hold yet is fetched once from a computer that holds it,
    /// then read again; what is still missing refuses as before (`Unavailable`).
    fn with_group_read<T>(&self,resource:&str,read:impl Fn(&RecordStore<ComputerStore>)->Result<T,Error>)->Result<T,Error> {
        let result=self.read_group_held(resource,&read);
        match group_address(resource) {
            Some(address) if matches!(result,Err(Error::Unavailable(_))) && self.fetch_group_on_demand(&address) => self.read_group_held(resource,&read),
            _ => result,
        }
    }

    /// Pulls a group's snapshot from the writer, then from the other may-answer computers, for one bounded catch-up turn each
    /// (`catch_up_group`, whose sends wait `message_wait_ms`). A writer answers from its own copy and never fetches. Answers
    /// whether a computer took the turn; the caller reads again, and the read still refuses what is still missing.
    fn fetch_group_on_demand(&self,address:&GroupAddress)->bool {
        if self.holding().is_some() {return false;}
        let placed=self.placed();
        let mut holders:Vec<String>=self.writer_row().map(|(writer,_,_)|writer).into_iter().collect();
        holders.extend(placed.may_answer_peers.iter().cloned());
        holders.iter().filter(|computer|**computer!=self.me).any(|computer|self.catch_up_group(computer,&address.history,&address.resource,false,false).is_ok())
    }

    fn read_group_held<T>(&self,resource:&str,read:&impl Fn(&RecordStore<ComputerStore>)->Result<T,Error>)->Result<T,Error> {
        let address=group_address(resource);
        let expected=address.as_ref().map(|address|self.observe_domain_head(&address.history)).transpose()?.flatten();
        let store=self.records.open(resource)?;
        if address.is_none() {return read(&store);}
        let storage=&**store.storage();
        storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result=(|| {
            let scope=&address.as_ref().ok_or(crate::cause!(Error::Unavailable))?.history;
            let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
            let front=commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let digest=commit_log::last_digest(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if front.stored!=front.materialized || expected.is_some_and(|head|head.through!=front.materialized||head.digest!=digest)
                || !group_header_matches(&store,&self.owner,scope)? {return Err(crate::cause!(Error::Unavailable));}
            live_adopt::command_access(storage,&stream).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            read(&store)
        })();
        storage.close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;result
    }

    fn materialize_group_page(&self, scope: &GroupIdentity) -> Result<usize, Error> {
        self.resolve_group_pending(scope)?;
        let key = group_key(scope, &scope.resource(&self.owner)?)?;
        let store = self.records.open(&key)?;
        let storage = &**store.storage();
        let stream=group_stream(scope,&self.owner)?;
        if let Some(head)=opaque_map::map_head(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
            let info=opaque_map::map_info(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
            if !info.materialized {
                if self.roots().is_empty() || !self.placed().may_answer {return Ok(0);}
                let slot=self.group_target(&key)?;let mut target=locked(&slot);target.at=(self.clock)();
                if target.install.is_none() {target.install=Some(self.start_group_install(scope,&head)?);}
                if let Err(error)=self.step_group_install(&mut target) {target.install=None;return Err(error);}
                return Ok(1);
            }
        }
        // A current complete domain needs no write reservation. In particular,
        // a native caller may hold this domain's writer while another domain
        // and the account's lease renewal continue. Lagged domains still take
        // the original write path and recheck their frontier there.
        let (_,front,_,committed)=self.group_snapshot(scope)?;
        if front.materialized==committed {
            self.mark_group_materialized(&key,true);
            return Ok(0);
        }
        storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let outcome = (|| {
            let stream = group_stream(scope, &self.owner)?;
            let limits = group_limits()?;
            let front = commit_log::frontiers(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let committed=commit_log::committed_through(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            // A source may have committed a prepared frame AFTER pending
            // resolution or the fast read. Recheck under this reservation and
            // materialize only the finalized prefix, never that prepared frame.
            if front.materialized==committed { return Ok((0,true)); }
            if front.materialized>committed {return Err(crate::cause!(Error::Conflict));}
            let page = commit_log::opaque_after(storage, &stream, front.materialized, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let mut count=0;
            for frame in page.commits.into_iter().filter(|frame|frame.sequence<=committed) {
                count+=1;
                let wire = wire_from_opaque(&frame)?;
                let plain = self.open_commit(scope, &wire)?;
                commit_log::materialize_opaque(storage, &stream, &plain, limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            }
            if !group_header_matches(&store, &self.owner, scope)? { return Err(crate::cause!(Error::Conflict)); }
            let front = commit_log::frontiers(storage, &stream, limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            Ok((count, front.materialized == committed))
        })();
        match outcome {
            Ok((count, ready)) => {
                storage.close_scope(true).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                self.mark_group_materialized(&key, ready);
                Ok(count)
            }
            Err(error) => { let _ = storage.close_scope(false); Err(error) }
        }
    }

    fn group_stamps(&self, scope: &GroupIdentity) -> Result<Vec<(String,u64,i64)>, Error> {
        let (term, front) = self.group_position(scope)?;
        Ok(vec![(scope.resource(&self.owner)?, term, front.stored)])
    }

    fn answer_group(&self, from: &str, request: GroupRequest) -> Answer {
        if !self.group_inventory_supported.load(Ordering::Acquire) || !self.group_inventory_ready.load(Ordering::Acquire) { return refused("group_inventory_unavailable", crate::cause!()); }
        let scope = match &request { GroupRequest::Maintenance { scope, .. } | GroupRequest::Bootstrap {scope,..} | GroupRequest::BootstrapClose {scope,..} | GroupRequest::Probe { scope } | GroupRequest::Current {scope,..} | GroupRequest::TakeWriter {scope,..} | GroupRequest::Pull { scope, .. } | GroupRequest::Push { scope, .. }
            | GroupRequest::Prepare {scope,..} | GroupRequest::Finalize {scope,..} | GroupRequest::Abort {scope,..} | GroupRequest::Resolve {scope,..} => scope };
        let root = match scope.resource(&self.owner) { Ok(value) => value, Err(error) => { return refused("invalid_group", error.cause()) } };
        if self.records.state.as_ref().and_then(|state| placements::placement(&root).and_then(|row| row.in_state_for(&root,state))).is_none() { return refused("invalid_group", crate::cause!()); }
        match request {
            GroupRequest::Bootstrap {scope,writer,snapshot,ordinal}=>self.answer_group_bootstrap(from,&scope,writer,snapshot.as_deref(),ordinal),
            GroupRequest::BootstrapClose {scope,snapshot}=> {
                let slot=locked(&self.group_sources).get(from).cloned();
                if let Some(slot)=slot {let mut held=locked(&slot);if held.as_ref().is_some_and(|held|held.scope==scope && held.last.as_ref().is_some_and(|answer|matches!(answer,GroupAnswer::Bootstrap {page,..} if page.head.snapshot==snapshot))) {*held=None;}}
                Answer::Done
            },
            GroupRequest::Maintenance {scope,term,nonce,frame} => self.answer_maintenance(from,&scope,term,&nonce,&frame),
            GroupRequest::TakeWriter {scope,released_term}=> {
                let placed=self.placed();let now=(self.clock)();
                if !placed.may_answer || self.roots().is_empty() {return refused("group_writer_not_eligible", crate::cause!());}
                let already=self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row|row.writer==self.me&&row.term>released_term&&self.holding()==Some(row.term));
                if !already {
                    if !self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row|row.writer==from&&row.term==released_term
                        && row.expires_at_ms.saturating_add(settings().clock_margin_ms)<now) {return refused("group_writer_not_released", crate::cause!());}
                    if self.group_head(&scope).is_err() || !self.claim(now) {return refused("group_writer_not_current", crate::cause!());}
                }
                match self.holding() {Some(term)=>Answer::Group {answer:GroupAnswer::Writer {term}},None=>refused("group_writer_not_current", crate::cause!())}
            },
            GroupRequest::Current {scope,term} => {
                let current=|| self.placed().may_answer && !self.roots().is_empty() && self.holding()==Some(term)
                    && self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row|row.writer==self.me&&row.term==term);
                if !current(){return refused("group_writer_not_current", crate::cause!());}
                let (_,front,digest) = match self.group_head(&scope) { Ok(value) => value, Err(error) => return refused("group_identity_refused", crate::refusal_cause::Caused::cause(&error)) };
                if !current() || front.stored!=front.materialized {return refused("group_not_materialized", crate::cause!());}
                Answer::Group {answer:GroupAnswer::Current {term,through:front.materialized,digest}}
            },
            GroupRequest::Probe { scope } => match self.group_position(&scope) {
                Ok((_, front)) => Answer::Group { answer: GroupAnswer::Stamps { through: front.stored, materialized: front.materialized, retained_from: front.retained_from } },
                Err(error) => refused("group_identity_refused", crate::refusal_cause::Caused::cause(&error)),
            },
            GroupRequest::Push { scope,term,base,after,commits } => self.take_group(from,&scope,term,base,after,&commits,true,false),
            GroupRequest::Prepare {scope,term,base,after,commits}=>self.take_group(from,&scope,term,base,after,&commits,true,true),
            GroupRequest::Finalize {scope,term,commit}=>self.answer_group_finalize(from,&scope,term,&commit),
            GroupRequest::Abort {scope,term,sequence,digest}=>self.answer_group_abort(from,&scope,term,sequence,&digest),
            GroupRequest::Resolve {scope,sequence,digest}=>self.answer_group_resolve(from,&scope,sequence,&digest),
            GroupRequest::Pull { scope,writer,after } => {
                let term = if writer { match self.holding() { Some(term) => term, None => return refused("not_writer", crate::cause!(peer refusal)) } }
                    else { match self.group_position(&scope) { Ok((term,_)) => term, Err(error) => return refused("group_identity_refused", error.cause()) } };
                let key = match group_key(&scope,&root) { Ok(value) => value, Err(error) => { return refused("invalid_group", error.cause()) } };
                let store = match self.records.open(&key) { Ok(value) => value, Err(error) => { return refused("records_unavailable", error.cause()) } };
                let storage = &**store.storage();
                if let Err(error) = storage.open_scope(Intent::Read) { return refused("records_unavailable", error.cause()); }
                let page = self.group_wire_page(&scope,term,storage,after,false);
                let closed = storage.close_scope(false);
                if let Err(error) = closed { return refused("records_unavailable", error.cause()); }
                match page { Ok(answer) => Answer::Group { answer }, Err(error) => refused("group_bootstrap_required", error.cause()) }
            }
        }
    }

    fn take_group(&self, from: &str, scope: &GroupIdentity, term: u64, base: i64, after: i64, commits: &[WireCommit], writer: bool, preparing:bool) -> Answer {
        if after < 0 || base < 0 || commits.len() > group_limits().map_or(0,|limits|limits.page_rows)
            || commits.windows(2).any(|pair| pair[1].sequence != pair[0].sequence.saturating_add(1)) {
            return refused("invalid_group", crate::cause!(peer refusal));
        }
        if writer { if let Err(answer)=self.take_writer_identity(from,&self.id,(self.clock)(),term) { return answer; } }
        let root = match scope.resource(&self.owner) { Ok(value) => value, Err(error) => { return refused("invalid_group", error.cause()) } };
        let key = match group_key(scope,&root) { Ok(value) => value, Err(error) => { return refused("invalid_group", error.cause()) } };
        if let Some(slot)=locked(&self.group_targets).get(&key).cloned() {
            match slot.try_lock() {Ok(target) if target.install.is_none()=>{},_=>return refused("group_install_pending", crate::cause!())}
        }
        if let Ok(store)=self.records.open(&key) {
            let (Ok(stream),Ok(limits))=(group_stream(scope,&self.owner),group_limits()) else{return refused("group_preparation_unavailable", crate::cause!());};
            if commit_log::pending(&**store.storage(),&stream,limits).ok().flatten().is_some_and(|held|held.source!=from) {
                if let Err(error) = self.resolve_group_pending(scope) { return refused("group_preparation_unresolved", error.cause()); }
            }
        }
        let mut store = match self.records.open(&key) { Ok(value) => value, Err(error) => { return refused("records_unavailable", error.cause()) } };
        if let Err(error) = store.storage().open_scope(Intent::Write) { return refused("records_unavailable", error.cause()); }
        let notices=changes::HeldChanges::begin();
        let outcome=(|| -> Result<i64,Error> {
            let limits=group_limits()?; let stream=group_stream(scope,&self.owner)?;
            let bound=group_binding(scope,&self.owner)?;
            commit_log::bind_stream(&**store.storage(),&scope.copy_namespace(&self.owner)?,&bound,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            commit_log::bind_stream(&**store.storage(),&stream,&bound,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            let front=commit_log::frontiers(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            live_adopt::command_access(&**store.storage(),&stream).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            let floor=store.accepted_term(&self.owner,&root)?;
            if term < floor { return Err(crate::cause!(Error::Conflict)); }
            // A tail that the new writer did not hold needs proved rollback or
            // shadow bootstrap; never relabel a partial old state as current.
            if term > floor && front.stored > base { return Err(crate::cause!(Error::Conflict)); }
            if front.stored < after { return Err(crate::cause!(Error::Conflict)); }
            for wire in commits {
                let opaque=opaque_commit(wire)?;
                let committed=commit_log::committed_through(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                if wire.sequence<commit_log::frontiers(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.retained_from {continue;}
                if preparing && wire.sequence==commits.last().ok_or(crate::cause!(Error::Conflict))?.sequence && wire.sequence>committed {
                    if let Some(old)=commit_log::pending(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {
                        if old.source==from && old.term==term && old.sequence==wire.sequence && old.digest!=wire.digest {
                            commit_log::abort_prepared(&**store.storage(),&stream,&old,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                        }
                    }
                    if opaque_map::map_info(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_none()
                        && (self.roots().is_empty() || !group_header_matches(&store,&self.owner,scope)?) {
                        opaque_map::initialize_empty_opaque_map(&**store.storage(),&stream,&wire.map.key.identity,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                    }
                    opaque_map::bind_wrapped_key(&**store.storage(),&stream,&wire.map.key,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                    commit_log::align_opaque_base(&**store.storage(),&stream,wire.sequence-1,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                    commit_log::retain_opaque(&**store.storage(),&stream,&opaque,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                    commit_log::prepare(&**store.storage(),&stream,&commit_log::Pending {source:from.into(),term,sequence:wire.sequence,digest:wire.digest.clone(),base:wire.sequence-1},limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                } else {
                    self.apply_finalized_wire(&store,scope,wire,true)?;
                }
            }
            let front=commit_log::frontiers(&**store.storage(),&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if front.materialized > 0 && !group_header_matches(&store,&self.owner,scope)? { return Err(crate::cause!(Error::Conflict)); }
            store.take_term(&self.owner,&root,term,base)?;
            Ok(front.stored)
        })();
        match outcome {
            Ok(through) => {
                if let Err(error) = store.storage().close_scope(true) { return refused("group_commit_unconfirmed", error.cause()); }
                notices.published();
                if let Err(error)=self.refresh_group_materialized(scope) {return refused("group_commit_unconfirmed",error.cause());}
                locked(&self.resources).insert(key);
                Answer::Group { answer: GroupAnswer::Applied { through } }
            }
            Err(error) => { let _=store.storage().close_scope(false); refused("group_bootstrap_required", crate::refusal_cause::Caused::cause(&error)) }
        }
    }

    fn expire_group_sessions(&self,all:bool) {
        let now=(self.clock)();let mark=self.placed().mark();
        locked(&self.group_sources).retain(|_,slot|slot.try_lock().map_or(true,|held|
            !all && held.as_ref().is_some_and(|source|source.mark==mark && now.saturating_sub(source.at)<=settings().part_hold_ms)));
        locked(&self.group_targets).retain(|_,slot|slot.try_lock().map_or(true,|held|
            !all && now.saturating_sub(held.at)<=settings().part_hold_ms));
    }

    fn group_target(&self,key:&str)->Result<Arc<Mutex<GroupSnapshotTarget>>,Error> {
        let now=(self.clock)();let mut slots=locked(&self.group_targets);
        slots.retain(|_,slot|slot.try_lock().map_or(true,|held|now.saturating_sub(held.at)<=settings().part_hold_ms));
        if let Some(slot)=slots.get(key) {return Ok(slot.clone());}
        if slots.len()>=settings().limits.most_admitted_computers as usize {return Err(crate::cause!(Error::Unavailable));}
        let slot=Arc::new(Mutex::new(GroupSnapshotTarget {at:now,..GroupSnapshotTarget::default()}));slots.insert(key.into(),slot.clone());Ok(slot)
    }

    fn answer_group_bootstrap(&self,from:&str,scope:&GroupIdentity,writer:bool,snapshot:Option<&str>,ordinal:u64)->Answer {
        let outcome=(||->Result<GroupAnswer,Error> {
            let now=(self.clock)();let mark=self.placed().mark();
            let slot={let mut slots=locked(&self.group_sources);
                slots.retain(|_,slot|slot.try_lock().map_or(true,|held|held.as_ref().is_some_and(|held|now.saturating_sub(held.at)<=settings().part_hold_ms)));
                if let Some(slot)=slots.get(from) {slot.clone()}else{
                    if slots.len()>=settings().limits.most_admitted_computers as usize {return Err(crate::cause!(Error::Unavailable));}
                    let slot=Arc::new(Mutex::new(None));slots.insert(from.into(),slot.clone());slot
                }};
            let mut held=locked(&slot);
            if held.as_ref().is_some_and(|held|held.mark!=mark || now.saturating_sub(held.at)>settings().part_hold_ms) {*held=None;}
            if held.as_ref().is_some_and(|old|old.store.is_none() && old.last.is_none()
                || snapshot.is_none() && ordinal==0 && old.last.as_ref().is_some_and(|answer|matches!(answer,GroupAnswer::Bootstrap {page,..} if page.ordinal>0))) {*held=None;}
            if let Some(old)=held.as_ref() {
                if old.scope!=*scope || old.writer!=writer {
                    if snapshot.is_none() && old.store.is_none() {*held=None;}else{return Err(crate::cause!(Error::Conflict));}
                }
            }
            if held.is_none() {
                if snapshot.is_some() || ordinal!=0 {return Err(crate::cause!(Error::Conflict));}
                let root=scope.resource(&self.owner)?;let resource=group_key(scope,&root)?;
                let store=self.records.open(&resource)?;let storage=&**store.storage();
                let key=if !self.roots().is_empty() {
                    storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                    let result=self.token_key(storage,scope);let closed=storage.close_scope(result.is_ok());
                    let (key,wrapped)=result?;closed.map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;(Some(key),wrapped)
                }else{
                    (None,opaque_map::wrapped_key(storage,&group_stream(scope,&self.owner)?,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?)
                };
                storage.open_scope(Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                let built=(||->Result<_,Error>{
                    let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
                    if commit_log::stream_binding(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.as_deref()!=Some(group_binding(scope,&self.owner)?.as_slice()) {return Err(crate::cause!(Error::Conflict));}
                    let (accepted,base)=store.accepted(&self.owner,&root)?;
                    let term=if writer {self.holding().ok_or(crate::cause!(Error::Unavailable))?}else{accepted};
                    if term==0 {return Err(crate::cause!(Error::Unavailable));}
                    let mut nonce=vec![0;content_crypto::advanced::blake3::OUT_LEN];
                    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(),&mut nonce).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                    let snapshot=format!("{}:{}",self.me,base64_of(&nonce));
                    let cursor=if let Some(token)=key.0 {
                        if !group_header_matches(&store,&self.owner,scope)? {return Err(crate::cause!(Error::Conflict));}
                        GroupSnapshotCursor::Physical(opaque_map::PhysicalCursor::begin(storage,&stream,&key.1.identity,&snapshot,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,token)
                    }else{
                        GroupSnapshotCursor::Opaque(opaque_map::MapCursor::begin(storage,&stream,&snapshot,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)
                    };
                    Ok((cursor,term,base))
                })();
                let (cursor,term,base)=match built {Ok(value)=>value,Err(error)=>{let _=storage.close_scope(false);return Err(error);}};
                *held=Some(GroupSnapshotSource {store:Some(store),cursor,scope:scope.clone(),writer,term,base,mark,at:now,key:key.1,last:None});
            }
            let source=held.as_mut().ok_or(crate::cause!(Error::Unavailable))?;
            let current=|| self.placed().mark()==source.mark && if source.writer {self.holding()==Some(source.term)}else{self.group_position(scope).is_ok_and(|(term,_)|term==source.term)};
            if !current() {return Err(crate::cause!(Error::Unavailable));}
            if let Some(GroupAnswer::Bootstrap {page,..})=&source.last {
                if snapshot.is_some_and(|snapshot|snapshot!=page.head.snapshot) {return Err(crate::cause!(Error::Conflict));}
                if ordinal==page.ordinal {return Ok(source.last.clone().ok_or(crate::cause!(Error::Unavailable))?);}
                if page.done || ordinal!=page.ordinal.checked_add(1).ok_or(crate::cause!(Error::Unavailable))? {return Err(crate::cause!(Error::Conflict));}
            }else if ordinal!=0 {return Err(crate::cause!(Error::Conflict));}
            let store=source.store.as_ref().ok_or(crate::cause!(Error::Unavailable))?;let storage=&**store.storage();
            let page=match match &mut source.cursor {
                GroupSnapshotCursor::Physical(cursor,key)=>cursor.page(storage,&mut |effect,sequence|self.seal_map_row(scope,key,effect,sequence).map_err(|error| crate::carry_cause!(crate::storage::Error::Invalid, error))),
                GroupSnapshotCursor::Opaque(cursor)=>cursor.page(storage),
            } {Ok(page)=>page,Err(_)=>{
                if let Some(store)=source.store.take() {let _=store.storage().close_scope(false);}
                source.last=None;return Err(crate::cause!(Error::Unavailable));
            }};
            let storage=&**source.store.as_ref().ok_or(crate::cause!(Error::Unavailable))?.storage();
            let seal=if page.done {Some(match &source.cursor {GroupSnapshotCursor::Physical(cursor,_)=>cursor.seal(storage),GroupSnapshotCursor::Opaque(cursor)=>cursor.seal(storage)}.map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)}else{None};
            if !current() {return Err(crate::cause!(Error::Unavailable));}
            let answer=GroupAnswer::Bootstrap {term:source.term,base:source.base,key:source.key.clone(),page,seal};
            source.last=Some(answer.clone());
            if matches!(&answer,GroupAnswer::Bootstrap {seal:Some(_),..}) {
                if let Some(store)=source.store.take() {store.storage().close_scope(false).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;}
            }
            Ok(answer)
        })();
        match outcome {Ok(answer)=>Answer::Group {answer},Err(error)=>refused("group_bootstrap_unavailable", crate::refusal_cause::Caused::cause(&error))}
    }

    fn retired_replica_authority(&self,scope:&GroupIdentity,storage:&dyn Storage)->Result<Option<crate::local_account::NativeDomainAuthority>,Error> {
        let stream=group_stream(scope,&self.owner)?;
        if live_adopt::command_access(storage,&stream).is_ok() {return Ok(None);}
        let Some(handler)=&self.domain_maintenance else{return Err(crate::cause!(Error::Conflict));};
        let authority=handler.replica_authority(scope)?.ok_or(crate::cause!(Error::Conflict))?;
        let staged=authority.registration().staged.as_ref().ok_or(crate::cause!(Error::Conflict))?;
        if !staged.activated || authority.current_incarnation()!=staged.target_incarnation {return Err(crate::cause!(Error::Conflict));}
        let limits=self.records.limits(&storage,&self.records.path(&group_key(scope,&scope.resource(&self.owner)?)?))?;
        let store=RecordStore::new(storage,Box::new(RealClock),limits)?;
        if !group_header_matches(&store,&self.owner,scope)? {return Err(crate::cause!(Error::Conflict));}
        let physical=crate::local_account::own_records::domain_authority(&store,&self.owner,scope)?;
        if physical==authority.current_incarnation() {return Err(crate::cause!(Error::Conflict));}
        Ok(Some(authority))
    }

    fn start_group_install(&self,scope:&GroupIdentity,head:&opaque_map::MapHead)->Result<GroupSnapshotInstall,Error> {
        let key=group_key(scope,&scope.resource(&self.owner)?)?;let store=self.records.open(&key)?;
        let storage=&**store.storage();storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let result=(|| {
            let stream=group_stream(scope,&self.owner)?;let limits=group_limits()?;
            let retired=self.retired_replica_authority(scope,storage)?.is_some();
            let cursor=if self.placed().may_answer && !self.roots().is_empty() {
                let (key,_)=self.token_key(storage,scope)?;
                GroupInstallCursor::Plain(if retired {opaque_map::MaterializationCursor::begin_retired(storage,&stream,limits)}else{opaque_map::MaterializationCursor::begin(storage,&stream,limits)}.map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,key)
            }else{GroupInstallCursor::Opaque(opaque_map::OpaqueInstallCursor::begin(storage,&stream,head,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?)};
            Ok((cursor,retired))
        })();
        let (cursor,retired)=match result {Ok(value)=>value,Err(error)=>{let _=storage.close_scope(false);return Err(error);}};
        Ok(GroupSnapshotInstall {store,cursor:Some(cursor),scope:scope.clone(),mark:self.placed().mark(),at:(self.clock)(),retired})
    }

    fn step_group_install(&self,target:&mut GroupSnapshotTarget)->Result<bool,Error> {
        let Some(install)=target.install.as_mut() else{return Ok(true);};
        if self.placed().mark()!=install.mark || (self.clock)().saturating_sub(install.at)>settings().part_hold_ms {target.install=None;return Err(crate::cause!(Error::Unavailable));}
        let storage=&**install.store.storage();
        let done=match install.cursor.as_mut().ok_or(crate::cause!(Error::Unavailable))? {
            GroupInstallCursor::Plain(cursor,key)=>{
                if self.roots().is_empty() || !self.placed().may_answer {return Err(crate::cause!(Error::Unavailable));}
                cursor.step(storage,&mut |row|self.open_map_row(&install.scope,key,row).map_err(|error| crate::carry_cause!(crate::storage::Error::Invalid, error)))
            },
            GroupInstallCursor::Opaque(cursor)=>cursor.step(storage),
        }.map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !done {return Ok(false);}
        match install.cursor.take().ok_or(crate::cause!(Error::Unavailable))? {
            GroupInstallCursor::Plain(cursor,_)=>{cursor.finish(storage).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;},
            GroupInstallCursor::Opaque(cursor)=>cursor.finish(storage).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?,
        }
        if self.placed().mark()!=install.mark {return Err(crate::cause!(Error::Unavailable));}
        let repair_permit=if install.retired {
            let handler=self.domain_maintenance.as_ref().ok_or(crate::cause!(Error::Conflict))?;
            let authority=handler.replica_authority(&install.scope)?.ok_or(crate::cause!(Error::Conflict))?;
            let permit=authority.hold_native(authority.current_incarnation()).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            let token=crate::local_account::own_records::domain_authority(&install.store,&self.owner,&install.scope)?;
            if token!=authority.current_incarnation() {return Err(crate::cause!(Error::Conflict));}
            Some(permit)
        }else{None};
        if storage.close_scope(true).is_err() {if let Some(permit)=&repair_permit {permit.mark_outcome_unknown();}return Err(crate::cause!(Error::Unavailable));}
        drop(repair_permit);
        let scope=install.scope.clone();target.install=None;
        let key=group_key(&scope,&scope.resource(&self.owner)?)?;
        let (_,front)=self.group_position(&scope)?;self.mark_group_materialized(&key,front.stored==front.materialized);
        Ok(true)
    }

    fn receive_group_bootstrap(&self,computer:&str,scope:&GroupIdentity,writer:bool,target:&mut GroupSnapshotTarget)->Result<i64,Error> {
        let now=(self.clock)();
        if target.receive.as_ref().is_some_and(|held|held.computer!=computer || held.scope!=*scope || held.writer!=writer || held.mark!=self.placed().mark() || now.saturating_sub(held.at)>settings().part_hold_ms) {target.receive=None;}
        let request=GroupRequest::Bootstrap {scope:scope.clone(),writer,
            snapshot:target.receive.as_ref().map(|held|held.head.snapshot.clone()),ordinal:target.receive.as_ref().map_or(0,|held|held.next)};
        let Some(Answer::Group {answer:GroupAnswer::Bootstrap {term,base,key,page,seal}})=self.send(computer,&Message::Group {request}) else {target.receive=None;return Err(crate::cause!(Error::Unavailable));};
        if page.head.token_key_identity!=key.identity || page.done!=seal.is_some() {return Err(crate::cause!(Error::Conflict));}
        if writer {if self.take_writer_identity(computer,&self.id,now,term).is_err(){return Err(crate::cause!(Error::Conflict));}}
        if let Some(held)=&target.receive {if term!=held.term || base!=held.base || held.head!=page.head || held.next!=page.ordinal {return Err(crate::cause!(Error::Conflict));}}
        else if page.ordinal!=0 {return Err(crate::cause!(Error::Conflict));}
        let resource=group_key(scope,&scope.resource(&self.owner)?)?;let store=self.records.open(&resource)?;let storage=&**store.storage();
        storage.open_scope(Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let applied=(||->Result<bool,Error>{
            let stream=group_stream(scope,&self.owner)?;let bound=group_binding(scope,&self.owner)?;let limits=group_limits()?;
            commit_log::bind_stream(storage,&scope.copy_namespace(&self.owner)?,&bound,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            commit_log::bind_stream(storage,&stream,&bound,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            if term<store.accepted_term(&self.owner,&scope.resource(&self.owner)?)? {return Err(crate::cause!(Error::Conflict));}
            self.retired_replica_authority(scope,storage)?;
            let front=commit_log::frontiers(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            if front.stored>page.head.through {return Err(crate::cause!(Error::Conflict));}
            if !opaque_map::retire_map_step(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {return Ok(false);}
            if target.receive.is_none() && !opaque_map::discard_map_bootstrap_step(storage,&stream,limits).map_err(|error| crate::carry_cause!(Error::Unavailable, error))? {return Ok(false);}
            opaque_map::bind_wrapped_key(storage,&stream,&key,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            opaque_map::begin_map_bootstrap(storage,&stream,&page.head,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            opaque_map::append_map_page(storage,&stream,&page,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
            if let Some(seal)=&seal {
                opaque_map::finish_map_bootstrap(storage,&stream,seal,limits).map_err(|error| crate::carry_cause!(Error::Conflict, error))?;
                let record_limits=self.records.limits(&storage,&self.records.path(&resource))?;
                let mut records=RecordStore::new(storage,Box::new(RealClock),record_limits)?;
                records.take_term(&self.owner,&scope.resource(&self.owner)?,term,base)?;
            }
            Ok(true)
        })();
        storage.close_scope(applied.is_ok()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !applied? {return Ok(self.group_position(scope)?.1.stored);}
        target.at=now;
        if let Some(seal)=seal {
            target.receive=None;self.mark_group_materialized(&resource,false);locked(&self.resources).insert(resource.clone());
            // All sealed pages are durable; no source scope is needed while
            // authenticating/publishing target plaintext in bounded turns.
            let _=self.send(computer,&Message::Group {request:GroupRequest::BootstrapClose {scope:scope.clone(),snapshot:seal.head.snapshot.clone()}});
            target.retry_bootstrap=false;
            target.install=Some(self.start_group_install(scope,&seal.head)?);
            self.step_group_install(target)?;
        }else{target.receive=Some(GroupSnapshotReceive {computer:computer.into(),scope:scope.clone(),writer,term,base,mark:self.placed().mark(),at:now,head:page.head,next:page.ordinal.checked_add(1).ok_or(crate::cause!(Error::Unavailable))?});}
        Ok(self.group_position(scope)?.1.stored)
    }

    fn receive_group_bootstrap_checked(&self,computer:&str,scope:&GroupIdentity,writer:bool,target:&mut GroupSnapshotTarget)->Result<i64,Error> {
        let result=self.receive_group_bootstrap(computer,scope,writer,target);
        if result.is_err() {
            target.install=None;target.retry_bootstrap=true;
            if let Some(held)=target.receive.take() {let _=self.send(&held.computer,&Message::Group {request:GroupRequest::BootstrapClose {scope:held.scope,snapshot:held.head.snapshot}});}
        }
        result
    }

    #[cfg(test)]
    pub(super) fn catch_up_group_control(&self,computer:&str,scope:&GroupIdentity,writer:bool)->Result<i64,Error> {
        self.catch_up_group(computer,scope,&scope.resource(&self.owner)?,writer,true)
    }

    /// One bounded catch-up turn for a group. `bootstrap` is the writer's or a sync's turn, which may continue a snapshot bootstrap
    /// or install. A read's fetch (`bootstrap` false) never continues one another turn started (it would reset that cursor); it may
    /// apply a complete delta or start a bootstrap only when none is in progress.
    fn catch_up_group(&self, computer: &str, scope: &GroupIdentity, _member: &str, writer: bool, bootstrap: bool) -> Result<i64, Error> {
        let key=group_key(scope,&scope.resource(&self.owner)?)?;let slot=self.group_target(&key)?;let mut target=locked(&slot);target.at=(self.clock)();
        if !bootstrap && (target.install.is_some() || target.receive.is_some() || target.retry_bootstrap) {
            return Err(crate::cause!(Error::Unavailable));
        }
        // Continue an unpublished replacement before consulting the old image:
        // its exact writer scope intentionally remains held across bounded turns.
        if target.install.is_some() {
            if let Err(error)=self.step_group_install(&mut target) {target.install=None;target.retry_bootstrap=true;return Err(error);}
            return Ok(self.group_position(scope)?.1.stored);
        }
        if target.receive.is_some() {return self.receive_group_bootstrap_checked(computer,scope,writer,&mut target);}
        drop(target);
        let resolution=self.resolve_group_pending(scope);
        let replace_source_pending=if resolution.is_err() && writer {
            let store=self.records.open(&key)?;let storage=&**store.storage();let stream=group_stream(scope,&self.owner)?;
            let held=commit_log::pending(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            // A source that lost its writer role, or a peer that missed
            // finalization, can be behind a newer canonical cut after the
            // original committed frame has left retained history.
            // Do not infer inclusion or clear the fence from a larger number:
            // only the complete authenticated current-writer snapshot may
            // replace this old image, clearing Pending in the same publication.
            if let Some(held)=held {
                self.observe_domain_head(scope)?.is_some_and(|head|head.through>=held.sequence)
                    && self.writer_rows.read(&self.id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|row|
                        row.writer==computer && row.writer!=self.me && row.expires_at_ms>(self.clock)())
            }else{false}
        }else{false};
        if !replace_source_pending {resolution?;}
        let mut target=locked(&slot);target.at=(self.clock)();
        if replace_source_pending {target.retry_bootstrap=true;}
        if target.retry_bootstrap {return self.receive_group_bootstrap_checked(computer,scope,writer,&mut target);}
        if self.placed().may_answer && !self.roots().is_empty() {
            let store=self.records.open(&key)?;let storage=&**store.storage();let stream=group_stream(scope,&self.owner)?;
            if opaque_map::map_info(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_some_and(|info|!info.materialized) {
                let head=opaque_map::map_head(storage,&stream,group_limits()?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.ok_or(crate::cause!(Error::Unavailable))?;
                target.install=Some(self.start_group_install(scope,&head)?);
                if let Err(error)=self.step_group_install(&mut target) {target.install=None;target.retry_bootstrap=true;return Err(error);}
                return Ok(self.group_position(scope)?.1.stored);
            }
        }
        let (_,front)=self.group_position(scope)?;
        // Ordinary receive takes this same short session gate to exclude an
        // unpublished install. Do not retain it across our Pull/take_group,
        // otherwise the caller refuses its own in-retention delta page.
        drop(target);
        if let Some(Answer::Group { answer:GroupAnswer::Page { term,base,commits,.. } }) =
            self.send(computer,&Message::Group { request:GroupRequest::Pull { scope:scope.clone(),writer,after:front.stored } }) {
            if let Answer::Group { answer:GroupAnswer::Applied { through } } =
                self.take_group(computer,scope,term,base,front.stored,&commits,writer,false) { return Ok(through); }
        }
        let mut target=locked(&slot);target.at=(self.clock)();
        if !bootstrap && (target.install.is_some() || target.receive.is_some() || target.retry_bootstrap) {return Err(crate::cause!(Error::Unavailable));}
        // Another bounded turn can win while the Pull is out. Continue its
        // actual held install instead of starting a second replacement.
        if target.install.is_some() {
            if let Err(error)=self.step_group_install(&mut target) {target.install=None;target.retry_bootstrap=true;return Err(error);}
            return Ok(self.group_position(scope)?.1.stored);
        }
        self.receive_group_bootstrap_checked(computer,scope,writer,&mut target)
    }

    /// The acknowledgement itself, on the write's open store: `read` reads it, `write` records a first term's base in
    /// it (the same store; a file write lends its one transaction twice). `file` is the store's file, to name which
    /// resource key a further store is.
    fn acknowledge_on(&self, read: &dyn Storage, write: &dyn Storage, file: Option<PathBuf>, resources: &[String]) -> WriterResult<()> {
        let now = (self.clock)();
        let term = locked(&self.writer_role).holding(now).ok_or(crate::cause!(WriterError::NotWriter))?;
        if !self.writer_rows.read(&self.id)?.is_some_and(|row| row.writer == self.me && row.term == term) {
            return Err(crate::cause!(WriterError::NotWriter));
        }
        let limits = match resources.first() {
            Some(resource) => self.records.limits(&read, &self.records.path(resource)).map_err(|error| WriterError::Storage(error.cause()))?,
            None => self.records.limits(&read, &self.records.records).map_err(|error| WriterError::Storage(error.cause()))?,
        };
        let store: OpenWrite<'_> = RecordStore::new(Box::new(read) as Box<dyn Storage + '_>, Box::new(RealClock), limits).map_err(|error| WriterError::Storage(error.cause()))?;
        // Each resource the write changed, by its copy key: the store this write is open on names which one (a further
        // store of a volume is its own key, `Stores::key_of`). A file that is no store of the resource here keeps the
        // resource's own name, as every write did before.
        let keys: Vec<String> = resources.iter()
            .map(|resource| file.as_deref().and_then(|file| self.records.key_of(file, resource)).unwrap_or_else(|| resource.clone()))
            .collect();
        let resources = &keys;
        let mut written = Vec::new();
        for resource in resources {
            written.push((resource.clone(), store.stamp(&self.owner, &named(resource)).map_err(|error| WriterError::Storage(error.cause()))?));
            locked(&self.resources).insert(resource.clone());
        }
        // A resource first written under this term: its base is the stamp this computer held before the write (what is
        // committed), kept with the write itself, so it is there exactly when the write is.
        for resource in resources {
            if store.accepted_term(&self.owner, &named(resource)).map_err(|error| WriterError::Storage(error.cause()))? < term {
                let committed = self.records.stamp(resource).map_err(|error| WriterError::Storage(error.cause()))?;
                let mut writer = RecordStore::new(Box::new(write) as Box<dyn Storage + '_>, Box::new(RealClock), limits).map_err(|error| WriterError::Storage(error.cause()))?;
                writer.take_term(&self.owner, &named(resource), term, committed).map_err(|error| WriterError::Storage(error.cause()))?;
            }
        }
        if written.is_empty() {
            // Nothing changed: nothing to acknowledge, but the writer turn must still be held.
            return locked(&self.writer_role).holding((self.clock)()).map(|_| ()).ok_or(crate::cause!(WriterError::NotWriter));
        }
        {
            // The voters first: a write counts once this computer and the voters that hold it are a majority of the
            // voters, and every other computer that may answer holds it too or could not be reached: a computer that may
            // answer takes the writer turn next, so an acknowledged write held only by a computer that keeps a copy was
            // lost from every computer that may answer once the writer died (measured 2026-11-03 by the second-computer lane).
            // A computer that neither votes nor may answer pulls what it holds.
            // Every such computer at once, each page on its own thread (`send_all`): one that does not answer, first in
            // the order or not, delays no other. Reads stay on this thread, in the write's own open transaction.
            let deadline = self.deadline_in(settings().ack_wait_ms);
            let placed = self.placed();
            let mut states: HashMap<String, PushState> = HashMap::new();
            // The computers whose push ended (each holds the write, or could not take it before the deadline), and those
            // the last write could not reach, which this one does not wait for.
            let mut ended: HashSet<String> = locked(&self.unreached).clone();
            let mut first = Vec::new();
            for peer in placed.peers.iter().filter(|peer| placed.voters.contains(peer) || placed.may_answer_peers.contains(peer)) {
                let mut state = PushState::default();
                match self.push_next(peer, term, &store, &written, &mut state, deadline) {
                    Next::Send(message) => first.push((peer.clone(), message)),
                    Next::Done | Next::Failed => {
                        ended.insert(peer.clone());
                    }
                }
                states.insert(peer.clone(), state);
            }
            if first.is_empty() && !self.majority_holds(&written) {
                crate::quiet_eprintln!("computers-writer event=push-not-sent cause={}", crate::cause!(writer no_push_or_voting_majority));
            }
            if !self.acknowledged_by(&written, &ended) {
                self.send_all(first, deadline, &mut |peer, answer, more| {
                    let Some(state) = states.get_mut(peer) else { return false };
                    let mut going = false;
                    if self.push_answered(peer, term, &store, &written, state, answer, deadline) {
                        if let Next::Send(message) = self.push_next(peer, term, &store, &written, state, deadline) {
                            more.push((peer.to_string(), message));
                            going = true;
                        }
                    }
                    if !going {
                        ended.insert(peer.to_string());
                    }
                    self.acknowledged_by(&written, &ended)
                });
            }
            let heard = locked(&self.heard);
            let holds = |peer: &String| written.iter().all(|(resource, stamp)| heard.get(&(peer.clone(), resource.clone())).is_some_and(|held| held >= stamp));
            let mut unreached = locked(&self.unreached);
            for peer in placed.may_answer_peers.iter().filter(|peer| placed.peers.contains(peer)) {
                if holds(peer) {
                    unreached.remove(peer);
                } else if ended.contains(peer) {
                    unreached.insert(peer.clone());
                }
            }
        }
        let _proof = locked(&self.ack_proof);
        *locked(&self.pending) = written.clone();
        let top = written.iter().map(|(_, stamp)| *stamp).max().unwrap_or(0);
        let result = locked(&self.writer_role).commit((self.clock)(), &self.writer_rows, self, || Ok(((), top)));
        if let Err(error) = &result {
            crate::quiet_eprintln!("computers-writer event=not-acknowledged cause={}", error.cause());
        }
        locked(&self.pending).clear();
        result
    }

    /// Send `peer` every change of `written` it does not hold, in pages, from the stamp it holds. True once it holds
    /// every written stamp. One peer at a time; the writer's acknowledgement sends to every peer at once
    /// (`acknowledge`, through `push_next` and `push_answered`).
    #[allow(dead_code)]
    fn push_to(&self, peer: &str, term: u64, store: &OpenWrite<'_>, written: &[(String, i64)], deadline: i64) -> bool {
        let mut state = PushState::default();
        loop {
            let message = match self.push_next(peer, term, store, written, &mut state, deadline) {
                Next::Send(message) => message,
                Next::Done => return true,
                Next::Failed => return false,
            };
            let answer = self.send(peer, &message);
            if !self.push_answered(peer, term, store, written, &mut state, answer, deadline) {
                return false;
            }
        }
    }

    /// The next page of `written` to send `peer` (`push_to`'s step): the message, or that it holds every written
    /// stamp, or that sending it failed. Reads from the write's own open transaction, on the writer's thread.
    fn push_next(&self, peer: &str, term: u64, store: &OpenWrite<'_>, written: &[(String, i64)], state: &mut PushState, deadline: i64) -> Next {
        loop {
            let Some((resource, target)) = written.get(state.resource) else { return Next::Done };
            if !state.started {
                state.after = match self.heard(peer, resource) {
                    Some(stamp) => stamp,
                    None => self.records.stamp(resource).unwrap_or(0),
                };
                state.limit = settings().feed_page_items;
                // The versions in between each change carries; none when even one change with them does not fit a
                // message (the copy then asks for them page by page, `Answer::Needs`).
                state.history = settings().feed_history_items;
                state.needed = None;
                state.started = true;
            }
            if self.heard(peer, resource).is_some_and(|stamp| stamp >= *target) {
                state.resource += 1;
                state.started = false;
                continue;
            }
            if self.waiting.now_ms() >= deadline {
                return Next::Failed;
            }
            let Ok((items, more)) = store.carried_page(&self.owner, &named(resource), state.after, state.limit, state.history) else { return Next::Failed };
            let last = items.last().map(|carried| carried.change.sequence);
            let held = items.len();
            let single = held == 1 && state.history == 0;
            // A computer that only holds a copy gets every value sealed; with no root to seal under, it gets nothing.
            let Some(items) = self.for_peer(peer, resource, items) else { return Next::Failed };
            let message = Message::Push { term, resource: resource.clone(), after: state.after, changes: items, base: self.base_of(term, resource) };
            if !fits_message(&message, single) {
                if held > 1 {
                    // Half of what the page held (not of the limit), so a page of one long change is not read and
                    // sealed again for each halving.
                    state.limit = (held / 2).max(1);
                } else if state.history > 0 {
                    state.history = 0;
                } else {
                    return Next::Failed;
                }
                continue;
            }
            state.more = more;
            state.last = last;
            return Next::Send(message);
        }
    }

    /// What `peer` answered to the page `push_next` gave (`push_to`'s step): false when pushing to it failed.
    #[allow(clippy::too_many_arguments)]
    fn push_answered(&self, peer: &str, term: u64, store: &OpenWrite<'_>, written: &[(String, i64)], state: &mut PushState, answer: Option<Answer>, deadline: i64) -> bool {
        let Some((resource, target)) = written.get(state.resource) else { return true };
        match answer {
            Some(Answer::Applied { stamp }) => {
                self.hear(peer, resource, stamp);
                if stamp >= *target {
                    state.resource += 1;
                    state.started = false;
                    return true;
                }
                match (state.more, state.last) {
                    (true, Some(last)) => {
                        state.after = last;
                        true
                    }
                    _ => false,
                }
            }
            Some(Answer::Behind { stamp }) if stamp < state.after => {
                self.hear(peer, resource, stamp);
                state.after = stamp;
                true
            }
            Some(Answer::Needs { stamp, id, version, since }) => {
                // The copy took the changes before `id` and needs its versions in between first. The same ask twice
                // means the history sent did not help: stop rather than loop.
                if state.needed.as_ref() == Some(&(id.clone(), version)) {
                    return false;
                }
                self.hear(peer, resource, stamp);
                state.after = stamp.max(state.after);
                if !self.push_history(peer, term, store, resource, &id, version, since, deadline) {
                    return false;
                }
                state.needed = Some((id, version));
                true
            }
            Some(Answer::Refused { cause, .. }) => {
                crate::quiet_eprintln!("computers-writer event=push-refused cause={cause}");
                false
            }
            other => {
                // No answer (the computer is off or out of reach) is not logged: a write waits for the others.
                if other.is_some() {
                    crate::quiet_eprintln!("computers-writer event=push-unexpected-answer cause={}", crate::cause!(peer unexpected_push_answer));
                }
                false
            }
        }
    }

    /// The deadline `ms` from now on the wait clock (`waiting`), in milliseconds since the Unix epoch.
    pub(crate) fn deadline_in(&self, ms: u64) -> i64 {
        self.waiting.now_ms().saturating_add(i64::try_from(ms).unwrap_or(i64::MAX))
    }

    /// Milliseconds left until `deadline` on the wait clock (negative once it has passed).
    fn left_ms(&self, deadline: i64) -> i64 {
        deadline.saturating_sub(self.waiting.now_ms())
    }

    /// Sends every (computer, message) at once, each on its own thread, so a computer that does not answer delays no other
    /// (old trillion src/copy-followers.mjs:38 `tellAll`: every copy is told at once). `take(computer, answer, more)`
    /// handles each answer as it arrives, may queue that computer's next message in `more`, and answers whether to stop
    /// waiting; waiting also stops at `deadline`. Each send keeps its own deadline (`message_wait_ms` in the link); a send
    /// still out when waiting stops goes on in the background and its answer is dropped.
    fn send_all(&self, messages: Vec<(String, Message)>, deadline: i64, take: &mut dyn FnMut(&str, Option<Answer>, &mut Vec<(String, Message)>) -> bool) {
        let (sent, answers) = std::sync::mpsc::channel::<(String, Option<Answer>)>();
        let mut out = 0usize;
        // A message that goes in parts takes longer: the wait grows by `part_wait_ms` for each part after the first
        // (`extra_parts`), so a large write is not refused for its size (a 4.3 MB change is about 150 parts).
        let mut deadline = deadline;
        let spawn = |peer: String, message: Message, out: &mut usize, deadline: &mut i64| {
            *deadline += settings().part_wait_ms.saturating_mul(extra_parts(&message)) as i64;
            let link = Arc::clone(&self.link);
            let sent = sent.clone();
            // A long message goes in parts on this thread too (`send_on`).
            let transfer = self.transfers.fetch_add(1, Ordering::AcqRel);
            let started = std::thread::Builder::new().name("computers-send".into()).spawn(move || {
                let answer = send_on(&*link, transfer, &peer, &message);
                let _ = sent.send((peer, answer));
            });
            if started.is_ok() {
                *out += 1;
            }
        };
        for (peer, message) in messages {
            spawn(peer, message, &mut out, &mut deadline);
        }
        while out > 0 {
            // The deadline is read on the wait clock; the answers are received in short steps so a clock that is not the
            // system's (a test's, or a host's) is read as the wait goes on. Every spawned send answers, so this ends.
            let left = self.left_ms(deadline);
            if left <= 0 {
                return;
            }
            let peer_answer = match answers.recv_timeout(Duration::from_millis(left.min(SEND_STEP_MS) as u64)) {
                Ok(answer) => answer,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            };
            let (peer, answer) = peer_answer;
            out -= 1;
            let mut more = Vec::new();
            if take(&peer, answer, &mut more) {
                return;
            }
            for (peer, message) in more {
                spawn(peer, message, &mut out, &mut deadline);
            }
        }
    }

    /// Send `peer` the versions in between of record `id` after its own `version` (made at `since`), one page within
    /// `message_body_bytes` at a time (`Message::PushHistory`), until this computer's copy holds no more of them. Read from
    /// the write's own open transaction, so a version the write itself replaced goes too.
    #[allow(clippy::too_many_arguments)]
    fn push_history(&self, peer: &str, term: u64, store: &OpenWrite<'_>, resource: &str, id: &str, version: i64, since: i64, deadline: i64) -> bool {
        let (mut version, mut since) = (version, since);
        let before = i64::MAX;
        let mut limit = settings().feed_page_items;
        loop {
            if self.waiting.now_ms() >= deadline {
                return false;
            }
            let Ok((versions, more, kept)) = store.history_page(&self.owner, &named(resource), id, version, since, before, limit) else { return false };
            let last = versions.last().map(|past| (past.version, past.from));
            let Some(versions) = self.pasts_for_peer(peer, resource, id, versions) else { return false };
            let message = Message::PushHistory { term, resource: resource.to_string(), id: id.to_string(), kept, versions, base: self.base_of(term, resource) };
            // Fewer versions first; one version that is still longer than a message travels in parts (`send`).
            if limit > 1 && serde_json::to_vec(&Post { message: message.clone() }).map_or(true, |bytes| bytes.len() > settings().message_body_bytes) {
                limit = (limit / 2).max(1);
                continue;
            }
            match self.send(peer, &message) {
                Some(Answer::Applied { stamp }) => self.hear(peer, resource, stamp),
                _ => return false,
            }
            if !more {
                return true;
            }
            match last {
                Some((last, from)) if last > version => (version, since) = (last, from),
                _ => return false,
            }
        }
    }

    /// This computer's settle store of one records resource (`record_log.rs`, in the store file that keeps it).
    /// A store whose records were written before every write kept its settle state is carried into it first, once
    /// (`RecordStore::fill_settle`, `carry.rs`); a carry that cannot finish is named on stderr and asked again next time.
    pub(crate) fn settle_store(&self, resource: &str) -> Result<RecordLog<ComputerStore>, SyncError> {
        if resource.starts_with('[') || resource.starts_with(local_pending::pending_resource()) { return Err(SyncError::storage(crate::cause!())); }
        match self.records.open(resource).map(|store| store.fill_settle(&self.owner, &named(resource))) {
            Ok(Ok(Some(carried))) => crate::quiet_eprintln!("computers-settle event=filled account={} computer={} key={resource} records={} pages={}",
                self.address, self.me, carried.records, carried.pages),
            Ok(Ok(None)) => {}
            Ok(Err(error)) | Err(error) => crate::quiet_eprintln!("computers-settle event=fill-refused cause={}", error.cause()),
        }
        // The same store the copies keep: this computer's own file, or the database its host lends under that store's
        // name (`StoreOpener`), so a computer whose storage is lent settles exactly as one with files does.
        let path = self.records.path(resource);
        let supply: ComputerStore = match &self.records.opener {
            Some(opener) => opener.open(&path).map_err(|error| SyncError::storage(error.cause()))?,
            None => Box::new(sqlite::open_owned(&path, SCHEMA, placements::bounds()).map_err(|error| SyncError::storage(error.cause()))?),
        };
        Ok(RecordLog::new(supply, &self.owner, &named(resource)))
    }

    /// Whether this computer and `peer` may settle plain records: both may answer the account.
    fn may_settle_with(&self, peer: &str) -> bool {
        let placed = self.placed();
        placed.may_answer && placed.may_answer_peers.iter().any(|computer| computer == peer)
    }

    /// Answers `Message::Settle` from computer `from` (src/storage/record_store/record_sync.rs `answer_settle`): this computer keeps
    /// one position for `from` beside its store.
    fn answer_settle(&self, from: &str, resource: &str, request: &SettleRequest) -> Answer {
        if resource.starts_with('[') { return refused("atomic_group_required", crate::cause!(peer refusal)); }
        // Stamps only (ids, stamps, removals: what a computer that only holds a copy already holds, `sealed.rs`) are
        // answered to any computer of the account; everything else only between computers that may answer.
        let stamps_only = request.stamps && self.placed().peers.iter().any(|peer| peer == from);
        if !stamps_only && !self.may_settle_with(from) {
            return refused("settle_not_answering", crate::cause!(peer refusal));
        }
        let mut store = match self.settle_store(resource) { Ok(value) => value, Err(error) => { return refused("settle_unavailable", error.cause()) } };
        if !stamps_only && request.rows.as_ref().is_some_and(|rows| !rows.is_empty()) {
            let before = store.last_log_id().ok().flatten();
            self.remember_settled(resource, before);
        }
        let mut request = request.clone();
        // The copy is named by the proven sender, never by what the request says.
        request.copy = from.chars().take(80).collect();
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis((self.clock)()).map(|time| time.to_rfc3339()).unwrap_or_default();
        match record_sync::answer_settle(&mut store, &request, record_sync::Bounds::shipped(), &now, record_sync::KEPT_APART) {
            Ok(answer) => Answer::Settled { answer },
            Err(error) => refused(settle_code(error.status), error.cause()),
        }
    }

    /// What a settle is for here, and what it is not (a decision, 2026-11-04). Every write of the account goes through
    /// the one writer and its feed (`acknowledge`, `take_push`, `catch_up_from`): the feed carries what a settle state
    /// does not (every version in between, a record's kept replies, an erase's custody, the writer's term and base that a
    /// copy rolls back to), and a write counts only once a second copy holds it by the feed's stamps. So the feed stays the
    /// one owner of copying records, and its record paging is not retired. Each record store write keeps the record's
    /// settle state beside it with the writer's stamp (`RecordStore::mirror_settle`), so the settle store is the account's
    /// actual records, and a settle is the one owner of comparing them: two computers that took the same changes are
    /// shown equal in one request that writes nothing, and records either holds that the other does not (a store carried
    /// from elsewhere, a repair by hand) are merged by stamps both ways into the settle state. What the writer takes
    /// so reaches its records too (`take_settled`: one acknowledged write, which the feed then carries to every copy),
    /// so a settle repairs the account's records, not only their settle states.
    ///
    /// Settles this computer's copy of records `resource` with computer `peer` (src/storage/record_store/record_sync.rs
    /// `settle_with`, old trillion settleWith): the root, then the net changes both ways in acknowledged batches, then
    /// only the buckets that still differ. The cursors are kept beside the store (`took:<peer>`, `sent:<peer>`) after
    /// each acknowledged batch, so a settle cut off anywhere is simply asked again.
    pub fn settle(&self, peer: &str, resource: &str) -> Result<Settled, SyncError> {
        if !self.may_settle_with(peer) {
            return Err(SyncError::new(403, "Records settle only between computers that may answer the account.", crate::cause!()));
        }
        let mut store = self.settle_store(resource)?;
        let before = store.last_log_id()?;
        let (took, sent) = (format!("took:{peer}"), format!("sent:{peer}"));
        let state = SettleState { took_through: store.position(&took)?, sent_through: store.position(&sent)? };
        let mut kept = Vec::new();
        let mut send = |request: &SettleRequest| {
            let message = Message::Settle { resource: resource.to_string(), request: request.clone() };
            if !fits_message(&message, true) {
                return Err(SyncError::new(413, "A settle message exceeds the record bound of one message.", crate::cause!()));
            }
            match self.send(peer, &message) {
                Some(Answer::Settled { answer }) => Ok(answer),
                Some(Answer::Refused { code, cause, .. }) => Err(SyncError::new(settle_status(&code), code, cause)),
                _ => Err(SyncError::new(503, "The other computer did not answer.", crate::cause!())),
            }
        };
        let settled = record_sync::settle_with(&mut store, &mut send, &self.me, state, record_sync::Bounds::shipped(), record_sync::KEPT_APART, &mut |state| kept.push(state.clone()))?;
        let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis((self.clock)()).map(|time| time.to_rfc3339()).unwrap_or_default();
        store.move_position(&took, settled.state.took_through.as_deref(), &now)?;
        store.move_position(&sent, settled.state.sent_through.as_deref(), &now)?;
        drop(store);
        if settled.took + settled.records_taken > 0 {
            self.remember_settled(resource, before);
        }
        self.take_settled();
        Ok(settled)
    }

    /// Compares this computer's copy of records `resource` with computer `peer`'s by stamps alone
    /// (`record_sync::compare_stamps`): the form every computer keeps alike, a computer that only holds a copy included
    /// (its values are sealed under a fresh nonce for it, so they never sum like another copy's; its stamps are the
    /// writer's). Answers which records either side holds at an earlier stamp, or not at all; nothing is taken (a copy
    /// that lacks one takes it from the writer's feed, sealed for it when it only holds a copy).
    pub fn compare_stamps(&self, peer: &str, resource: &str) -> Result<record_sync::StampsCompared, SyncError> {
        if !self.placed().peers.iter().any(|computer| computer == peer) {
            return Err(SyncError::new(403, "Stamps are compared only between computers of the account.", crate::cause!()));
        }
        let store = self.settle_store(resource)?;
        let mut send = |request: &SettleRequest| {
            let message = Message::Settle { resource: resource.to_string(), request: request.clone() };
            match self.send(peer, &message) {
                Some(Answer::Settled { answer }) => Ok(answer),
                Some(Answer::Refused { code, cause, .. }) => Err(SyncError::new(settle_status(&code), code, cause)),
                _ => Err(SyncError::new(503, "The other computer did not answer.", crate::cause!())),
            }
        };
        record_sync::compare_stamps(&store, &mut send, &self.me, record_sync::Bounds::shipped())
    }

    /// Seeds a resource's own file from the records book (`carry::carry_scope`, old trillion resource-state-carry's
    /// table copy): before each store kept in the state folder had a file of its own (`Stores::path`), every resource
    /// but the vault was kept in the records book, so a computer that ran then holds a list's or an own work's records
    /// there while its own file holds none. Each such resource's rows (its versions, orders, search, follow floors and
    /// settle store) are carried into its own file in bounded pages, read back, and compared whole before it counts.
    /// The book's rows are left where they are (no read of the resource goes to the book any more); a resource whose
    /// own file already holds rows (the feed refilled it) is not carried. Answers how many resources were carried.
    pub fn carry_into_own_files(&self) -> usize {
        self.carry_own_files().0
    }

    // Old trillion src/resource-state-carry.mjs:740-794 binds a frozen source and admits a pristine destination.
    // Here the source's read snapshot and the destination's write reservation hold those conditions until every
    // bounded page has read back and the whole scope has been checked. carry_scope's page commits are savepoints:
    // nothing from an interrupted carry becomes visible, and a feed writer cannot fill the destination between
    // the pristine check and the carry. A complete pass alone lets the timer leave this work done.
    fn carry_own_files(&self) -> (usize, bool) {
        if self.records.opener.is_some() || self.records.state.is_none() {
            return (0, true);
        }
        let book = self.records.records.clone();
        let Ok(source) = sqlite::open_owned(&book, SCHEMA, placements::bounds()) else { return (0, false) };
        let Ok(limits) = self.records.limits(&source, &book) else { return (0, false) };
        let Ok(held) = RecordStore::new(&source, Box::new(RealClock), limits).and_then(|store| store.resources_held(&self.owner, usize::MAX >> 1)) else { return (0, false) };
        let mut carried = 0;
        let mut complete = true;
        for name in held {
            // Only a store of one resource (a list, an own work): a fixed state file is shared, and kept where its
            // placement row names by whatever writes it.
            if !placements::placement(&name).is_some_and(|placement| matches!(placement.file, FileOf::StateResource { .. })) {
                continue;
            }
            let own = self.records.own_path(&name);
            if own == book || own.canonicalize().ok().zip(book.canonicalize().ok()).is_some_and(|(own, book)| own == book) {
                continue;
            }
            let copied = (|| {
                let destination = sqlite::open_owned(&own, SCHEMA, placements::bounds()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                self.carry_own_resource(&source, &destination, &name)
            })();
            match copied {
                Ok(Some(done)) => {
                    crate::quiet_eprintln!("computers-copies event=carried-into-own-file account={} computer={} rows={}", self.address, self.me, done.families.iter().map(|(_, rows)| rows).sum::<usize>());
                    carried += 1;
                }
                Ok(None) => {}
                Err(error) => {
                    complete = false;
                    crate::quiet_eprintln!("computers-copies event=carry-refused cause={}", error.cause());
                }
            }
        }
        (carried, complete)
    }

    /// The atomic carry of one resource into its empty file; a refused readback rolls every page back.
    pub(super) fn carry_own_resource(&self, source: &dyn Storage, destination: &dyn Storage, name: &str) -> Result<Option<crate::storage::record_store::carry::ScopeCarried>, Error> {
        let source_scope = crate::storage::Scope::begin(source, Intent::Read).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let destination_scope = crate::storage::Scope::begin(destination, Intent::Write).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        let prefix = [crate::storage::Value::from(self.owner.as_str()), crate::storage::Value::from(name)];
        let any = crate::storage::Range { order: crate::storage::Order::Key, from: crate::storage::Bound::Included(prefix.to_vec()), to: crate::storage::Bound::Included(prefix.to_vec()), reverse: false, limit: Some(1) };
        if !destination.scan("versions", &any, &[crate::storage::Read::whole("id")]).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?.is_empty() {
            return Ok(None);
        }
        let done = crate::storage::record_store::carry::carry_scope(source, destination, &prefix, &CARRIED_FAMILIES, crate::storage::record_store::carry::CarryBounds::default()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        if !done.may_retire {
            return Err(crate::cause!(Error::Unavailable));
        }
        // Close the read snapshot first: a read-close failure still leaves the destination uncommitted.
        source_scope.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        destination_scope.commit().map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
        Ok(Some(done))
    }

    // Keep the earliest unconsumed cursor, including when a new settle arrived while an older repair was read.
    // None is before the first log row. Old trillion record-sync.mjs:345-351 keeps a cursor only after its records
    // are durable; a refused repair here likewise retains its starting cursor for the next attempt.
    fn remember_settled(&self, resource: &str, since: Option<String>) {
        locked(&self.settled_since).entry(resource.to_string())
            .and_modify(|held| {
                if since < *held {
                    held.clone_from(&since);
                }
            })
            .or_insert(since);
    }

    /// What settles took from other computers reaches this computer's records (the record store, which every read
    /// answers from), once this computer writes for the account: each record a settle changed in a settle store is
    /// written, as the settle store now holds it, as one write acknowledged like any other (`write_in`), and the feed
    /// carries it to every copy. A computer that does not write leaves it waiting: the writer's feed brings it the
    /// records, and the writer takes the same records when it settles. Run after a settle and by `tick`. Answers how
    /// many records were written.
    pub fn take_settled(&self) -> usize {
        if self.holding().is_none() {
            return 0;
        }
        let pending: Vec<(String, Option<String>)> = std::mem::take(&mut *locked(&self.settled_since)).into_iter().collect();
        let mut written = 0;
        for (resource, since) in pending {
            let log = match self.settle_store(&resource) {
                Ok(log) => log,
                Err(_) => {
                    self.remember_settled(&resource, since);
                    continue;
                }
            };
            let mut ids: BTreeSet<String> = BTreeSet::new();
            let mut after = since.clone();
            let read = loop {
                let page = match log.log_after(after.as_deref(), record_sync::PAGE) {
                    Ok(page) => page,
                    Err(_) => break false,
                };
                for row in &page.rows {
                    if row.actor.by == "settle" {
                        ids.extend(row.envelopes.iter().map(|envelope| envelope.id.clone()));
                    }
                }
                if !page.more {
                    break true;
                }
                match page.last {
                    Some(next) if after.as_ref().is_none_or(|before| next > *before) => after = Some(next),
                    _ => break false,
                }
            };
            if !read {
                // A partial list of ids is not a completed repair: write none of it and retain the original cursor.
                self.remember_settled(&resource, since);
                continue;
            }
            let ids: Vec<String> = ids.into_iter().collect();
            for chunk in ids.chunks(record_sync::PAGE) {
                let wrote = self.write_in(&resource, |store| {
                    let mut count = 0;
                    for id in chunk {
                        let settled = log.read(id).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
                        let current = store.current_record(&self.owner, &named(&resource), id)?;
                        let same = match (&settled, &current) {
                            (Some(fields), Some(record)) => record.value == serde_json::Value::Object(fields.clone()),
                            (None, None) => true,
                            _ => false,
                        };
                        if same {
                            continue;
                        }
                        let version = current.as_ref().map_or(0, |record| record.version);
                        let mutation = crate::records::Mutation {
                            id: id.clone(),
                            expected_version: version,
                            request_key: format!("settled:{id}:{version}"),
                            deleted: settled.is_none(),
                            value: settled.map_or(serde_json::Value::Null, serde_json::Value::Object),
                        };
                        store.mutate_local_with_check(&self.owner, &named(&resource), mutation, || Ok(()))?;
                        count += 1;
                    }
                    Ok(count)
                });
                match wrote {
                    Ok(count) => written += count,
                    Err(error) => {
                        crate::quiet_eprintln!("computers-copies event=settled-not-written cause={}", error.cause());
                        // Not written (not acknowledged, or the writer turn moved): asked again at the next step.
                        self.remember_settled(&resource, since.clone());
                        break;
                    }
                }
            }
        }
        written
    }

    /// Settles every records resource this computer follows (the replicated resources and every one written or named
    /// since) with `peer`: each answers on its own.
    pub fn settle_all(&self, peer: &str) -> Vec<(String, Result<Settled, SyncError>)> {
        let mut resources: BTreeSet<String> = settings().replicated_resources.iter().cloned().collect();
        resources.extend(locked(&self.resources).iter().cloned());
        resources.into_iter().map(|resource| {
            let settled = self.settle(peer, &resource);
            (resource, settled)
        }).collect()
    }

    /// The answer to `message` from computer `from` (already proven by the caller). See `messages.rs`.
    pub fn answer(&self, from: &str, message: Message) -> Answer {
        self.answer_at(from, message, 0)
    }

    /// `answer`, for a message whose sender's proof time was `skew_ms` from this computer's clock. A vote from a computer
    /// whose clock is off by more than `clock_margin_ms` is refused, so that computer can neither claim nor keep the writer turn.
    pub fn answer_at(&self, from: &str, message: Message, skew_ms: i64) -> Answer {
        let command = matches!(&message, Message::SettleCommand { .. } | Message::SettleCommandPart { .. } | Message::SettleCommandAnswerPart { .. });
        let command_from = format!("settle-command:{from}");
        let answer = match message {
            Message::SettleCommandPart { transfer, index, count, bytes } => match self.take_part_inner(&command_from, transfer, index, count, &bytes) {
                Ok(Some(Message::SettleCommand { request })) => self.answer_pending(&request),
                Ok(Some(_)) => return refused("invalid_command_settle", crate::cause!()),
                Ok(None) => return Answer::Done,
                Err(error) => return refused(error.code, error.cause()),
            },
            Message::SettleCommandAnswerPart { transfer, index } => return self.answer_part(&command_from, transfer, index),
            Message::Part { transfer, index, count, bytes } => match self.take_part(from, transfer, index, count, &bytes) {
                Ok(Some(whole)) => self.answer_one(from, whole, skew_ms),
                Ok(None) => return Answer::Done,
                Err(code) => return refused(code.code, code.cause()),
            },
            Message::AnswerPart { transfer, index } => return self.answer_part(from, transfer, index),
            message => self.answer_one(from, message, skew_ms),
        };
        self.keep_if_long(if command { &command_from } else { from }, answer)
    }

    /// Send `message` to `peer` (`send_on`, under this computer's next transfer number). Every message of the copies
    /// goes through here or through `send_all`, which sends the same way.
    fn send(&self, peer: &str, message: &Message) -> Option<Answer> {
        send_on(&*self.link, self.transfers.fetch_add(1, Ordering::AcqRel), peer, message)
    }

    fn take_part(&self, from: &str, transfer: u64, index: u32, count: u32, bytes: &str) -> Result<Option<Message>, CodedError<&'static str>> {
        if !self.placed().peers.iter().any(|peer| peer == from) {
            return Err(CodedError::new("not_a_computer_of_this_account"));
        }
        self.take_part_inner(from, transfer, index, count, bytes)
    }

    // The command namespace is separate from ordinary copies. The caller of
    // this helper has verified sender proof and the allowed reconstructed kind.
    fn take_part_inner(&self, from: &str, transfer: u64, index: u32, count: u32, bytes: &str) -> Result<Option<Message>, CodedError<&'static str>> {
        if count == 0 || index >= count { return Err(CodedError::new("invalid_part")); }
        let chunk = bytes_of(bytes).ok_or_else(|| CodedError::new("invalid_part"))?;
        let now = (self.clock)();
        let mut incoming = locked(&self.incoming);
        incoming.retain(|_, held| now - held.at <= settings().part_hold_ms);
        if from.starts_with("settle-command:") {
            let (transfers,bytes)=local_pending::pending_part_limits();
            let used=incoming.iter().filter(|(name,_)| name.starts_with("settle-command:")).map(|(_,held)| held.bytes.len()).sum::<usize>();
            let count=incoming.keys().filter(|name| name.starts_with("settle-command:")).count();
            if (index==0 && !incoming.contains_key(from) && count>=transfers) || used.saturating_add(chunk.len())>bytes {return Err(CodedError::new("command_settle_busy"));}
        }
        if index == 0 {
            incoming.insert(from.to_string(), Incoming { transfer, count, next: 0, bytes: Vec::new(), at: now });
        }
        let Some(held) = incoming.get_mut(from).filter(|held| held.transfer == transfer && held.count == count && held.next == index) else {
            return Err(CodedError::new("part_out_of_order"));
        };
        if held.bytes.len() + chunk.len() > settings().carried_bytes {
            incoming.remove(from);
            return Err(CodedError::new("message_too_large"));
        }
        held.bytes.extend(chunk);
        held.next += 1;
        held.at = now;
        if held.next < count {
            return Ok(None);
        }
        let whole = incoming.remove(from).map(|held| held.bytes).unwrap_or_default();
        drop(incoming);
        match serde_json::from_slice::<Message>(&whole) {
            Ok(Message::Part { .. } | Message::AnswerPart { .. }) | Err(_) => Err(CodedError::new("invalid_message")),
            Ok(message) => Ok(Some(message)),
        }
    }

    /// `keep_if_long` for an answer the computer gives rather than the copies (`Answer::Holding`,
    /// src/native_entry/computer/join_itself.rs): kept as parts for `from` when it is longer than one message, so the asker
    /// takes the rest with `Message::AnswerPart` from these copies.
    pub fn answer_in_parts(&self, from: &str, answer: Answer) -> Answer {
        self.keep_if_long(from, answer)
    }

    /// `answer` to `from`: as it is when it fits `message_body_bytes`; else kept as parts for `from` (its first part
    /// answered, `Answer::Parts`), up to `carried_bytes`.
    fn keep_if_long(&self, from: &str, answer: Answer) -> Answer {
        let whole = match serde_json::to_vec(&answer) { Ok(value) => value, Err(error) => return refused("answer_unavailable", crate::refusal_cause::Caused::cause(&error)) };
        if whole.len() <= settings().message_body_bytes {
            return answer;
        }
        if whole.len() > settings().carried_bytes {
            return refused("answer_too_large", crate::cause!(peer refusal));
        }
        let parts: Vec<String> = whole.chunks(part_bytes()).map(base64_of).collect();
        let count = match u32::try_from(parts.len()) { Ok(value) => value, Err(error) => return refused("answer_too_large", crate::refusal_cause::Caused::cause(&error)) };
        let transfer = self.transfers.fetch_add(1, Ordering::AcqRel);
        let first = parts[0].clone();
        let now = (self.clock)();
        let mut outgoing = locked(&self.outgoing);
        outgoing.retain(|_, kept| now - kept.at <= settings().part_hold_ms);
        if from.starts_with("settle-command:") {
            // Proof-bearing omitted senders have no finite signed-membership
            // count. Bound their retained receipt parts in both count and bytes,
            // just as their incoming command parts are bounded.
            let (transfers, bytes) = local_pending::pending_part_limits();
            let mut count = 0usize;
            let mut used = 0usize;
            for (_, kept) in outgoing.iter().filter(|(name, _)| name.starts_with("settle-command:") && name.as_str() != from) {
                count += 1;
                used = used.saturating_add(kept.parts.iter().map(String::len).sum::<usize>());
            }
            let added = parts.iter().map(String::len).sum::<usize>();
            if count >= transfers || used.saturating_add(added) > bytes {
                return refused("command_settle_busy", crate::cause!());
            }
        }
        outgoing.insert(from.to_string(), Outgoing { transfer, parts, at: now });
        Answer::Parts { transfer, count, bytes: first }
    }

    /// Part `index` of the long answer kept for `from` as transfer `transfer`; the last one sent forgets it.
    fn answer_part(&self, from: &str, transfer: u64, index: u32) -> Answer {
        let mut outgoing = locked(&self.outgoing);
        let Some(kept) = outgoing.get(from).filter(|kept| kept.transfer == transfer) else { return refused("no_such_answer", crate::cause!(peer refusal)) };
        let Some(bytes) = usize::try_from(index).ok().and_then(|index| kept.parts.get(index)).cloned() else { return refused("no_such_answer", crate::cause!(peer refusal)) };
        if usize::try_from(index).is_ok_and(|index| index + 1 == kept.parts.len()) {
            outgoing.remove(from);
        }
        Answer::Part { bytes }
    }

    /// One whole message from `from` (see `answer_at`).
    fn answer_one(&self, from: &str, message: Message, skew_ms: i64) -> Answer {
        if let Message::SettleCommand { request } = &message { return self.answer_pending(request); }
        if let Message::Row { told, term, made } = &message {
            // Any proven computer of the account may send its row: a made row is taken only when the account's key signed
            // it and it is newer than this computer's own; a proposed row is only kept pending (never acted on). The
            // answer is this computer's row and the pending mark it keeps.
            if let Some(told) = told {
                if *made {
                    self.adopt(told, *term);
                } else if told.believed(&self.address) && (told.row.revision, *term) > self.placed().mark() {
                    *locked(&self.proposed) = Some((told.row.revision, *term));
                }
            }
            let placed = self.placed();
            return Answer::Row { told: self.told_row(), term: placed.term, pending: *locked(&self.proposed) };
        }
        if self.removed() {
            return refused("removed_from_this_account", crate::cause!(peer refusal));
        }
        if !self.placed().peers.iter().any(|peer| peer == from) {
            return refused("not_a_computer_of_this_account", crate::cause!(peer refusal));
        }
        let now = (self.clock)();
        let id = self.id.clone();
        match message {
            Message::SettleCommand { .. } | Message::SettleCommandPart { .. } | Message::SettleCommandAnswerPart { .. } => refused("invalid_command_settle", crate::cause!()),
            Message::Group { request } => self.answer_group(from, request),
            Message::Vote { ask, stamps } => {
                if ask.id != id {
                    return refused("no_such_writer_row", crate::cause!(peer refusal));
                }
                if skew_ms.abs() > settings().clock_margin_ms {
                    return refused("clock_skew", crate::cause!(peer refusal));
                }
                let current = self.writer_rows.read(&id).ok().flatten().map_or(0, |row| row.term);
                if ask.term > ask.prior && !self.joined() {
                    // Added to a running account and not caught up yet: it cannot tell whether the asker holds every
                    // acknowledged write, so it gives no takeover its vote.
                    crate::quiet_eprintln!("computers-voter event=vote-refused reason=voter_not_joined term={} prior={} claimer_stamps={:?} voter_stamps={:?}",
                        ask.term, ask.prior, stamps, self.stamps());
                    return Answer::Vote { vote: Vote { accepted: false, term: current }, vouched: self.vouched_now(now) };
                }
                if ask.term > ask.prior && self.holds_more_than(&stamps) {
                    crate::quiet_eprintln!("computers-voter event=vote-refused reason=holds_more_than_candidate term={} prior={} claimer_stamps={:?} voter_stamps={:?}",
                        ask.term, ask.prior, stamps, self.stamps());
                    return Answer::Vote { vote: Vote { accepted: false, term: current }, vouched: self.vouched_now(now) };
                }
                // Every answer names the computers this voter vouched for and how long each may still admit: a computer that
                // wins with this vote waits for them before a sign-in change counts as done. The vote and that list are
                // one step under the `vouched` lock, as a vouch is (`vouch_for`): a vouch is named in this vote, or
                // comes after it and sees the term it took.
                let mut held = locked(&self.vouched);
                let voted = writer_row::accept_vote_or_refuse(&self.writer_rows, from, &ask, now);
                held.retain(|_, until| *until > now);
                let vouched: Vec<(String, i64)> = held.iter().map(|(computer, until)| (computer.clone(), until - now)).collect();
                drop(held);
                match voted {
                    Ok((vote, refusal)) => {
                        if let Some(refusal) = refusal {
                            crate::quiet_eprintln!("computers-voter event=vote-refused reason={} term={} prior={} claimer_stamps={:?} voter_stamps={:?}",
                                refusal.word(), ask.term, ask.prior, stamps, self.stamps());
                        }
                        if vote.accepted && ask.term > ask.prior {
                            // A new writer: this computer pulls from it at once rather than on its next whole step.
                            self.step_now.store(true, Ordering::Release);
                        }
                        Answer::Vote { vote, vouched }
                    }
                    Err(error) => refused("writer_row_unavailable", crate::refusal_cause::Caused::cause(&error)),
                }
            }
            Message::Release { term } => {
                if self.release_row(from, term, now) {
                    // The writer turn is free now: this computer's claim may be due at once.
                    self.step_now.store(true, Ordering::Release);
                }
                Answer::Done
            }
            Message::Push { term, resource, after, changes, base } => {
                let answer = self.take_push(from, &id, now, term, &resource, after, &changes, base);
                // A push of the account stores' records is taken into this computer's own stores at once, so a change at the
                // writer reaches the stores here even while nobody asks this computer anything.
                if resource == super::account_stores::resource() && matches!(answer, Answer::Applied { .. }) && !changes.is_empty() {
                    self.account_stores_step();
                }
                answer
            }
            Message::Settle { resource, request } => self.answer_settle(from, &resource, &request),
            Message::Pull { writer, resource, after, limit } => {
                if resource.starts_with('[') { return refused("atomic_group_required", crate::cause!(peer refusal)); }
                let term = if writer {
                    match locked(&self.writer_role).holding(now) {
                        Some(term) => term,
                        None => return self.refused_not_writer(from, now),
                    }
                } else {
                    0
                };
                if writer {
                    self.hear(from, &resource, after);
                }
                let mut limit = limit.clamp(1, settings().feed_page_items);
                let mut history = settings().feed_history_items;
                // From the writer: its term and base. From another computer: the term it took changes from and its base,
                // so a computer catching up from it before a claim treats its pages as that term's.
                let (term, base) = if writer {
                    (term, self.base_of(term, &resource))
                } else {
                    self.records.open(&resource).and_then(|store| store.accepted(&self.owner, &named(&resource))).unwrap_or((0, 0))
                };
                loop {
                    let answer = match self.records.page(&resource, after, limit, history) {
                        Ok((changes, more)) => Answer::Page {
                            changes: match self.for_peer(from, &resource, changes) {
                                Some(changes) => changes,
                                None => return refused("no_root_to_seal", crate::cause!(peer refusal)),
                            },
                            term,
                            more,
                            resources: locked(&self.resources).iter().cloned().collect(),
                            base,
                            row: Some(self.placed().mark()),
                        },
                        Err(error) => return refused("records_unavailable", crate::refusal_cause::Caused::cause(&error)),
                    };
                    let held = match &answer { Answer::Page { changes, .. } => changes.len(), _ => 0 };
                    if fits(&answer) || (held <= 1 && history == 0) {
                        return answer;
                    }
                    // Fewer changes first (half of what the page held); then one change with no versions in between
                    // (the copy asks for them page by page, `Message::History`). One change still longer than a
                    // message is answered in parts (`keep_if_long`).
                    if held > 1 {
                        limit = (held / 2).max(1);
                    } else {
                        history = 0;
                    }
                }
            }
            Message::History { writer, resource, id: record, version, since, before, limit } => {
                if resource.starts_with('[') { return refused("atomic_group_required", crate::cause!(peer refusal)); }
                let term = if writer {
                    match locked(&self.writer_role).holding(now) {
                        Some(term) => term,
                        None => return self.refused_not_writer(from, now),
                    }
                } else {
                    0
                };
                let (term, base) = if writer {
                    (term, self.base_of(term, &resource))
                } else {
                    self.records.open(&resource).and_then(|store| store.accepted(&self.owner, &named(&resource))).unwrap_or((0, 0))
                };
                let mut limit = limit.clamp(1, settings().feed_page_items);
                loop {
                    let page = self.records.open(&resource).and_then(|store| store.history_page(&self.owner, &named(&resource), &record, version, since, before, limit));
                    let answer = match page {
                        Ok((versions, more, kept)) => match self.pasts_for_peer(from, &resource, &record, versions) {
                            Some(versions) => Answer::History { term, base, versions, more, kept },
                            None => return refused("no_root_to_seal", crate::cause!(peer refusal)),
                        },
                        Err(error) => return refused("records_unavailable", crate::refusal_cause::Caused::cause(&error)),
                    };
                    if limit == 1 || fits(&answer) {
                        return answer;
                    }
                    limit = (limit / 2).max(1);
                }
            }
            Message::PushHistory { term, resource, id: record, kept, mut versions, base } => {
                if let Err(answer) = self.take_writer_page(from, &id, now, term, &resource, base) {
                    return answer;
                }
                let sealed = match self.take_in_pasts(&resource, &record, &mut versions) {
                    Ok(sealed) => sealed,
                    Err(code) => return refused(code.code, code.cause()),
                };
                let applied = self.records.open(&resource).and_then(|mut store| {
                    store.apply_history(&self.owner, &named(&resource), term, base, &record, kept, &versions, sealed)?;
                    store.stamp(&self.owner, &named(&resource))
                });
                match applied {
                    Ok(stamp) => Answer::Applied { stamp },
                    Err(error) => refused("page_refused", crate::refusal_cause::Caused::cause(&error)),
                }
            }
            Message::Stamps => Answer::Stamps { stamps: self.stamps(), joined: self.joined() },
            Message::Ready => if self.answers_now() { Answer::Done } else { refused("not_ready_to_answer", crate::cause!(peer refusal)) },
            Message::Vouch { term, stamp } => Answer::Vouch { ms: self.vouch_for(from, now, term, stamp) },
            Message::CaughtUp { resource, stamp, .. } => {
                self.hear(from, &resource, stamp);
                self.record_pull(&resource, from, stamp);
                locked(&self.unreached).remove(from);
                // A run of the account's copy rule may wait for this computer to catch up before it votes: the rule runs
                // now (src/account/computers/copy_rule.rs `run_soon`), not at the next sweep.
                if let Err(error) = super::copy_rule::note_caught_up(&*self.writer_rows.storage, &self.user, from, stamp) {
                    return refused("current_source_unavailable", crate::refusal_cause::Caused::cause(&error));
                }
                super::copy_rule::run_soon(&self.owner);
                Answer::Done
            }
            Message::SignIn { term, base, after, changes } => self.take_sign_in(&id, now, term, base, after, &changes),
            Message::SignInPull { after, limit, needs_secrets_key, root_identity } => {
                self.answer_sign_in_pull(from, now, after, limit, needs_secrets_key, root_identity.as_deref())
            }
            Message::Row { .. } => unreachable!("answered above"),
            Message::Part { .. } | Message::AnswerPart { .. } => refused("invalid_message", crate::cause!(peer refusal)),
            // Answered by the computer that serves the account (src/native_entry/computer/join_itself.rs), never by its copies.
            Message::Holding { .. } => refused("holding_is_the_computers", crate::cause!(peer refusal)),
            Message::Tools { .. } => refused("tools_are_the_computers", crate::cause!(peer refusal)),
            Message::OutsideChanges { rows } => self.take_outside_changes(from, rows),
            Message::SignInMark { term, stamp } => self.take_mark(&id, term, stamp),
        }
    }

    /// A writer's page. Refused below the term this copy's writer row holds; a page above the term this computer
    /// itself holds means another computer won the writer turn, so this computer gives it up.
    #[allow(clippy::too_many_arguments)]
    fn take_push(&self, from: &str, id: &str, now: i64, term: u64, resource: &str, after: i64, changes: &[Carried], base: i64) -> Answer {
        if resource.starts_with('[') { return refused("atomic_group_required", crate::cause!(peer refusal)); }
        if let Err(answer) = self.take_writer_page(from, id, now, term, resource, base) {
            return answer;
        }
        let held = match self.records.stamp(resource) {
            Ok(stamp) => stamp,
            Err(error) => return refused("records_unavailable", crate::refusal_cause::Caused::cause(&error)),
        };
        if held < after {
            return Answer::Behind { stamp: held };
        }
        locked(&self.resources).insert(resource.to_string());
        let changes = match self.take_in(resource, changes) {
            Ok(changes) => changes,
            Err(code) => return refused(code.code, code.cause()),
        };
        // A change is taken only whole, with every version in between the writer keeps: the changes before one that
        // does not carry them all are taken, and the writer is asked for the rest of its history (`Answer::Needs`).
        let taken = self.records.open(resource).and_then(|mut store| {
            let gap = store.history_gap(&self.owner, &named(resource), &changes, 0)?;
            let upto = gap.as_ref().map_or(changes.len(), |gap| gap.index);
            let stamp = store.apply_carried_at(&self.owner, &named(resource), term, base, &changes[..upto])?.stamp;
            Ok((stamp, gap))
        });
        match taken {
            Ok((stamp, None)) => Answer::Applied { stamp },
            Ok((stamp, Some(gap))) => Answer::Needs { stamp, id: gap.id, version: gap.version, since: gap.since },
            Err(Error::Conflict(_)) => refused("version_conflict", crate::cause!(peer refusal)),
            Err(error) => refused("page_refused", crate::refusal_cause::Caused::cause(&error)),
        }
    }

    /// What every writer's page (a push or a history page) checks first. Refused below the term this copy's writer
    /// row holds; a page above the term this computer itself holds means another computer won the writer turn, so this computer gives
    /// it up; a copy that first hears this term and holds more than `base` rolls back (`reconcile`).
    fn take_writer_page(&self, from: &str, id: &str, now: i64, term: u64, resource: &str, base: i64) -> Result<(), Answer> {
        if resource.starts_with('[') { return Err(refused("atomic_group_required", crate::cause!(peer refusal))); }
        self.take_writer_identity(from, id, now, term)?;
        if let Err(error) = self.reconcile(resource, term, base) { return Err(refused("records_unavailable", error.cause())); }
        Ok(())
    }

    fn take_writer_identity(&self, from: &str, id: &str, now: i64, term: u64) -> Result<(), Answer> {
        let before = self.writer_rows.read(id).ok().flatten();
        let row_term = before.as_ref().map_or(0, |row| row.term);
        if term < row_term {
            return Err(refused("stale_writer", crate::cause!(peer refusal)));
        }
        if term > row_term {
            // A new writer: this computer pulls from it at once rather than on its next whole step (`next_step_ms`).
            self.step_now.store(true, Ordering::Release);
        }
        if term > row_term && !self.placed().voters.contains(&self.me) {
            // A computer that does not vote learns the writer from its pages (a voter learns it from the votes): its
            // writer row copy is only what it follows, never a vote.
            let learned = WriterRow { writer: from.to_string(), term, expires_at_ms: now + settings().term_ms };
            let _ = self.writer_rows.replace(id, before.as_ref(), &learned);
        }
        {
            let mut writer_role = locked(&self.writer_role);
            match writer_role.holding(now) {
                Some(held) if held >= term => return Err(refused("stale_writer", crate::cause!(peer refusal))),
                Some(_) => {
                    writer_role.give_up();
                    self.epoch.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                }
                None => {}
            }
        }
        // A writer is heard: the turns to claim leave out the computer the row names again.
        self.split.store(false, Ordering::Release);
        Ok(())
    }

    /// Whether this copy holds a newer change than `stamps` say the asker holds, in any resource.
    fn holds_more_than(&self, stamps: &[(String, u64, i64)]) -> bool {
        self.stamps().iter().any(|(resource, term, stamp)| {
            let theirs = stamps.iter().find(|(name, _, _)| name == resource).map_or((0, 0), |(_, term, stamp)| (*term, *stamp));
            (*term, *stamp) > theirs
        })
    }

    /// The writer term this copy took changes of `resource` from, and its caught-up stamp.
    fn held(&self, resource: &str) -> (u64, i64) {
        if let Some(address) = group_address(resource) {
            return self.group_committed_position(&address.history).unwrap_or((0,0));
        }
        self.records.open(resource)
            .and_then(|store| Ok((store.accepted(&self.owner, &named(resource))?.0, store.stamp(&self.owner, &named(resource))?)))
            .unwrap_or((0, 0))
    }

    /// The writer term this copy took sign-in changes from, and its sign-in stamp.
    fn sign_in_held(&self) -> (u64, i64) {
        let _one = locked(&self.sign_in);
        let counter = self.log().counter().unwrap_or_default();
        (counter.term, i64::try_from(counter.stamp).unwrap_or(i64::MAX))
    }

    /// Answer one message the forwarder sent on this computer's session: a `message_operation` message whose proof (the sender's
    /// own `trp_` credential) names this account and the computer the forwarder says sent it. Anything else is refused.
    pub fn answer_message(&self, bytes: &[u8]) -> Result<Vec<u8>, CodedError<()>> {
        let mut session_message = decode_message(bytes).map_err(|error| CodedError::with_cause((), error.cause()))?;
        let proof = zeroize::Zeroizing::new(std::mem::take(&mut session_message.client_authorization));
        let reply = |value: serde_json::Value| serde_json::to_vec(&json!({"state": "completed", "request_id": session_message.request_id, "value": value})).map_err(|_| CodedError::new(()));
        let refusal = |code: &str, cause: crate::refusal_cause::Cause| serde_json::to_vec(&json!({"state": "refused", "request_id": session_message.request_id, "code": code, "cause": cause.id()})).map_err(|_| CodedError::new(()));
        if session_message.operation != settings().message_operation {
            return refusal("operation_unknown_here", crate::cause!(peer message_refusal));
        }
        let Ok(message_from) = serde_json::from_value::<MessageFrom>(session_message.input.clone()) else { return refusal("invalid_message", crate::cause!(peer message_refusal)) };
        let now = self.waiting.now_ms();
        match super::read_computer_message_credential(&proof, now) {
            Some((computer, account, _)) if computer == message_from.from && account == self.address => {}
            _ => return refusal("computer_not_proven", crate::cause!(peer message_refusal)),
        }
        let skew = match super::read_computer_message_credential(&proof, now) {
            Some((_, _, at)) => now - at,
            None => return refusal("computer_not_proven", crate::cause!(peer message_refusal)),
        };
        let answer = self.answer_at(&message_from.from, message_from.message, skew);
        reply(serde_json::to_value(answer).map_err(|_| CodedError::new(()))?)
    }
}

#[cfg(test)]
impl Copies {
    /// Set this computer's own writer row copy (a voter's row after a claim reached it).
    pub(crate) fn set_writer_row_for_test(&self, computer: &str, number: u64, expires_at_ms: i64) {
        let rows = &self.writer_rows;
        let before = rows.read(&self.id).ok().flatten();
        assert!(rows.replace(&self.id, before.as_ref(), &WriterRow { writer: computer.to_string(), term: number, expires_at_ms }).unwrap());
    }

    /// When this computer's claim is due (`claim_times`), and whether its last claim did not win (`split`).
    pub(crate) fn claim_turn_for_test(&self) -> (i64, bool) {
        (self.claim_times().1, self.split.load(Ordering::Acquire))
    }
}

fn refused(code: &'static str, cause: crate::refusal_cause::Cause) -> Answer {
    crate::quiet_eprintln!("computer-refusal code={code} cause={cause}");
    Answer::Refused { code: code.to_string(), cause, writer: None }
}

/// The acknowledgement of the write in hand: the stamp of a single other copy that reported holding every resource's
/// written stamp. This computer's own copy never counts.
impl Ack for Copies {
    /// The write in hand counts only when this computer (when it votes) and the voters that reported holding every
    /// written stamp are more than half of the voters: any majority that takes the writer turn later shares a voter with
    /// them, which refuses a claimer that holds less. One copy that does not vote never counts.
    fn second_copy_stamp(&self, _id: &str, _term: u64) -> Option<i64> {
        let pending = locked(&self.pending).clone();
        let top = pending.iter().map(|(_, stamp)| *stamp).max()?;
        self.majority_holds(&pending).then_some(top)
    }
}

impl Copies {
    /// Whether this computer (when it votes) and the other voters that reported holding every stamp of `written` are a
    /// majority of the voters.
    /// Whether a write is acknowledged: a majority of the voters holds it, and every other computer that may answer holds
    /// it or its push `ended` without it (out of reach, refused, or past the deadline). Waiting stops then; the commit
    /// itself still asks only for the majority (`commit`), so a computer that may answer and is down never stops writes.
    fn acknowledged_by(&self, written: &[(String, i64)], ended: &HashSet<String>) -> bool {
        if !self.majority_holds(written) {
            return false;
        }
        let placed = self.placed();
        let heard = locked(&self.heard);
        placed.may_answer_peers.iter().filter(|peer| placed.peers.contains(peer)).all(|peer| {
            ended.contains(peer)
                || written.iter().all(|(resource, stamp)| heard.get(&(peer.clone(), resource.clone())).is_some_and(|held| held >= stamp))
        })
    }

    fn majority_holds(&self, written: &[(String, i64)]) -> bool {
        let placed = self.placed();
        let heard = locked(&self.heard);
        let holds = |peer: &String| written.iter().all(|(resource, stamp)| heard.get(&(peer.clone(), resource.clone())).is_some_and(|held| held >= stamp));
        let count = usize::from(placed.voters.contains(&self.me)) + placed.voters.iter().filter(|voter| **voter != self.me && holds(voter)).count();
        count * 2 > placed.voters.len()
    }
}

/// Where one peer's push of a write stands (`Copies::push_next`, `Copies::push_answered`).
#[derive(Default)]
struct PushState {
    /// The index in `written` of the resource being pushed.
    resource: usize,
    started: bool,
    after: i64,
    limit: usize,
    history: usize,
    needed: Option<(String, i64)>,
    more: bool,
    last: Option<i64>,
}

/// The next step of one peer's push.
enum Next {
    Send(Message),
    Done,
    Failed,
}

/// Whether a page fits as it is: within `message_body_bytes`, or, for a page of one change alone, within `carried_bytes`,
/// in parts (`Copies::send`): a record past the page bound crosses alone, as old trillion's resource-state-carry sends a
/// row up to 16 MiB as its own page (src/resource-state-carry.mjs:11 `ROW_BYTES`, :322-328).
fn fits_message(message: &Message, single: bool) -> bool {
    let bound = if single { settings().carried_bytes } else { settings().message_body_bytes };
    serde_json::to_vec(&Post { message: message.clone() }).is_ok_and(|bytes| bytes.len() <= bound)
}

/// Whether this computer may claim: it heard from enough voters to make a majority with itself, and none holds more.
struct Gate(bool);

/// Why this computer may not take the writer turn yet (`Copies::claim`): one gap per thing that is not complete and up to date.
/// Each names its resource and its stamps, never a value; `describe` is what the log names it by.
#[derive(Clone, Debug)]
enum ClaimGap {
    Placement,
    Stores,
    Unmaterialized { groups: usize },
    NoMajority { answered: usize, voters: usize },
    Mark { theirs: (u64, u64), held: (u64, u64) },
    Stamp { resource: String, theirs: (u64, i64), held: (u64, i64) },
}

impl ClaimGap {
    fn describe(&self) -> String {
        match self {
            Self::Placement => "placement".to_owned(),
            Self::Stores => "stores".to_owned(),
            Self::Unmaterialized { groups } => format!("unmaterialized groups={groups}"),
            Self::NoMajority { answered, voters } => format!("no-majority answered={answered} voters={voters}"),
            Self::Mark { theirs, held } => format!("places-mark theirs={theirs:?} held={held:?}"),
            Self::Stamp { resource, theirs, held } => format!("stamp resource={resource} theirs={theirs:?} held={held:?}"),
        }
    }
}

impl CaughtUp for Gate {
    fn caught_up(&self, _id: &str) -> bool {
        self.0
    }
}

/// Votes go through the link, with this copy's stamps.
struct VoteWire<'a> {
    copies: &'a Copies,
}

impl Wire for VoteWire<'_> {
    fn ask(&self, _from: &str, to: &str, ask: &Ask) -> Option<Vote> {
        let message = Message::Vote { ask: ask.clone(), stamps: self.copies.stamps() };
        self.take_vote(self.copies.send(to, &message))
    }

    /// Every voter at once (`send_all`), done once `enough` accepted: a voter that does not answer is waited for only
    /// while too few said yes, and at most one message's wait (and its one resend after an early failure).
    fn ask_all(&self, _from: &str, voters: &[String], ask: &Ask, enough: usize) -> Vec<(String, Option<Vote>)> {
        if enough == 0 || voters.is_empty() {
            return Vec::new();
        }
        let message = Message::Vote { ask: ask.clone(), stamps: self.copies.stamps() };
        let wait = settings().message_wait_ms;
        let deadline = self.copies.deadline_in(wait.saturating_add(wait / 2));
        let mut votes = Vec::new();
        let mut accepted = 0usize;
        self.copies.send_all(voters.iter().map(|voter| (voter.clone(), message.clone())).collect(), deadline,
            &mut |voter, answer, _more| {
                let vote = self.take_vote(answer);
                accepted += usize::from(vote.is_some_and(|vote| vote.accepted));
                votes.push((voter.to_owned(), vote));
                accepted >= enough
            });
        votes
    }
}

impl VoteWire<'_> {
    fn take_vote(&self, answer: Option<Answer>) -> Option<Vote> {
        match answer? {
            Answer::Vote { vote, vouched } => {
                // Kept whether or not the vote was won: waiting for a computer that may admit is never unsafe.
                let now = (self.copies.clock)();
                let mut held = locked(&self.copies.vouched);
                for (computer, ms) in vouched {
                    let until = now.saturating_add(ms.max(0));
                    let entry = held.entry(computer).or_insert(until);
                    *entry = (*entry).max(until);
                }
                Some(vote)
            }
            _ => None,
        }
    }
}

/// The feed of another computer, through the link. From the writer (`writer`), pages carry its term and the pull reports
/// this copy's stamp. From a computer catching this one up before a claim, pages are applied at this copy's own floor.
struct FeedByMessages<'a> {
    copies: &'a Copies,
    to: &'a str,
    /// The copy key of the resource pulled (`Stores`): what the messages name. The store the pages go into names the
    /// resource by its own name (`named`), which `follow` passes here.
    key: &'a str,
    writer: bool,
    floor: u64,
}

impl follow::FeedSource for FeedByMessages<'_> {
    fn page(&self, _account: &str, _resource: &str, after: i64, limit: usize) -> Result<follow::WriterPage, Error> {
        let mut after = after;
        // At most twice: a writer's first page under a term this copy has not heard may show that the copy holds a
        // change no writer acknowledged; it rolls that back, and asks again from the stamp it then holds.
        for _ in 0..2 {
            let message = Message::Pull { writer: self.writer, resource: self.key.to_string(), after, limit };
            match self.copies.send(self.to, &message) {
                Some(Answer::Page { term, changes, more, resources, base, row }) => {
                    locked(&self.copies.resources).extend(resources);
                    if row.is_some_and(|mark| mark > self.copies.placed().mark()) {
                        self.copies.pull_row(self.to);
                    }
                    if self.copies.reconcile(self.key, term, base)? {
                        after = self.copies.records.stamp(self.key)?;
                        continue;
                    }
                    // Sealed values are opened, or kept sealed, as this computer keeps them (`take_in`).
                    let changes = self.copies.take_in(self.key, &changes).map_err(|error| Error::Invalid("a page's sealed values were refused", crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!(Error Invalid))))?;
                    // A page from a computer that is not the writer is taken at this copy's own term when that is newer.
                    return Ok(follow::WriterPage { term: term.max(self.floor), base, changes, more });
                }
                Some(Answer::Refused { code, writer, .. }) if code == "not_writer" && self.writer => {
                    self.copies.heed_not_writer(self.to, writer.as_ref(), (self.copies.clock)());
                    return Err(crate::cause!(Error::Unavailable));
                }
                _ => return Err(crate::cause!(Error::Unavailable)),
            }
        }
        Err(crate::cause!(Error::Unavailable))
    }

    fn history(&self, _account: &str, _resource: &str, id: &str, version: i64, since: i64, before: i64, limit: usize) -> Result<follow::HistoryPage, Error> {
        let message = Message::History { writer: self.writer, resource: self.key.to_string(), id: id.to_string(), version, since, before, limit };
        match self.copies.send(self.to, &message) {
            Some(Answer::History { term, base, mut versions, more, kept }) => {
                let sealed = self.copies.take_in_pasts(self.key, id, &mut versions).map_err(|error| Error::Invalid("a page's sealed values were refused", crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!(Error Invalid))))?;
                Ok(follow::HistoryPage { term: term.max(self.floor), base, versions, more, kept, sealed })
            }
            Some(Answer::Refused { code, writer, .. }) if code == "not_writer" && self.writer => {
                self.copies.heed_not_writer(self.to, writer.as_ref(), (self.copies.clock)());
                Err(crate::cause!(Error::Unavailable))
            }
            _ => Err(crate::cause!(Error::Unavailable)),
        }
    }

    fn caught_up(&self, _account: &str, _resource: &str, stamp: i64) -> Result<(), Error> {
        if self.writer {
            let term = self.copies.writer_row().map_or(0, |(_, term, _)| term);
            let _ = self.copies.send(self.to, &Message::CaughtUp { term, resource: self.key.to_string(), stamp });
        }
        Ok(())
    }
}

/// Opens what a copy kept sealed, with this computer's roots (`RecordStore::open_sealed`), through `sealed::open_value`.
struct OpenWith<'a> {
    roots: &'a SecretsKeys,
    owner: &'a str,
    resource: &'a str,
}

impl follow::Unseal for OpenWith<'_> {
    fn value(&self, id: &str, version: i64, from: i64, value: &serde_json::Value) -> Result<Option<serde_json::Value>, Error> {
        if !sealed::is_sealed(value) {
            return Ok(None);
        }
        let at = At { owner: self.owner, resource: self.resource, id, version, from, part: Part::Value };
        sealed::open_value(self.roots, &at, value).map(Some).map_err(|error| Error::Invalid("a sealed value did not open", crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!(Error Invalid))))
    }

    fn receipts(&self, id: &str, version: i64, from: i64, text: &str) -> Result<Option<String>, Error> {
        if !sealed::is_sealed_text(text) {
            return Ok(None);
        }
        let at = At { owner: self.owner, resource: self.resource, id, version, from, part: Part::Receipts };
        sealed::open_text(self.roots, &at, text).map(Some).map_err(|error| Error::Invalid("sealed receipts did not open", crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!(Error Invalid))))
    }
}

/// The writer row copy in the account's account rows (owned storage, so it can live in a `Copies`).
struct SharedCopy {
    storage: Arc<dyn Storage + Send + Sync>,
    account: String,
}

impl WriterRowCopy for SharedCopy {
    fn read(&self, id: &str) -> WriterResult<Option<WriterRow>> {
        StoreCopy { store: Store::new(&*self.storage), account: &self.account }.read(id)
    }

    fn replace(&self, id: &str, before: Option<&WriterRow>, after: &WriterRow) -> WriterResult<bool> {
        StoreCopy { store: Store::new(&*self.storage), account: &self.account }.replace(id, before, after)
    }
}

/// This computer's copies of the account's stores: the records store file and, when followed, the vault store file
/// (resource `secrets`), each opened for each step.
struct Stores {
    records: PathBuf,
    vault: Option<PathBuf>,
    /// The account's state folder at this computer: the stores its placement rows name by file there (lists, own work, the
    /// files store, the budget), and their further stores.
    state: Option<PathBuf>,
    owner: String,
    limits: Option<Limits>,
    /// How this computer opens its stores (`StoreOpener`); `None`: SQLite files on this computer's disk.
    opener: Option<Arc<dyn StoreOpener>>,
}

/// The families a resource's rows are kept in, each keyed by (account, resource) first: what `carry_into_own_files`
/// carries for one resource.
const CARRIED_FAMILIES: [&str; 10] = ["versions", "ordered", "order_state", "search_segments", "search_parts", "follow", "settle_log", "settle_records", "settle_sums", "settle_positions"];

/// The name a store keeps resource `key` under (`Stores`): the key itself, or, for a further store of a volume
/// (`overflow:<order>/<resource>`), the resource after it.
fn named(key: &str) -> std::borrow::Cow<'_, str> {
    match group_address(key) {
        Some(address) => std::borrow::Cow::Owned(address.resource),
        None => std::borrow::Cow::Borrowed(overflow_of(key).map_or(key, |(_, name)| name)),
    }
}

/// This wire address has one canonical spelling. A full history selects a
/// physical group while its member still uses its original logical resource.
/// The framing context is a protocol version, never a supply or computer kind.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupAddress {
    history: GroupIdentity,
    resource: String,
}
fn group_limits() -> Result<live_adopt::Limits,Error> { Ok(store_settings::shipped().ok_or(crate::cause!(Error::Unavailable))?.live_adoption) }
fn group_stream(scope:&GroupIdentity,owner:&str)->Result<String,Error> {
    live_adopt::command_slot(owner,&serde_json::to_value(scope).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?).map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}
fn group_binding(scope:&GroupIdentity,owner:&str)->Result<Vec<u8>,Error> { serde_json::to_vec(&(owner,scope)).map_err(|error| crate::carry_cause!(Error::Unavailable, error)) }
fn opaque_commit(wire:&WireCommit)->Result<OpaqueCommit,Error> {
    if wire.sequence <= 0 || wire.digest.len()!=content_crypto::advanced::blake3::OUT_LEN*2
        || wire.payload.len()>settings().carried_bytes { return Err(Error::Invalid("invalid encrypted commit", crate::cause!())); }
    if wire.map.delta.sequence!=wire.sequence || wire.map.delta.digest!=wire.digest {return Err(crate::cause!(Error::Conflict));}
    let payload=serde_json::to_vec(wire).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if payload.len()>settings().carried_bytes {return Err(Error::Invalid("invalid encrypted commit", crate::cause!()));}
    Ok(OpaqueCommit {sequence:wire.sequence,digest:wire.digest.clone(),payload})
}
fn wire_from_opaque(commit:&OpaqueCommit)->Result<WireCommit,Error> {
    let wire:WireCommit=serde_json::from_slice(&commit.payload).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
    if wire.sequence!=commit.sequence || wire.digest!=commit.digest {return Err(crate::cause!(Error::Conflict));}
    opaque_commit(&wire)?;Ok(wire)
}
fn group_header_matches<S:Storage>(store:&RecordStore<S>,account:&str,scope:&GroupIdentity)->Result<bool,Error> {
    Ok(store.current_record(account,crate::local_account::own_records::IDENTITY,"command-domain")?
        .is_some_and(|header|serde_json::to_value(scope).is_ok_and(|expected|header.value==expected)))
}
pub(crate) fn group_key(history: &GroupIdentity, resource: &str) -> Result<String, Error> {
    serde_json::to_string(&("record-group/v1", GroupAddress { history: history.clone(), resource: resource.into() }))
        .map_err(|error| crate::carry_cause!(Error::Unavailable, error))
}
fn group_address(key: &str) -> Option<GroupAddress> {
    let (context, address): (String, GroupAddress) = serde_json::from_str(key).ok()?;
    (context == "record-group/v1" && group_key(&address.history, &address.resource).ok().as_deref() == Some(key)).then_some(address)
}

/// The order and resource of the key of a further store of a volume (`overflow_prefix` + order + `/` + resource, the
/// store `book_path` makes at that order beside the resource's own file).
fn overflow_of(key: &str) -> Option<(usize, &str)> {
    let prefix = &store_settings::shipped()?.volume_stores.overflow_prefix;
    let (digits, name) = key.strip_prefix(prefix.as_str())?.split_once('/')?;
    let order: usize = digits.parse().ok().filter(|order| *order > 0)?;
    // One spelling per order (no leading zero), so one store has one key.
    (digits == order.to_string()).then_some((order, name))
}

impl Stores {
    /// The store file that keeps copy key `key` (stage 3 item 6: copies follow every store of the account). A key is a
    /// resource the account's placement rows declare (`placements`, as DATA): it lives in the file its row
    /// names, the account's records book for an object placement, a file of the state folder by name (the vault, the
    /// files store, the budget, computer grants), or one file per resource (each list `@list/<id>`, each own work
    /// `@own-work/<id>` and its directory and point). A further store of a volume (the storage audit's overflow stores,
    /// `books.rs`) is keyed `overflow:<order>/<resource>` and lives beside that file. A resource no row
    /// declares, or a state-folder file with no state folder known, is kept in the records book, as every resource
    /// was before. Before, every resource but the vault was kept in the records book, so the stores of lists and own
    /// work, and the further stores, had no copy at another computer.
    fn path(&self, key: &str) -> PathBuf {
        let own = if group_address(key).is_some() { self.own_path(key) } else { self.own_path(&named(key)) };
        match overflow_of(key) {
            Some((order, _)) => book_path(&own, order).unwrap_or(own),
            None => own,
        }
    }

    fn own_path(&self, name: &str) -> PathBuf {
        if let Some(address) = group_address(name) {
            if let (Some(state), Ok(resource)) = (&self.state, address.history.resource(&self.owner)) {
                if let Some(path) = placements::placement(&resource).and_then(|row| row.in_state_for(&resource, state)) {
                    return path;
                }
            }
        }
        if let Some(vault) = &self.vault {
            if crate::secrets::resource().is_ok_and(|held| held == name) {
                return vault.clone();
            }
        }
        let placed = placements::placement(name);
        let in_state = match (placed, &self.state) {
            (Some(placement), Some(state)) => match &placement.file {
                FileOf::Object(_) => None,
                FileOf::State(_) | FileOf::StateResource { .. } => placement.in_state_for(name, state),
            },
            _ => None,
        };
        in_state.unwrap_or_else(|| self.records.clone())
    }

    /// The copy key of resource `name` as the store file `file` keeps it: the resource itself in its own file, or the
    /// key of the further store `file` is of it. `None` when `file` is no store of the resource here.
    fn key_of(&self, file: &Path, name: &str) -> Option<String> {
        let same = |one: &Path, other: &Path| one == other || one.canonicalize().ok().zip(other.canonicalize().ok()).is_some_and(|(one, other)| one == other);
        let own = self.own_path(name);
        if same(file, &own) {
            return Some(name.to_string());
        }
        let volume = &store_settings::shipped()?.volume_stores;
        (1..).map_while(|order| book_path(&own, order).filter(|book| book.exists()).map(|book| (order, book)))
            .find(|(_, book)| same(file, book))
            .map(|(order, _)| format!("{}{order}/{name}", volume.overflow_prefix))
    }

    fn limits(&self, supply: &impl Storage, path: &Path) -> Result<Limits, Error> {
        match (self.limits, &self.opener) {
            (Some(limits), _) => Ok(limits),
            (None, Some(opener)) => Ok(opener.limits()),
            (None, None) => crate::storage::record_store_resources::computer_limits(supply, path),
        }
    }

    fn open(&self, resource: &str) -> Result<RecordStore<ComputerStore>, Error> {
        if resource.starts_with('[') {
            let address = group_address(resource).ok_or(Error::Invalid("invalid group address", crate::cause!()))?;
            if self.state.is_none() || !placements::declares(&address.resource) {
                return Err(Error::Invalid("invalid group address", crate::cause!()));
            }
            address.history.resource(&self.owner)?;
        }
        let path = self.path(resource);
        let path = path.as_path();
        let supply: ComputerStore = match &self.opener {
            Some(opener) => opener.open(path)?,
            None => Box::new(sqlite::open_owned(path, SCHEMA, crate::storage::record_store_resources::bounds()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?),
        };
        let limits = self.limits(&supply, path)?;
        Ok(RecordStore::new(supply, Box::new(RealClock), limits)?.mirrored(true))
    }

    fn stamp(&self, resource: &str) -> Result<i64, Error> {
        self.open(resource)?.stamp(&self.owner, &named(resource))
    }

    fn page(&self, resource: &str, after: i64, limit: usize, history: usize) -> Result<(Vec<Carried>, bool), Error> {
        self.open(resource)?.carried_page(&self.owner, &named(resource), after, limit, history)
    }
}

/// Whether an answer fits in one carried message.
/// The refusal code of a settle refusal (old trillion's statuses).
fn settle_code(status: u16) -> &'static str {
    match status {
        400 => "settle_bad_request",
        409 => "settle_arrived_changed",
        413 => "settle_too_large",
        _ => "settle_unavailable",
    }
}

/// The status of a settle refusal code (`settle_code`), as the asker reports it.
fn settle_status(code: &str) -> u16 {
    match code {
        "settle_bad_request" => 400,
        "settle_not_answering" => 403,
        "settle_arrived_changed" => 409,
        "settle_too_large" => 413,
        _ => 503,
    }
}

fn fits(answer: &Answer) -> bool {
    serde_json::to_vec(answer).is_ok_and(|bytes| bytes.len() <= settings().message_body_bytes)
}

// ---------------------------------------------------------------------------------------------------------------
// Rolling back a change no writer acknowledged, and the account's account rows and root.

impl Copies {
    /// The stamp this computer held of `resource` when it took term `term` (it writes under it): what pages it sends
    /// carry as `base`. The committed stamp is read before the recorded one, so a write that commits in between has
    /// already recorded its base.
    fn base_of(&self, term: u64, resource: &str) -> i64 {
        let Ok(store) = self.records.open(resource) else { return 0 };
        let committed = store.stamp(&self.owner, &named(resource)).unwrap_or(0);
        match store.accepted(&self.owner, &named(resource)) {
            Ok((taken, base)) if taken == term => base,
            _ => committed,
        }
    }

    /// A writer's page under writer number `term` with base `base` reached this copy: when it is the first this copy hears of that
    /// term and the copy holds more of `resource` than `base`, the copy took a change no writer acknowledged, and rolls
    /// it back to `base`. Answers whether it rolled anything back.
    fn reconcile(&self, resource: &str, term: u64, base: i64) -> Result<bool, Error> {
        let mut store = self.records.open(resource)?;
        let floor = store.accepted_term(&self.owner, &named(resource))?;
        if term <= floor || store.stamp(&self.owner, &named(resource))? <= base {
            return Ok(false);
        }
        Ok(store.roll_back_after(&self.owner, &named(resource), base)? > 0)
    }

    fn log(&self) -> Log<'_> {
        Log { raw: &*self.sign_in_raw, owner: &self.owner }
    }

    /// This computer won term `term`: every copied account row gets a log row (so its feed holds every row), and the
    /// stamp it then holds is the base its sign-in pages carry.
    fn take_sign_in_term(&self, term: u64) {
        if !self.placed().may_answer {
            return;
        }
        let _one = locked(&self.sign_in);
        let log = self.log();
        let Ok(stamp) = log.log_unlogged_rows() else { return };
        if let Ok(counter) = log.counter() {
            if term > counter.term {
                let _ = log.set_counter(Counter { stamp, term, base: stamp });
            }
        }
        locked(&self.sign_in_heard).clear();
        locked(&self.granted).clear();
        // A computers row change its account rows hold (it caught it up before it claimed) is made under this term, as
        // every sign-in change it holds is: present once, never lost.
        let entry = self.row_entry();
        let row = log.row("places", &entry).ok().flatten().and_then(|body| serde_json::from_str::<ComputersRow>(&body.value).ok());
        drop(_one);
        if let (Some(row), Some(account_key)) = (row, self.account_key_hex()) {
            self.adopt(&KeptAccount { row, account_key }, term);
        }
    }

    /// The copied account rows made at this computer outside its copies (`Log::unlogged`: the sign-in command line, which
    /// runs as another process and writes the rows directly; a sign-up, which writes the account's first passkey before its
    /// copies run) made as one acknowledged sign-in change, as `rows_write` makes the account routes': the writer turn is
    /// claimed when nobody holds it, the change is sent to every computer that may answer first, and it gets its log rows
    /// here only once acknowledged. Not acknowledged: nothing is logged, the writer gives its writer turn up, and the next
    /// call tries again. At a computer that cannot hold the writer turn now (another computer holds it, or this one may not
    /// answer) nothing is done here: `Ok(None)`. Answers how many changes were made (`Ok(Some(0))`: none were waiting). At a
    /// computer that may answer while another computer holds the writer role, the rows go to that writer
    /// (`hand_outside_changes`), which makes them its own acknowledged change; they come back here through its sign-in feed.
    pub fn copy_outside_changes(&self) -> crate::storage::Result<Option<usize>> {
        use crate::storage::Error as StorageError;
        if self.removed() || !self.placed().may_answer {
            return Ok(None);
        }
        // A copy that starts its account rows again from the writer's feed has nothing of its own to send.
        if locked(&self.sign_in).resync.is_some() {
            return Ok(None);
        }
        if self.log().unlogged()?.is_empty() {
            return Ok(Some(0));
        }
        if self.holding().is_none() {
            self.claim_for_write();
        }
        if self.holding().is_none() {
            return self.hand_outside_changes();
        }
        let one = locked(&self.sign_in);
        let Some(term) = self.holding() else { return Ok(None) };
        let log = self.log();
        let unlogged = log.unlogged()?;
        if unlogged.is_empty() {
            return Ok(Some(0));
        }
        let mut counter = log.counter()?;
        let after = counter.stamp;
        let changes: Vec<RowChange> = unlogged.into_iter().map(|(family, id, row)| {
            counter.stamp += 1;
            RowChange { seq: counter.stamp, family, id, row }
        }).collect();
        let base = Self::sign_in_base_of(&counter, term);
        if let Err(applied) = self.sign_in_acknowledge(&log, term, base, after, &changes) {
            let error = crate::cause!(StorageError::Unavailable);
            let event = if applied { "gave-up" } else { "refused-kept-turn" };
            crate::quiet_eprintln!("computers-writer event={event} code=outside-sign-in-change-not-acknowledged cause={}", error.cause());
            drop(one);
            if applied { self.give_up(); }
            return Err(error);
        }
        let made = changes.iter().try_for_each(|change| log.apply(change))
            .and_then(|()| log.set_counter(Counter { stamp: counter.stamp, ..counter }));
        drop(one);
        if made.is_err() {
            self.give_up();
            return Err(crate::cause!(StorageError::Unavailable));
        }
        crate::quiet_eprintln!("computers-writer event=outside-sign-in-copied account={} computer={} rows={}", self.address, self.me, changes.len());
        Ok(Some(changes.len()))
    }

    /// The rows made here outside the copies, handed to the writer this computer's writer row names (`Message::
    /// OutsideChanges`), with no lock held while it answers (its acknowledgement sends them back here). `Ok(None)`: no
    /// writer is known, or it did not take them; they stay here, and the next call tries again.
    fn hand_outside_changes(&self) -> crate::storage::Result<Option<usize>> {
        let log = self.log();
        let mut rows = Vec::new();
        for (family, id, row) in log.unlogged()? {
            if family == rows_copy::computers() {
                continue;
            }
            let was = log.logged(&family, &id)?.and_then(|change| change.row).map(|body| body.value);
            rows.push(OutsideRow { family, id, row, was });
        }
        if rows.is_empty() {
            return Ok(Some(0));
        }
        let Some((writer, _, _)) = self.writer_row().filter(|(writer, _, _)| *writer != self.me) else { return Ok(None) };
        match self.send(&writer, &Message::OutsideChanges { rows }) {
            Some(Answer::Applied { stamp }) => {
                crate::quiet_eprintln!("computers-writer event=outside-sign-in-handed");
                Ok(Some(usize::try_from(stamp).unwrap_or(0)))
            }
            other => {
                let cause = match other {
                    Some(Answer::Refused { cause, .. }) => cause,
                    None => crate::cause!(sign_in outside_changes_no_answer),
                    Some(_) => crate::cause!(sign_in outside_changes_unexpected_answer),
                };
                crate::quiet_eprintln!("computers-writer event=outside-sign-in-not-handed cause={cause}");
                Ok(None)
            }
        }
    }

    /// The writer takes the rows another computer that may answer made outside its copies (`Message::OutsideChanges`):
    /// one acknowledged sign-in change (`rows_write`), each row only while the writer's own row still holds the value
    /// that computer logged (`was`), a row it never logged only when the writer has none. Refused at a computer that does
    /// not hold the writer role, from a computer the row does not let answer, and for the computers row.
    fn take_outside_changes(&self, from: &str, rows: Vec<OutsideRow>) -> Answer {
        if self.holding().is_none() || !self.placed().may_answer {
            return refused("not_the_writer", crate::cause!(peer refusal));
        }
        if !self.placed().row.may_answer.iter().any(|computer| computer == from) {
            return refused("not_answering", crate::cause!(peer refusal));
        }
        if rows.iter().any(|row| row.family == rows_copy::computers() || !rows_copy::copied(&row.family, &row.id))
        {
            return refused("invalid_message", crate::cause!(peer refusal));
        }
        let asked = rows.into_iter().map(|row| Asked {
            expect: match row.was { Some(was) => Expect::Value(was), None => Expect::Absent },
            family: row.family,
            id: row.id,
            row: row.row,
        }).collect();
        match self.rows_write(asked) {
            Ok(changed) => Answer::Applied { stamp: i64::try_from(changed).unwrap_or(i64::MAX) },
            Err(error) => refused("outside_change_refused", crate::refusal_cause::Caused::cause(&error)),
        }
    }

    fn sign_in_base_of(counter: &Counter, term: u64) -> u64 {
        if counter.term == term { counter.base } else { counter.stamp }
    }

    /// A change of the account's copied rows (`rows_copy::CopiedRows`). At the writer: the change gets the next stamps,
    /// goes to every may-answer computer, and is made here only once acknowledged (see the module doc); a change that is
    /// not acknowledged is not made, the writer gives its writer turn up, and the change is refused (a computers row the
    /// voters did not take is refused too, and the writer keeps its turn). At any other computer it is refused. Answers
    /// how many rows changed.
    pub(crate) fn rows_write(&self, asked: Vec<Asked>) -> crate::storage::Result<u64> {
        use crate::storage::Error as StorageError;
        // A rows change claims the writer turn as a records write does (`claim_for_write`) when nobody holds it: an
        // account that went idle, or whose writer gave its turn up, otherwise refused every computers row edit until some
        // records write came. The claim takes the rows lock itself.
        if self.holding().is_none() {
            self.claim_for_write();
        }
        let one = locked(&self.sign_in);
        let log = self.log();
        let Some(term) = self.holding().filter(|_| self.placed().may_answer) else {
            return Err(crate::cause!(StorageError::Unavailable));
        };
        let mut counter = log.counter()?;
        let after = counter.stamp;
        let mut changes = Vec::new();
        for asked in asked {
            let current = log.row(&asked.family, &asked.id)?;
            match (&asked.expect, &current) {
                (Expect::New, Some(_)) => return Err(crate::cause!(StorageError::Conflict)),
                (Expect::Absent, Some(_)) => continue,
                (Expect::Value(expected), Some(held)) if held.value != *expected => continue,
                (Expect::Value(_), None) => continue,
                _ => {}
            }
            if asked.row.is_none() && current.is_none() {
                continue;
            }
            counter.stamp += 1;
            changes.push(RowChange { seq: counter.stamp, family: asked.family, id: asked.id, row: asked.row });
        }
        if changes.is_empty() {
            return Ok(0);
        }
        // A change of the account's computers row is a change of who holds, answers and votes: it is made only once the
        // old and the new voters have taken it (`computers_acknowledge`), then as any sign-in change.
        let before = self.placed();
        let computers = self.computers_change(&changes, term).map_err(|error| StorageError::Invalid(error.cause()))?;
        if let Some(told) = &computers {
            // A proposed row is never acted on anywhere (`computers_acknowledge`), and nothing of it is made here: the
            // writer keeps its turn, so a refused edit does not also pause the account. Before, it gave the turn up
            // (as after a sign-in or records change not acknowledged, where another computer may hold what this one
            // could not make), and with two voters and one down each refused edit stopped the other from replying.
            if self.computers_acknowledge(term, &before, told).is_none() {
                let error = crate::cause!(StorageError::Unavailable);
                crate::quiet_eprintln!("computers-writer event=row-not-made cause={}", error.cause());
                return Err(error);
            }
        }
        let base = Self::sign_in_base_of(&counter, term);
        if let Err(applied) = self.sign_in_acknowledge(&log, term, base, after, &changes) {
            let error = crate::cause!(StorageError::Unavailable);
            let event = if applied { "gave-up" } else { "refused-kept-turn" };
            crate::quiet_eprintln!("computers-writer event={event} code=sign-in-not-acknowledged cause={}", error.cause());
            drop(one);
            if applied { self.give_up(); }
            return Err(error);
        }
        let made = changes.iter().try_for_each(|change| log.apply(change))
            .and_then(|()| log.set_counter(Counter { stamp: counter.stamp, ..counter }));
        if made.is_err() {
            // The other computers hold a change this computer could not make: it stops writing.
            drop(one);
            self.give_up();
            return Err(crate::cause!(StorageError::Unavailable));
        }
        drop(one);
        if let Some(told) = computers {
            self.adopt(&told, term);
            self.send_made(term, &before, &told);
            // A computer that held the root no longer answers: the account gets a new root, which it never receives.
            let lost = before.row.may_answer.iter().any(|computer| !told.row.may_answer.contains(computer));
            if lost && self.holds_secrets_key() {
                let _ = self.rekey();
            }
        }
        Ok(changes.len() as u64)
    }

    /// The account's computers row as one of `changes` sets it, with the account's key: `Ok(None)` when no change sets
    /// it; refused when the new row is not one this computer can check, is not newer than the one held, or moves more than
    /// one voter (`computers::one_voter_step`).
    fn computers_change(&self, changes: &[RowChange], term: u64) -> Result<Option<KeptAccount>, CodedError<()>> {
        let entry = self.row_entry();
        let Some(body) = changes.iter().rev().find(|change| change.family == "places" && change.id == entry).and_then(|change| change.row.as_ref())
        else {
            return Ok(None);
        };
        let row: ComputersRow = serde_json::from_str(&body.value).map_err(|_| CodedError::new(()))?;
        let account_key = self.account_key_hex().ok_or(CodedError::new(()))?;
        let told = KeptAccount { row, account_key };
        let held = self.placed();
        if !told.believed(&self.address) || (told.row.revision, term) <= held.mark()
            || !one_voter_step(&held.row.voters, &told.row.voters) || told.row.voters.is_empty()
        {
            return Err(CodedError::new(()));
        }
        // A computer becomes a voter only once it has caught up: a voter that is behind would hold every write until it
        // had (with two voters, both must hold each one), so a new voter must first hold, as a computer that keeps a copy that does not
        // vote, every change this writer holds of every resource it follows.
        if let Some(added) = told.row.voters.iter().find(|computer| !held.row.voters.contains(computer) && **computer != self.me) {
            if !self.caught_up(added) {
                return Err(CodedError::new(()));
            }
        }
        // Old trillion src/resource-state-carry.mjs:915-983 independently verifies the destination before activation. Being
        // joined and holding the record stamps alone does not prove that a surviving computer may answer: one that
        // joined an idle account can still await the live writer's sign-in census (`sign_in_follow`, `read_back`).
        // Refuse before any row proposal or sign-in change when this writer is removed from may-answer and none of
        // its successors has completed that existing check. The old writer keeps serving while they catch up.
        // The checked state persists through this row edit and a re-key: only joining clears read_back, and a new
        // root replaces the held one under the vault lock (`receive_secrets_key`), never as an unheld interval.
        if held.may_answer && !told.row.may_answer.contains(&self.me) {
            let ready = told.row.may_answer.iter().filter(|computer| **computer != self.me).any(|computer| {
                matches!(self.send(computer, &Message::Ready), Some(Answer::Done))
                    && self.caught_up(computer)
            });
            if !ready {
                return Err(CodedError::new(()));
            }
        }
        Ok(Some(told))
    }

    /// Whether `computer` reported holding every change this computer holds of every resource it follows (the stamps it
    /// reported when it pulled or took a page, `heard`).
    ///
    /// It is one fact with the computer's own `joined` (its joining marker): the computer is asked, and one that answers
    /// it has not caught up once since it was added, or does not answer, is behind. Before, the writer counted a computer
    /// caught up from its stamps alone while it still refused to vote, so a voter step made then left the writer with
    /// no majority (measured 2026-11-03: voters A,B, with B still holding its joining marker).
    pub fn caught_up(&self, computer: &str) -> bool {
        if computer != self.me {
            let answer = self.send(computer, &Message::Stamps);
            match &answer {
                Some(Answer::Stamps { joined: true, .. }) => super::copy_rule::note_keeper(&self.user, computer, false),
                Some(Answer::Refused { code, .. }) if code == "no_copies_here" => super::copy_rule::note_keeper(&self.user, computer, true),
                _ => {}
            }
            match answer {
                Some(Answer::Stamps { joined: true, .. }) => {}
                answer => {
                    let cause = match answer {
                        Some(Answer::Refused { cause, .. }) => cause,
                        None => crate::cause!(voter joined_status_unavailable),
                        Some(_) => crate::cause!(voter peer_not_joined),
                    };
                    crate::quiet_eprintln!("computers-voter event=behind cause={cause}");
                    return false;
                }
            }
        }
        let resources: Vec<String> = locked(&self.resources).iter().cloned().collect();
        resources.iter().all(|resource| {
            // As every stamp this computer reports (`stamp`, `stamps`): one its store does not answer is 0.
            let own = self.held(resource).1;
            let heard = self.heard(computer, resource);
            let held = heard.is_some_and(|stamp| stamp >= own);
            if !held {
                let cause = if heard.is_none() { crate::cause!(voter peer_stamp_unavailable) }
                    else { crate::cause!(voter peer_stamp_behind) };
                crate::quiet_eprintln!("computers-voter event=behind cause={cause}");
            }
            held
        })
    }

    /// The writer's acknowledgement of a new computers row `told`, under its term `term`, before it is made. The
    /// rule for a change of the voters:
    /// - it moves one voter at most (`computers_change`), so any majority of the old voters shares a computer with any
    ///   majority of the new ones, and one term number is never won by two computers of the two sets;
    /// - it starts only once the row held now is settled: a majority of its voters hold it as made (asked again here).
    ///   So two changes never overlap, and a computer still on a row two changes old cannot win: its majority shares a
    ///   voter with the majority that holds the next row, which refuses it (the row is an entry of the stamps);
    /// - before it is made, a majority of the old voters and of the new voters must have taken this writer's term (its
    ///   empty page) and keep the new row as proposed (`Message::Row` without `made`; they act on nothing yet). A row
    ///   that is never made is never taken anywhere: nobody catches it up later;
    /// - it is made as a sign-in change (acknowledged as any is), then sent as made to every computer of either row.
    /// Answers the computers that took it.
    fn computers_acknowledge(&self, term: u64, before: &Placed, told: &KeptAccount) -> Option<Vec<String>> {
        let next = Placed::with_kinds(&*self.sign_in_raw, &self.user, &told.row, term, &self.me);
        let mut targets: Vec<String> = before.peers.iter().chain(next.peers.iter()).cloned().collect();
        targets.sort();
        targets.dedup();
        let majority = |holds: &[String], voters: &[String]| holds.iter().filter(|computer| voters.contains(computer)).count() * 2 > voters.len();
        // Settled: a majority of the current voters hold the current row as made.
        let current = self.told_row()?;
        let mut settled = vec![self.me.clone()];
        for peer in &before.peers {
            let message = Message::Row { told: Some(current.clone()), term: before.term, made: true };
            if let Some(Answer::Row { told: Some(theirs), term: theirs_term, .. }) = self.send(peer, &message) {
                if (theirs.row.revision, theirs_term) >= before.mark() {
                    settled.push(peer.clone());
                }
            }
        }
        if !majority(&settled, &before.voters) {
            return None;
        }
        let took = self.tell_to(term, &targets);
        let mut holds = vec![self.me.clone()];
        for peer in &targets {
            let message = Message::Row { told: Some(told.clone()), term, made: false };
            if let Some(Answer::Row { pending: Some(mark), .. }) = self.send(peer, &message) {
                if mark == (told.row.revision, term) && took.contains(peer) {
                    holds.push(peer.clone());
                }
            }
        }
        let writer_role = locked(&self.writer_role).holding((self.clock)()) == Some(term);
        (writer_role && majority(&holds, &before.voters) && majority(&holds, &next.voters)).then_some(holds)
    }

    /// The writer made the row `told` under term `term`: send it as made to every computer of either row.
    fn send_made(&self, term: u64, before: &Placed, told: &KeptAccount) {
        let next = Placed::with_kinds(&*self.sign_in_raw, &self.user, &told.row, term, &self.me);
        let mut targets: Vec<String> = before.peers.iter().chain(next.peers.iter()).cloned().collect();
        targets.sort();
        targets.dedup();
        for peer in &targets {
            let _ = self.send(peer, &Message::Row { told: Some(told.clone()), term, made: true });
        }
    }

    /// The id of the account's computers row, which also names it among the stamps.
    fn row_entry(&self) -> String {
        Subject::Account(self.address.clone()).row_id()
    }

    /// The account's public key: as given (`with_account_key`) or learned with a row, else as the account's own key
    /// row at this computer keeps it, when it names this account's address.
    fn account_key_hex(&self) -> Option<String> {
        if let Some(key) = locked(&self.account_key).clone() {
            return Some(key);
        }
        let public = super::public_key(&Store::new(&*self.sign_in_raw), &self.owner).ok().flatten()?;
        (super::address_of(&public).as_deref() == Some(self.address.as_str())).then(|| {
            let hex: String = public.iter().map(|byte| format!("{byte:02x}")).collect();
            *locked(&self.account_key) = Some(hex.clone());
            hex
        })
    }

    /// This computer's computers row with the account's key, as it sends it.
    pub(crate) fn told_row(&self) -> Option<KeptAccount> {
        let placed = self.placed();
        // A row edit made here (`sign-in:set-places`) is written to the sign-in store and does not move `placed`, so the row
        // this computer tells is the newer of the two, by revision (a row at the same revision is the same row).
        let stored = crate::account::computers::read(&Store::new(&*self.sign_in_raw), &self.owner, &crate::account::computers::Subject::Account(self.address.clone()))
            .ok()
            .flatten()
            .map(|stored| stored.value)
            .filter(|stored| stored.revision > placed.row.revision);
        let row = stored.unwrap_or_else(|| placed.row.clone());
        Some(KeptAccount { row, account_key: self.account_key_hex()? })
    }

    /// Ask `peer` for its computers row (sending this computer's own), and take it when it is newer.
    fn pull_row(&self, peer: &str) {
        let message = Message::Row { told: self.told_row(), term: self.placed().term, made: true };
        if let Some(Answer::Row { told: Some(theirs), term, .. }) = self.send(peer, &message) {
            self.adopt(&theirs, term);
        }
    }

    /// Take `told` as the account's computers row, made under writer term `term`, when the account's key signed it
    /// for this account and it is newer than the row held: a higher revision, or the same revision made under a newer
    /// term. It takes effect at once: the voters the writer turn asks, the computers this computer sends to and answers, whether it
    /// may answer, and whether it is still a computer that keeps a copy. A computer the row no longer lets answer stops admitting, and forgets
    /// the secrets key and drops its sealed secrets key file; a computer the row no longer names gives the writer turn up and is removed.
    /// Answers whether the row changed.
    fn adopt(&self, told: &KeptAccount, term: u64) -> bool {
        if !told.believed(&self.address) {
            return false;
        }
        let (next, answered_before) = {
            let mut placed = locked(&self.placed);
            if told.row == placed.row {
                if term > placed.term {
                    *placed = Arc::new(Placed::with_kinds(&*self.sign_in_raw, &self.user, &told.row, term, &self.me));
                }
                return false;
            }
            if (told.row.revision, term) <= placed.mark() {
                return false;
            }
            let next = Arc::new(Placed::with_kinds(&*self.sign_in_raw, &self.user, &told.row, term, &self.me));
            let answered_before = placed.may_answer;
            *placed = next.clone();
            (next, answered_before)
        };
        {
            let mut key = locked(&self.account_key);
            if key.is_none() {
                *key = Some(told.account_key.clone());
            }
        }
        locked(&self.writer_role).set_voters(&next.voters);
        if !next.keeps_copy {
            self.give_up();
        }
        self.end_term_of_removed_writer(&next.voters);
        if !next.may_answer {
            self.fresh_until.store(i64::MIN, Ordering::Release);
            self.heard_at.store(i64::MIN, Ordering::Release);
            self.forget_secrets_key();
            self.keep_row(&told.row);
        } else if !answered_before {
            self.start_sign_in_again();
        }
        true
    }

    /// A computer that kept only a copy and is now let answer (docs/placement-decision/proofs.md): as a voter that may not
    /// answer it kept the writer's sign-in mark as its counter (`take_mark`) and no row, so the mark would say it holds
    /// every account row and it would never pull one; the first request it answered by itself would then find no key
    /// (measured: "Bearer authentication is required" once the computers that answered before were stopped). Its counter
    /// starts again from nothing, as a copy holding a change its writer never had does (`take_sign_in`), so its next step
    /// is behind and pulls every row from stamp 0 (`catch_up_stamps`, `sign_in_follow`), and it is not caught up, so it
    /// neither admits nor claims, until it holds them. Rows it kept (only the computers row, `keep_row`) are written again
    /// by the pull.
    fn start_sign_in_again(&self) {
        let _one = locked(&self.sign_in);
        if let Err(error) = self.log().set_counter(Counter::default()) {
            crate::quiet_eprintln!("computers-writer event=sign-in-restart-failed cause={}", error.cause());
        }
    }

    /// A computer that no longer answers the account forgets its root: the root and the older roots in memory, and its
    /// sealed secrets key file and keyring file. What it already read or copied elsewhere is out of reach.
    fn forget_secrets_key(&self) {
        let mut vault = locked(&self.vault);
        if let Some(old) = vault.root.take() {
            crate::secrets::secrets_key_replaced(&old);
        }
        vault.older.clear();
        vault.roots = SecretsKeys::default();
        if let Some(state) = vault.state.clone() {
            for file in [secrets_key::sealed_file(&state), secrets_key::keyring_file(&state)].into_iter().flatten() {
                let _ = std::fs::remove_file(file);
            }
        }
    }

    /// At a computer that does not answer (it gets no account rows), keep the newest computers row in its own account rows,
    /// so it starts again with it.
    fn keep_row(&self, row: &ComputersRow) {
        let store = Store::new(&*self.sign_in_raw);
        let kept = crate::account::rows::store::Row { id: self.row_entry(), account: self.owner.clone(), expires_at: 0, value: row.clone() };
        let older = store.get::<ComputersRow>(crate::account::rows::store::Family::Computers, &kept.id).ok().flatten()
            .is_none_or(|held| held.value.revision < row.revision);
        if older {
            let _ = store.put(crate::account::rows::store::Family::Computers, &kept);
        }
    }

    /// Re-key the account: at the writer, holding the root, make a new root; keep the old one, and the older ones it
    /// kept, in the keyring sealed under the new root; keep the new root in computer of the old (the sealed secrets key file under
    /// this computer's key; at the hosting app, whose vault opens with the root its app keeps, that is a gap: its app's
    /// blob is not replaced, src/native_entry/computer/hosting.rs); seal the
    /// secrets snapshot again under it (an acknowledged vault write); and from then on send the new root, sealed to
    /// each computer's own key, with the keyring, only to the computers the row lets answer. Records sealed under an older
    /// root are not sealed again: opening takes the keyring.
    pub fn rekey(&self) -> Result<(), CodedError<&'static str>> {
        if self.holding().is_none() {
            return Err(CodedError::new("only the writer re-keys"));
        }
        let next = secrets_key::generate().map_err(|error| CodedError::with_cause("no new root", error.cause()))?;
        let (old, keyring, computer_key, state) = {
            let vault = locked(&self.vault);
            let current = vault.root.as_ref().ok_or(CodedError::new("this computer holds no root"))?;
            let held = Keyring::new(current.duplicate(), vault.older.iter().map(SecretsKey::duplicate).collect()).map_err(|error| CodedError::with_cause("the keyring is refused", error.cause()))?;
            let keyring = held.rotated(next).map_err(|error| CodedError::with_cause("the keyring is refused", error.cause()))?;
            (current.duplicate(), keyring, vault.computer_key.clone(), vault.state.clone())
        };
        if let (Some(computer_key), Some(state)) = (&computer_key, &state) {
            // The keyring first: a stop between the two leaves the old root kept, and a keyring it does not open
            // (read as no older root).
            secrets_key::write_keyring(state, &keyring).map_err(|error| CodedError::with_cause("the keyring was not kept", error.cause()))?;
            secrets_key::replace_sealed(state, keyring.current(), computer_key).map_err(|error| CodedError::with_cause("the new root was not kept", error.cause()))?;
        }
        {
            let mut vault = locked(&self.vault);
            vault.root = Some(keyring.current().duplicate());
            vault.older = keyring.older().iter().map(SecretsKey::duplicate).collect();
            // Copy-only computers get values sealed under the new root from now on; the older roots still open.
            vault.roots = secrets_keys_of(vault.root.as_ref(), &vault.older);
        }
        crate::secrets::secrets_key_replaced(&old);
        self.reseal_due.store(true, Ordering::Release);
        self.reseal();
        Ok(())
    }

    /// The last re-key this computer resealed, or `None` when it has resealed none since it started.
    pub fn last_rekey(&self) -> Option<RekeyReport> {
        locked(&self.last_rekey).clone()
    }

    /// Seal the secrets snapshot again under the current root, as an acknowledged vault write. Answers whether it is
    /// done; when not, the writer tries again on its timer step.
    fn reseal(&self) -> bool {
        let Some(keyring) = self.keyring() else { return false };
        if self.records.vault.is_none() {
            self.reseal_due.store(false, Ordering::Release);
            return true;
        }
        let owner = self.owner.clone();
        let done = self.write_vault(|store| crate::secrets::reseal_snapshot(store, &owner, &keyring).map_err(|error| crate::carry_cause!(Error::Unavailable, error)));
        if let Ok(Some(names)) = &done {
            let report = RekeyReport { account: self.address.clone(), computer: self.me.clone(), names: names.clone() };
            crate::quiet_eprintln!("{report}");
            *locked(&self.last_rekey) = Some(report);
        }
        if done.is_ok() {
            self.reseal_due.store(false, Ordering::Release);
        }
        done.is_ok()
    }

    /// The acknowledgement of sign-in `changes` (stamps after `after`) under writer number `term`: send them to every may-answer
    /// computer; true once one of them holds them all (when there is another may-answer computer) and every may-answer computer
    /// holds them or can no longer admit from its copy (the time this writer gave it ran out), while this computer still
    /// holds the writer turn and its writer row copy names it.
    fn sign_in_acknowledge(&self, log: &Log<'_>, term: u64, base: u64, after: u64, changes: &[RowChange]) -> Result<(), bool> {
        let top = changes.last().map_or(after, |change| change.seq);
        let deadline = self.deadline_in(settings().ack_wait_ms);
        let placed = self.placed();
        let peers: Vec<String> = placed.may_answer_peers.clone();
        let mut answers: Vec<(String, u64, String)> = Vec::new();
        // The message to `peer` from its stamp `from`: the held rows after it and this write's changes after it; None when
        // it is longer than `carried_bytes` (longer than one message, it travels in parts, `send`, up to that).
        let message_from = |from: u64| -> Option<Message> {
            let mut sending: Vec<RowChange> = if from < after { log.page(from, usize::MAX).ok()?.0 } else { Vec::new() };
            sending.extend(changes.iter().filter(|change| change.seq > from).cloned());
            let message = Message::SignIn { term, base, after: from, changes: sending };
            serde_json::to_vec(&Post { message: message.clone() }).ok().filter(|bytes| bytes.len() <= settings().carried_bytes).map(|_| message)
        };
        // Every computer that may answer at once (`send_all`): one out of reach delays no other. Each is sent at most two
        // messages: this write's changes, then, when it answers that it is behind, everything after the stamp it holds.
        let mut from_of: HashMap<String, (u64, usize)> = HashMap::new();
        let mut first = Vec::new();
        if let Some(message) = message_from(after) {
            for peer in &peers {
                from_of.insert(peer.clone(), (after, 1));
                first.push((peer.clone(), message.clone()));
            }
        }
        // Whether any copy applied this change, and which copies answered at all: a refused change keeps the writer turn
        // only when no copy holds it (the turn moves on when one does).
        let mut applied = false;
        let mut replied: HashSet<String> = HashSet::new();
        self.send_all(first, deadline, &mut |peer, answer, more| {
            let Some((from, sent)) = from_of.get(peer).copied() else { return false };
            if answer.is_some() { replied.insert(peer.to_string()); }
            answers.push((peer.chars().take(8).collect(), from, format!("{answer:?}")));
            match answer {
                Some(Answer::Applied { stamp }) => {
                    applied = true;
                    locked(&self.sign_in_heard).insert(peer.to_string(), u64::try_from(stamp).unwrap_or(0));
                }
                Some(Answer::Behind { stamp }) if sent < 2 && u64::try_from(stamp).is_ok_and(|stamp| stamp < from) => {
                    let from = u64::try_from(stamp).unwrap_or(0);
                    if let Some(message) = message_from(from) {
                        from_of.insert(peer.to_string(), (from, sent + 1));
                        more.push((peer.to_string(), message));
                    }
                }
                _ => {}
            }
            false
        });
        let holds = |heard: &HashMap<String, u64>, peer: &String| heard.get(peer).is_some_and(|stamp| *stamp >= top);
        let second = peers.is_empty() || peers.iter().any(|peer| holds(&locked(&self.sign_in_heard), peer));
        // The voters that may not answer hold no sign-in row: once a may-answer computer holds the change, each is told
        // its mark, so it refuses a takeover from a computer whose account rows hold less.
        if second {
            for voter in placed.voters.iter().filter(|voter| **voter != self.me && !placed.may_answer_peers.contains(voter)) {
                if self.waiting.now_ms() >= deadline || self.sign_in_majority(&placed, top) {
                    break;
                }
                if let Some(Answer::Applied { stamp }) = self.send(voter, &Message::SignInMark { term, stamp: top }) {
                    locked(&self.sign_in_heard).insert(voter.clone(), u64::try_from(stamp).unwrap_or(0));
                }
            }
        }
        // A peer may have stopped just after the voters vouched for its read admission. An early transport
        // refusal does not end that known grant, but it need not discard this new writer's term either. Wait only
        // for the latest known admission end, within this acknowledgement's existing deadline, then recheck all
        // authority below. No sign-in change counts before that end and no message is sent again by this wait.
        if second && self.sign_in_majority(&placed, top) && locked(&self.writer_role).holding((self.clock)()) == Some(term) {
            let until = {
                let heard = locked(&self.sign_in_heard);
                let granted = locked(&self.granted);
                let vouched = locked(&self.vouched);
                peers.iter().filter(|peer| !holds(&heard, peer))
                    .flat_map(|peer| [granted.get(peer).copied(), vouched.get(peer).copied()]).flatten().max()
            };
            if let Some(until) = until {
                let remaining = until.saturating_sub((self.clock)()).max(0) as u64;
                let wait = Duration::from_millis(remaining).min(Duration::from_millis(self.left_ms(deadline).max(0) as u64));
                if !wait.is_zero() { self.waiting.wait_expiry(wait); }
            }
        }
        let writing = locked(&self.writer_role).holding((self.clock)()) == Some(term)
            && self.writer_rows.read(&self.id).ok().flatten().is_some_and(|row| row.writer == self.me && row.term == term);
        let majority = self.sign_in_majority(&placed, top);
        // A copy that is absent or behind never blocks while a majority holds the mark: the change is durable once the writer
        // holds it under its term and a majority of voters has its mark; the copies that answered catch up through settle.
        if !(writing && majority) {
            let cause = if !writing { crate::cause!(sign_in writer_role_changed) }
                else { crate::cause!(sign_in voting_majority_not_acknowledged) };
            crate::quiet_eprintln!("computers-writer event=sign-in-refused cause={cause} replied={}", replied.len());
        }
        if writing && majority { Ok(()) } else { Err(applied) }
    }

    /// Whether this computer (when it votes) and the voters that hold sign-in stamp `top` (its rows, or its mark at a
    /// voter that may not answer) are a majority of the voters.
    fn sign_in_majority(&self, placed: &Placed, top: u64) -> bool {
        let heard = locked(&self.sign_in_heard);
        let count = usize::from(placed.voters.contains(&self.me))
            + placed.voters.iter().filter(|voter| **voter != self.me && heard.get(*voter).is_some_and(|stamp| *stamp >= top)).count();
        count * 2 > placed.voters.len()
    }

    /// A writer's sign-in mark at a voter that may not answer (`Message::SignInMark`): kept as its sign-in counter (no
    /// row), so it votes against a claimer whose account rows hold less. Refused below the term its writer row holds.
    fn take_mark(&self, id: &str, term: u64, stamp: u64) -> Answer {
        if self.placed().may_answer {
            return refused("answering_computer_takes_rows", crate::cause!(peer refusal));
        }
        let row_term = self.writer_rows.read(id).ok().flatten().map_or(0, |row| row.term);
        if term < row_term {
            return refused("stale_writer", crate::cause!(peer refusal));
        }
        let _one = locked(&self.sign_in);
        let log = self.log();
        let counter = match log.counter() { Ok(value) => value, Err(error) => { return refused("sign_in_unavailable", error.cause()) } };
        let next = if term > counter.term { Counter { stamp, term, base: 0 } } else if term == counter.term { Counter { stamp: counter.stamp.max(stamp), ..counter } } else { return refused("stale_writer", crate::cause!(peer refusal)) };
        if let Err(error) = log.set_counter(next) { return refused("sign_in_unavailable", error.cause()); }
        Answer::Applied { stamp: i64::try_from(next.stamp).unwrap_or(i64::MAX) }
    }

    /// A writer's sign-in push at this computer (it may answer). Refused below the newest term this computer took sign-in
    /// changes from; the first push of a newer term with a base below this computer's stamp means this copy holds a change
    /// that writer never had: it starts again from nothing (and answers that it holds nothing).
    #[allow(clippy::too_many_arguments)]
    fn take_sign_in(&self, id: &str, now: i64, term: u64, base: u64, after: u64, changes: &[RowChange]) -> Answer {
        if !self.placed().may_answer {
            return refused("not_answering", crate::cause!(peer refusal));
        }
        let row_term = self.writer_rows.read(id).ok().flatten().map_or(0, |row| row.term);
        if term < row_term {
            return refused("stale_writer", crate::cause!(peer refusal));
        }
        {
            let mut writer_role = locked(&self.writer_role);
            match writer_role.holding(now) {
                Some(held) if held >= term => return refused("stale_writer", crate::cause!(peer refusal)),
                Some(_) => {
                    writer_role.give_up();
                    self.epoch.fetch_add(1, Ordering::AcqRel);
                }
                None => {}
            }
        }
        let mut state = locked(&self.sign_in);
        let log = self.log();
        let mut counter = match log.counter() { Ok(value) => value, Err(error) => { return refused("sign_in_unavailable", error.cause()) } };
        if term < counter.term {
            return refused("stale_writer", crate::cause!(peer refusal));
        }
        if term > counter.term {
            if counter.stamp > base {
                self.start_over(&log, &mut state, term, base);
                return Answer::Behind { stamp: 0 };
            }
            counter.term = term;
            counter.base = base;
        }
        if counter.stamp < after || state.resync.is_some() {
            let _ = log.set_counter(counter);
            return Answer::Behind { stamp: i64::try_from(counter.stamp).unwrap_or(0) };
        }
        if let Err(error) = self.apply_rows(&log, &mut state, &mut counter, changes, false) { return refused("sign_in_unavailable", error.cause()); }
        Answer::Applied { stamp: i64::try_from(counter.stamp).unwrap_or(i64::MAX) }
    }

    /// Start this copy's account rows again from nothing under term `term`: it stops admitting, and pulls the
    /// writer's whole feed; once it has, every copied row the feed did not name is removed.
    fn start_over(&self, log: &Log<'_>, state: &mut SignInState, term: u64, base: u64) {
        self.fresh_until.store(i64::MIN, Ordering::Release);
        self.heard_at.store(i64::MIN, Ordering::Release);
        state.resync = Some(HashMap::new());
        let _ = log.set_counter(Counter { stamp: 0, term, base });
    }

    /// Apply `changes` (oldest first) to this copy and move its stamp; `counter` is written back.
    /// With `adopt_row` (pages from the writer, which hold only changes it made), a computers row among them is taken.
    fn apply_rows(&self, log: &Log<'_>, state: &mut SignInState, counter: &mut Counter, changes: &[RowChange], adopt_row: bool) -> crate::storage::Result<()> {
        for change in changes {
            let held = match &state.resync {
                Some(named) => named.get(&(change.family.clone(), change.id.clone())).copied(),
                None => log.logged(&change.family, &change.id)?.map(|logged| logged.seq),
            };
            if held.is_none_or(|held| held < change.seq) {
                log.apply(change)?;
            }
            if let Some(named) = &mut state.resync {
                let seq = named.entry((change.family.clone(), change.id.clone())).or_insert(change.seq);
                *seq = (*seq).max(change.seq);
            }
            counter.stamp = counter.stamp.max(change.seq);
        }
        log.set_counter(*counter)?;
        if !adopt_row {
            return Ok(());
        }
        // The account's computers row came with the account rows: take it, as made under the term the rows came from.
        let entry = self.row_entry();
        let row = changes.iter().rev().find(|change| change.family == "places" && change.id == entry)
            .and_then(|change| change.row.as_ref())
            .and_then(|body| serde_json::from_str::<ComputersRow>(&body.value).ok());
        if let (Some(row), Some(account_key)) = (row, self.account_key_hex()) {
            self.adopt(&KeptAccount { row, account_key }, counter.term);
        }
        Ok(())
    }

    /// Pull the sign-in feed of `writer` into this copy (it may answer), and with it, from the writer, the time it may
    /// admit from its copy and, when it holds none, the secrets key sealed to its own key. Before a claim the same pull
    /// catches up from any may-answer computer that holds more (it then gives no time to admit). A refused pull is logged
    /// with its reason and its count in a row; the next pull waits the DATA backoff (doubling from the base, up to the max), and
    /// the count reaching `sign_in_pull_alarm_after` logs one alarm. A pull that goes through resets the count.
    fn sign_in_follow(&self, writer: &str, from_writer: bool) -> PullOutcome {
        let now = (self.clock)();
        if locked(&self.pull_backoff).get(writer).is_some_and(|backoff| now < backoff.retry_at) {
            return PullOutcome::Refused(PullReason::new("backing-off", crate::cause!()));
        }
        let Err(reason) = self.pull_sign_in(writer, from_writer) else {
            locked(&self.pull_backoff).remove(writer);
            return PullOutcome::Pulled;
        };
        let settings = settings();
        let (failures, wait) = {
            let mut backoffs = locked(&self.pull_backoff);
            let backoff = backoffs.entry(writer.to_string()).or_insert(PullBackoff { failures: 0, retry_at: i64::MIN });
            backoff.failures = backoff.failures.saturating_add(1);
            let wait = pull_backoff_ms(backoff.failures, settings.sign_in_pull_retry_base_ms, settings.sign_in_pull_retry_max_ms);
            backoff.retry_at = now.saturating_add(wait);
            (backoff.failures, wait)
        };
        crate::quiet_eprintln!("computers-join event=sign-in-pull-refused account={} computer={} writer={writer} reason={} failures={failures} retry_in_ms={wait}",
            self.address, self.me, reason.word);
        if failures == settings.sign_in_pull_alarm_after {
            crate::quiet_eprintln!("computers-join event=sign-in-pull-alarm account={} computer={} writer={writer} failures={failures}", self.address, self.me);
        }
        PullOutcome::Refused(reason)
    }

    /// Pull the sign-in feed of `writer` into this copy (it may answer), and with it, from the writer, the time it may
    /// admit from its copy and, when it holds none, the secrets key sealed to its own key. Before a claim the same pull
    /// catches up from any may-answer computer that holds more (it then gives no time to admit).
    fn pull_sign_in(&self, writer: &str, from_writer: bool) -> Result<(), PullReason> {
        let limit = settings().sign_in_page_items;
        for _ in 0..1024 {
            let (after, needs_secrets_key, root_identity) = {
                let _one = locked(&self.sign_in);
                let Ok(counter) = self.log().counter() else { return Err(PullReason::new("counter-unreadable", crate::cause!())) };
                let vault = locked(&self.vault);
                let identity = vault.root.as_ref().and_then(|root| secrets_key::key_identity(root).ok());
                (counter.stamp, vault.computer_key.is_some() && vault.root.is_none(), identity)
            };
            let sent = (self.clock)();
            let Some(Answer::SignInPage { term, base, changes, more, stamp, fresh_ms, root, keyring, census }) =
                self.send(writer, &Message::SignInPull { after, limit, needs_secrets_key, root_identity })
            else {
                return Err(PullReason::new("no-answer", crate::cause!()));
            };
            if let Some(root) = root {
                self.receive_secrets_key(&root, keyring.as_deref());
            }
            let mut state = locked(&self.sign_in);
            let log = self.log();
            let Ok(mut counter) = log.counter() else { return Err(PullReason::new("counter-unreadable", crate::cause!())) };
            if term < counter.term || counter.stamp != after {
                return Err(PullReason::new("writer-term-or-stamp-moved", crate::cause!()));
            }
            if term > counter.term {
                if counter.stamp > base {
                    self.start_over(&log, &mut state, term, base);
                    continue;
                }
                counter.term = term;
                counter.base = base;
            }
            if self.apply_rows(&log, &mut state, &mut counter, &changes, from_writer).is_err() {
                return Err(PullReason::new("rows-refused", crate::cause!()));
            }
            if more {
                continue;
            }
            counter.stamp = counter.stamp.max(stamp);
            if let Some(named) = state.resync.take() {
                let kept: HashSet<(String, String)> = named.into_keys().collect();
                if log.drop_unnamed(&kept).is_err() {
                    state.resync = Some(HashMap::new());
                    return Err(PullReason::new("resync-refused", crate::cause!()));
                }
            }
            let _ = log.set_counter(counter);
            if fresh_ms > 0 && self.placed().may_answer {
                self.fresh_until.store(sent.saturating_add(fresh_ms), Ordering::Release);
                self.heard_at.store(sent, Ordering::Release);
            }
            // The read-back: once this copy's rows match the writer's (it answered with a fresh grant, so it holds the
            // writer turn) by count and identity in every family, this computer may take calls (`answers_now`).
            if from_writer && fresh_ms > 0 && !self.read_back.load(Ordering::Acquire) {
                match (census, log.census()) {
                    (Some(theirs), Ok(ours)) if theirs == ours => {
                        self.read_back.store(true, Ordering::Release);
                        crate::quiet_eprintln!("computers-join event=read-back-matched account={} computer={}", self.address, self.me);
                    }
                    (Some(_), Ok(_)) => {
                        crate::quiet_eprintln!("computers-join event=read-back-differs cause={}", crate::cause!(sign_in census_differs_from_writer));
                    }
                    _ => {}
                }
            }
            return Ok(());
        }
        Err(PullReason::new("too-many-pages", crate::cause!()))
    }

    /// The writer's answer to a sign-in pull from `from`, a computer the row lets answer: one page of its copy log, and,
    /// when nothing more follows, the time `from` may admit from its copy (never past this computer's own term) and,
    /// when asked, the secrets key sealed to `from`'s own key.
    fn answer_sign_in_pull(&self, from: &str, now: i64, after: u64, limit: usize, needs_secrets_key: bool, root_identity: Option<&str>) -> Answer {
        if !self.placed().may_answer_peers.iter().any(|peer| peer == from) {
            return refused("not_answering", crate::cause!(peer refusal));
        }
        let holding = locked(&self.writer_role).holding(now);
        // The root goes to a computer that asks for it, and to one that holds another root than this computer's (a re-key):
        // sealed to its own key, with the older roots sealed under it.
        let (root, keyring) = match self.keyring() {
            Some(keyring) if needs_secrets_key || root_identity.is_some_and(|held| secrets_key::key_identity(keyring.current()).is_ok_and(|current| current != held)) => {
                let sealed = secrets_key::seal_to_computer(keyring.current().as_bytes(), from).ok().and_then(|sealed| String::from_utf8(sealed).ok());
                let older = if keyring.older().is_empty() {
                    None
                } else {
                    use base64::Engine as _;
                    keyring.sealed_older().ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
                };
                (sealed, older)
            }
            _ => (None, None),
        };
        let _one = locked(&self.sign_in);
        let log = self.log();
        let counter = match log.counter() { Ok(value) => value, Err(error) => { return refused("sign_in_unavailable", error.cause()) } };
        let (term, base) = match holding {
            Some(term) => (term, Self::sign_in_base_of(&counter, term)),
            None => (counter.term, counter.base),
        };
        let mut limit = limit.clamp(1, settings().sign_in_page_items);
        loop {
            let (changes, more) = match log.page(after, limit) { Ok(value) => value, Err(error) => return refused("sign_in_unavailable", crate::refusal_cause::Caused::cause(&error)) };
            let fresh_ms = if more || holding.is_none() {
                0
            } else {
                let ends = locked(&self.writer_role).valid_until(now).unwrap_or(now);
                settings().admit_ms.min(ends - now).max(0)
            };
            let census = if more { None } else { log.census().ok() };
            let answer = Answer::SignInPage { term, base, changes, more, stamp: counter.stamp, fresh_ms, root: root.clone(), keyring: keyring.clone(), census };
            if limit == 1 || fits(&answer) {
                if fresh_ms > 0 {
                    locked(&self.granted).insert(from.to_string(), now + fresh_ms);
                }
                return answer;
            }
            limit = (limit / 2).max(1);
        }
    }

    /// The secrets key another computer sent this one, sealed to this computer's own key: opened, kept sealed to this
    /// computer's key in the account's state folder, and held, so this computer can send it on when it writes.
    ///
    /// A root other than the one this computer holds is a re-key: the older roots come with it (`keyring`, sealed under
    /// the new root, base64). The keyring is kept first, then the new root replaces the old sealed secrets key file, and the
    /// old root is retired in this process (`secrets::secrets_key_replaced`), so the account's vault opens again with the
    /// new root and its keyring. The new root seals from now on and every keyring root opens (`sealed::SecretsKeys`); with
    /// the root, this computer opens what it kept sealed (`open_held`).
    fn receive_secrets_key(&self, sealed: &str, keyring: Option<&str>) {
        use base64::Engine as _;
        {
            let mut vault = locked(&self.vault);
            if !self.placed().may_answer {
                return;
            }
            let (Some(key), Some(state)) = (vault.computer_key.clone(), vault.state.clone()) else { return };
            let Ok(root) = secrets_key::open_sent_key(sealed.as_bytes(), &key, &settings().computer_id_context) else { return };
            let identity = secrets_key::key_identity(&root).ok();
            let held = vault.root.as_ref().and_then(|held| secrets_key::key_identity(held).ok());
            if held.is_some() && held == identity {
                return;
            }
            let sealed_older = keyring.and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok());
            let Ok(keyring) = Keyring::open(root.duplicate(), sealed_older.as_deref()) else { return };
            // A root this computer held and the keyring does not name stays an older root here (it only opens).
            let mut older: Vec<SecretsKey> = keyring.older().iter().map(SecretsKey::duplicate).collect();
            if let Some(old) = vault.root.as_ref() {
                if keyring.get(&secrets_key::key_identity(old).unwrap_or_default()).is_none() {
                    older.push(old.duplicate());
                }
            }
            let keyring = match Keyring::new(root.duplicate(), older) {
                Ok(keyring) => keyring,
                Err(_) => return,
            };
            match vault.root.take() {
                None => {
                    let kept = secrets_key::sealed_file(&state).is_ok_and(|file| file.exists()) || secrets_key::write_sealed(&state, &root, &key).is_ok();
                    if !kept {
                        return;
                    }
                    if !keyring.older().is_empty() {
                        let _ = secrets_key::write_keyring(&state, &keyring);
                    }
                }
                Some(old) => {
                    if !(secrets_key::write_keyring(&state, &keyring).is_ok() && secrets_key::replace_sealed(&state, &root, &key).is_ok()) {
                        vault.root = Some(old);
                        return;
                    }
                    crate::secrets::secrets_key_replaced(&old);
                }
            }
            vault.older = keyring.older().iter().map(SecretsKey::duplicate).collect();
            vault.roots = secrets_keys_of(Some(&root), &vault.older);
            vault.root = Some(root);
        }
        let _ = self.open_held();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The copies running at this computer, by account owner id: a records write the account's routes commit asks them first.

fn running() -> &'static Mutex<HashMap<String, Weak<Copies>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Weak<Copies>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Keep `copies` as the copies of its account at this computer, while it lives: the account routes' records writes and every
/// write of the vault file it follows go through it.
pub fn register(copies: &Arc<Copies>) {
    locked(running()).insert(copies.owner.clone(), Arc::downgrade(copies));
    register_vault(copies);
}

/// The vault files the copies running at this computer follow (`Copies::with_vault`), by their path with no link in the
/// folder (`secrets::canonical_file`); and the vault files of accounts whose copies are to start (`expect_vault`).
fn vaults() -> &'static Mutex<(HashMap<PathBuf, Weak<Copies>>, HashSet<PathBuf>)> {
    static VAULTS: OnceLock<Mutex<(HashMap<PathBuf, Weak<Copies>>, HashSet<PathBuf>)>> = OnceLock::new();
    VAULTS.get_or_init(|| Mutex::new((HashMap::new(), HashSet::new())))
}

/// Keep `copies` as what every write of the vault file it follows goes through, while it lives (`vault_gate`). Done by
/// `register`; on its own where several computers of one account run in one process (tests), since `register` keeps one
/// copies per account for records writes.
pub fn register_vault(copies: &Arc<Copies>) {
    if let Some(file) = copies.records.vault.as_deref().and_then(crate::secrets::canonical_file) {
        let mut vaults = locked(vaults());
        vaults.1.remove(&file);
        vaults.0.insert(file, Arc::downgrade(copies));
    }
}

/// The account whose vault is the file `file` gets copies at this computer, which have not started yet (a computer opens
/// the vault for the account's signing key before its copies start): until they run, every write of that file is
/// refused and a read of it writes nothing.
pub fn expect_vault(file: &Path) {
    if let Some(file) = crate::secrets::canonical_file(file) {
        locked(vaults()).1.insert(file);
    }
}

/// What a write of a vault goes through (src/secrets.rs `Secrets::write_unit`).
pub enum VaultGate {
    /// No copies follow this vault: it is written on its own store, as before.
    Free,
    /// The account's copies at this computer follow this vault file: a write is `Copies::write_vault` (only at the
    /// writer, committed only once a majority of the voters hold it).
    Copies(Arc<Copies>),
    /// This vault is a copy no running copies here write through (their start is awaited, or the store says it took a
    /// writer's term, so it follows a writer elsewhere or did): every write is refused; a read writes nothing.
    Closed,
}

/// The gate of a vault of account `owner` whose store is `store`, kept in the file `file` (`None`: not a file). The
/// running copies that follow the file first; then a file whose copies are awaited; then the store itself: a vault
/// store that took a writer's term (`RecordStore::accepted_term` of the secrets resource above 0) is part of an
/// account's copies, so no other way may write it, in this process or another.
pub fn vault_gate<S: Storage>(file: Option<&Path>, owner: &str, store: &RecordStore<S>) -> VaultGate {
    if let Some(file) = file {
        let vaults = locked(vaults());
        if let Some(copies) = vaults.0.get(file).and_then(Weak::upgrade) {
            return VaultGate::Copies(copies);
        }
        if vaults.1.contains(file) {
            return VaultGate::Closed;
        }
    }
    let Ok(resource) = crate::secrets::resource() else { return VaultGate::Closed };
    match store.accepted_term(owner, resource) {
        Ok(0) => VaultGate::Free,
        _ => VaultGate::Closed,
    }
}

/// The account `owner`'s copies running at this computer, when they run here.
pub(crate) fn running_for(owner: &str) -> Option<Arc<Copies>> {
    locked(running()).get(owner).and_then(Weak::upgrade)
}

/// Whether the account `owner`'s copy at this computer is still catching up: its answers may leave out records it has not
/// fetched yet, so a list says so (`filling`). False when no copies run here for the account.
pub(crate) fn still_filling(owner: &str) -> bool {
    running_for(owner).is_some_and(|copies| copies.filling())
}

/// Whether a computers row naming `voters` would add a voter that has not caught up with the account's copies running at
/// this computer (`Copies::caught_up`): the writer refuses such a row (`computers_change`), so the account's routes refuse it plainly
/// first (`computers_voter_behind`). With no copies running here (no voters yet), nothing is behind.
pub fn adds_a_voter_behind(owner: &str, voters: &[String]) -> bool {
    let Some(copies) = locked(running()).get(owner).and_then(Weak::upgrade) else { return false };
    let held = copies.placed();
    voters.iter().any(|computer| !held.row.voters.contains(computer) && *computer != copies.me && !copies.caught_up(computer))
}

/// The commit gate of a records write of the account `owner` at this computer, run on the write's open transaction
/// `connection` just before it commits. With no copies running for the account (no voters), it lets the write
/// commit as before. Otherwise the write commits only once a second copy holds it; an error means roll back.
pub(crate) fn before_commit(owner: &str, connection: &Connection) -> Result<(), WriteRefused> {
    before_commit_checked(owner, connection)
}

/// A native command acquires its writer turn before borrowing a physical write transaction, just as `write_at`
/// does. Claiming may catch up and take terms in those same stores, so it must never run inside that transaction.
/// This grants no caller rights: the admitted command repeats its current-rights and source checks afterward,
/// and `before_commit` still fences the term and requires acknowledgement. Original-result recovery never calls it.
pub(crate) fn before_write(owner: &str) -> Result<(), WriteRefused> {
    let Some(copies) = running_for(owner) else { return Ok(()) };
    copies.prepare_write_turn()
}

/// Capture is required whenever this account has a running replication owner.
pub(crate) fn capture_required(owner: &str) -> bool {
    running_for(owner).is_some()
}

/// A complete domain frame is acknowledged on the caller's held supply. An
/// unchanged retry may carry no frame; changed resources may not.
pub(crate) fn before_domain_storage_commit(
    owner: &str,
    storage: &dyn Storage,
    domain: &GroupDomain,
    captured: Option<&CapturedCommit>,
) -> Result<(), WriteRefused> {
    let Some(copies) = running_for(owner) else { return Ok(()) };
    match copies.acknowledge_captured(storage, domain, captured) {
        Ok(()) => Ok(()),
        Err(WriterError::Storage(cause)) => Err(WriteRefused::Records(Error::Unavailable(cause.clone()), cause)),
        Err(WriterError::NotAcknowledged(cause)) => { copies.give_up(); Err(WriteRefused::NotAcknowledged(cause)) }
        Err(error) => Err(WriteRefused::NotWriter(error.cause())),
    }
}

/// The native supply adapter lends the transaction; acknowledgement remains
/// supply-neutral and reads the exact original transaction's complete frame.
pub(crate) fn after_domain_commit(owner:&str,connection:&Connection,domain:&GroupDomain)->Result<(),WriteRefused> {
    let Some(copies)=running_for(owner) else{return Ok(());};
    let storage=sqlite::lend(connection,SCHEMA,Access::Write).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
    copies.finalize_captured(&storage,domain).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))
}
pub(crate) fn after_domain_rollback(owner:&str,connection:&Connection,domain:&GroupDomain,frame:&CapturedCommit)->Result<(),WriteRefused> {
    let Some(copies)=running_for(owner) else{return Ok(());};
    let storage=sqlite::lend(connection,SCHEMA,Access::Write).map_err(|error| { let cause=crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(||crate::cause!(WriteRefused Records)); WriteRefused::Records(Error::Unavailable(cause.clone()),cause) })?;
    copies.abort_captured(&storage,domain,frame).map_err(|error| { let cause=crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(||crate::cause!(WriteRefused Records)); WriteRefused::Records(Error::Unavailable(cause.clone()),cause) })
}
pub(crate) fn recover_domain_pending(owner:&str,connection:&Connection,domain:&GroupDomain)->Result<(),WriteRefused> {
    let Some(copies)=running_for(owner) else{return Ok(());};
    let storage=sqlite::lend(connection,SCHEMA,Access::Write).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
    if storage.scoped() {return Err(crate::cause!(WriteRefused::OutcomeUnknown));}
    let stream=group_stream(&domain.selection().identity(),owner).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
    let pending=commit_log::pending(&storage,&stream,group_limits().map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
    if pending.as_ref().is_some_and(|pending|pending.source!=copies.me) {
        copies.resolve_group_pending(&domain.selection().identity()).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))?;
    }
    copies.finalize_captured(&storage,domain).map_err(|error| crate::carry_cause!(WriteRefused::OutcomeUnknown, error))
}

pub(crate) fn before_domain_commit(
    owner: &str,
    connection: &Connection,
    domain: &GroupDomain,
    captured: Option<&CapturedCommit>,
) -> Result<(), WriteRefused> {
    let storage = sqlite::lend(connection, SCHEMA, Access::Write)
        .map_err(|error| { let cause = error.cause(); WriteRefused::Records(Error::Unavailable(cause.clone()), cause) })?;
    before_domain_storage_commit(owner, &storage, domain, captured)
}

fn before_commit_checked(owner: &str, connection: &Connection) -> Result<(), WriteRefused> {
    let Some(copies) = locked(running()).get(owner).and_then(Weak::upgrade) else { return Ok(()) };
    let resources = changes::held_resources(owner);
    match copies.acknowledge(connection, &resources) {
        Ok(()) => Ok(()),
        Err(WriterError::NotAcknowledged(cause)) => {
            crate::quiet_eprintln!("computers-writer event=gave-up code=write-not-acknowledged cause={cause}");
            copies.give_up();
            Err(WriteRefused::NotAcknowledged(cause))
        }
        Err(error) => Err(WriteRefused::NotWriter(error.cause())),
    }
}


#[cfg(test)]
mod term_announcement_tests {
    use super::*;

    #[test]
    fn peer_refusal_wire_preserves_sealing_origin_through_sync_error() {
        let keys = SecretsKeys::default();
        let at = At { owner: "synthetic-owner", resource: "notes", id: "one", version: 1, from: 0, part: Part::Value };
        let private_value = serde_json::json!("private-field-value-never-a-cause");
        let missing = sealed::seal_value(&keys, &at, &private_value).unwrap_err();
        let malformed = sealed::open_value(&keys, &at, &private_value).unwrap_err();
        assert_ne!(missing.cause(), malformed.cause());
        for source in [missing, malformed] {
            let original = source.cause();
            let answer = refused("sealed_value_refused", original.clone());
            let wire = serde_json::to_vec(&answer).unwrap();
            let Answer::Refused { code, cause, .. } = serde_json::from_slice::<Answer>(&wire).unwrap() else {
                panic!("peer refusal retained")
            };
            assert_eq!(code, "sealed_value_refused");
            assert_eq!(cause, original);
            let received = SyncError::new(settle_status(&code), code, cause);
            assert_eq!(received.cause(), original);
            assert!(!String::from_utf8(wire).unwrap().contains("private-field-value-never-a-cause"));
            assert_eq!(original.file(), "src/account/computers/sealed.rs");
        }
        let records = crate::cause!(Error::Unavailable);
        let original = records.cause();
        let wrapper = WriteRefused::Records(records, crate::cause!(copies records_boundary));
        assert_eq!(wrapper.cause(), original);
    }


    #[test]
    fn selected_domain_cannot_publish_under_primary_copy_keys() {
        struct NoSend(std::sync::atomic::AtomicUsize);
        impl Link for NoSend {
            fn send(&self, _: &str, _: &Message) -> Option<Answer> {
                self.0.fetch_add(1, Ordering::AcqRel); None
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let owner = content_crypto::advanced::blake3::hash(state.as_os_str().as_encoded_bytes()).to_hex().to_string();
        let account = super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let computers = vec!["a".repeat(64), "b".repeat(64)];
        let row = super::super::ComputersRow::sign_with_voters(&address, 1, &computers, &computers, &computers, &account).unwrap();
        let link = Arc::new(NoSend(std::sync::atomic::AtomicUsize::new(0)));
        let copies = Arc::new(Copies::new(CopiesConfig { user: "person".into(),
            stores: None, address, owner: owner.clone(), computer: computers[0].clone(), row,
            records: state.join("records.sqlite"), limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(|| 1_000_000)).unwrap().with_state(state.clone()));
        register(&copies);
        let resources = Arc::new(placements::StateResources::new(&state, crate::sqlite_work::WorkMeter::new()).unwrap());
        let writer = resources.writer("@own-work/domain-copy-control").unwrap();
        let lent = writer.lend(Arc::new(AtomicBool::new(false)), Instant::now() + Duration::from_secs(5)).unwrap();
        let tx = lent.begin(rusqlite::TransactionBehavior::Immediate).unwrap();
        let held = changes::HeldChanges::begin();
        let supply = sqlite::lend(&tx, SCHEMA, Access::Write).unwrap();
        let mut store = RecordStore::new(supply, Box::new(RealClock), Limits::fixed(1 << 20, 1 << 30)).unwrap();
        store.mutate_local_with_check(&owner, "own-records", crate::records::Mutation {
            id: "synthetic-domain-effect".into(), expected_version: 0, request_key: "synthetic-domain-copy".into(),
            deleted: false, value: json!({"synthetic":true}),
        }, || Ok(())).unwrap();
        drop(store);
        let domain = GroupDomain::new(resources.clone(), &owner, placements::domains::Selection {
            id: "different-domain".into(), incarnation: "first".into(), generation: 1, create: true,
        }, 1).unwrap();
        assert!(matches!(before_domain_commit(&owner, &tx, &domain, None), Err(WriteRefused::Records(Error::Unavailable(_), _))));
        assert_eq!(link.0.load(Ordering::Acquire), 0, "refuse before any wrong-domain replication");
        tx.rollback().unwrap(); drop(held); drop(lent);
        resources.readers("@own-work/domain-copy-control").unwrap().read::<_, Error>(|store| {
            assert!(store.current_record(&owner, "own-records", "synthetic-domain-effect")?.is_none());
            Ok(())
        }).unwrap();
    }

    /// Old trillion src/copy-followers.mjs:38 sends each follower's notice independently. A failed first resource
    /// disqualifies that peer from this complete announcement; it cannot add a transport wait for every other one.
    #[test]
    fn a_failed_term_announcement_stops_after_one_resource_per_peer() {
        struct Announcements {
            unavailable: String,
            failed_calls: std::sync::atomic::AtomicUsize,
            live_calls: std::sync::atomic::AtomicUsize,
        }
        impl Link for Announcements {
            fn send(&self, peer: &str, message: &Message) -> Option<Answer> {
                assert!(matches!(message, Message::Push { changes, .. } if changes.is_empty()));
                if peer == self.unavailable {
                    self.failed_calls.fetch_add(1, Ordering::AcqRel);
                    None
                } else {
                    self.live_calls.fetch_add(1, Ordering::AcqRel);
                    Some(Answer::Applied { stamp: 0 })
                }
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let account = super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let computers = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let row = super::super::ComputersRow::sign_with_voters(&address, 1, &computers, &computers, &computers, &account).unwrap();
        let link = Arc::new(Announcements { unavailable: computers[1].clone(),
            failed_calls: std::sync::atomic::AtomicUsize::new(0), live_calls: std::sync::atomic::AtomicUsize::new(0) });
        let copies = Copies::new(CopiesConfig { user: "person".into(), stores: None, address, owner: computers[0].clone(), computer: computers[0].clone(), row,
            records: state.join("records.sqlite"), limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: sign_in_rows(&state).unwrap(),
        }, link.clone(), Arc::new(|| 1_000_000)).unwrap();
        let resources = locked(&copies.resources).len();
        assert!(resources > 1, "exercise a complete multi-resource announcement");
        let told = copies.tell_to(1, &computers[1..]);
        assert_eq!(told, vec![computers[2].clone()], "only a peer that took every resource counts as told");
        assert_eq!(link.live_calls.load(Ordering::Acquire), resources, "the live peer still receives every resource");
        assert_eq!(link.failed_calls.load(Ordering::Acquire), settings().resend_when_lost as usize + 1,
            "an unavailable peer gets only the bounded transport attempts for its first failed resource");
    }


    /// A lost transport answer must not discard a valid new writer while the only outstanding condition is a
    /// known read-admission grant that expires inside this acknowledgement's existing bound.
    #[test]
    fn a_sign_in_change_waits_for_a_known_admission_end_without_giving_up_its_term() {
        struct SignInAnswers { unavailable: String }
        impl Link for SignInAnswers {
            fn send(&self, peer: &str, message: &Message) -> Option<Answer> {
                if peer == self.unavailable { return None; }
                match message {
                    Message::Vote { ask, .. } => Some(Answer::Vote {
                        vote: Vote { accepted: true, term: ask.term }, vouched: Vec::new(),
                    }),
                    Message::SignIn { changes, .. } => Some(Answer::Applied {
                        stamp: changes.last().map_or(0, |change| change.seq as i64),
                    }),
                    _ => None,
                }
            }
        }
        let temporary = tempfile::tempdir().unwrap();
        let state = temporary.path().canonicalize().unwrap();
        let account = super::super::AccountKey::generate().unwrap();
        let address = account.address();
        let computers = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let row = super::super::ComputersRow::sign_with_voters(&address, 1, &computers, &computers, &computers, &account).unwrap();
        let started = Instant::now();
        let clock = Arc::new(move || 1_000_000 + started.elapsed().as_millis() as i64);
        let copies = Copies::new(CopiesConfig { user: "person".into(), stores: None, address, owner: computers[0].clone(), computer: computers[0].clone(), row,
            records: state.join("records.sqlite"), limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: sign_in_rows(&state).unwrap(),
        }, Arc::new(SignInAnswers { unavailable: computers[1].clone() }), clock).unwrap();
        assert_eq!(copies.writer_role_step(|turn| turn.claim((copies.clock)(), &copies.writer_rows,
            &VoteWire { copies: &copies }, &Gate(true))), Ok(true));
        let term = copies.holding().unwrap();
        let until = (copies.clock)() + 50;
        locked(&copies.vouched).insert(computers[1].clone(), until);
        let changes = vec![RowChange { seq: 1, family: "lists".into(), id: "synthetic-expiry".into(), row: None }];
        let held = locked(&copies.sign_in);
        let acknowledged = copies.sign_in_acknowledge(&copies.log(), term, 0, 0, &changes);
        drop(held);
        assert!(acknowledged.is_ok(), "a majority holds the change and the unacknowledged peer's known grant ended");
        assert!((copies.clock)() >= until, "the change cannot count while that peer may still admit");
        assert_eq!(copies.holding(), Some(term), "the valid writer term was retained");
    }
}


#[cfg(test)]
mod group_readiness_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Probe {
        target: Mutex<Option<PathBuf>>,
        after_read: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
        after_missing_pending: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
        pending_slot:Mutex<Option<String>>,
        write_scopes: AtomicUsize,
        fail_group_read_once: AtomicBool,
    }
    struct ProbeOpener(Arc<Probe>);
    impl StoreOpener for ProbeOpener {
        fn open(&self,path:&Path)->Result<ComputerStore,Error> {
            let inner=sqlite::open_owned(path,SCHEMA,placements::bounds()).map_err(|error| crate::carry_cause!(Error::Unavailable, error))?;
            let selected=locked(&self.0.target).as_deref()==Some(path);
            Ok(Box::new(Probed {inner:Box::new(inner),probe:self.0.clone(),selected,reading:std::cell::Cell::new(false)}))
        }
        fn limits(&self)->Limits {Limits::fixed(1<<20,1<<30)}
        fn supports_domains(&self)->bool {true}
        fn histories_page(&self,_:&Path,_:&str,_:Option<&str>,_:usize)->Result<(Vec<GroupIdentity>,Option<String>),Error> {Ok((Vec::new(),None))}
    }
    struct Probed {inner:ComputerStore,probe:Arc<Probe>,selected:bool,reading:std::cell::Cell<bool>}
    impl Storage for Probed {
        fn schema(&self)->&'static crate::storage::Schema {self.inner.schema()}
        fn get(&self,family:&str,key:&[crate::storage::Value],read:&[crate::storage::Read<'_>])->crate::storage::Result<Option<crate::storage::Row>> {
            if self.selected && family=="command_commit_state" && self.probe.fail_group_read_once.swap(false,Ordering::AcqRel) {
                return Err(crate::cause!(crate::storage::Error::Unavailable));
            }
            let row=self.inner.get(family,key,read)?;
            if self.selected && family=="command_commit_state" && row.is_none()
                && key.first().is_some_and(|key|matches!(key,crate::storage::Value::Text(slot) if Some(slot)==locked(&self.probe.pending_slot).as_ref())) {
                let callback=locked(&self.probe.after_missing_pending).take();if let Some(callback)=callback {callback();}
            }
            Ok(row)
        }
        fn scan(&self,family:&str,range:&crate::storage::Range<'_>,read:&[crate::storage::Read<'_>])->crate::storage::Result<Vec<crate::storage::Row>> {self.inner.scan(family,range,read)}
        fn put(&self,family:&str,row:&[(&str,crate::storage::Value)],when:crate::storage::When<'_>)->crate::storage::Result<u64> {self.inner.put(family,row,when)}
        fn count(&self,family:&str,range:&crate::storage::Range<'_>)->crate::storage::Result<u64> {self.inner.count(family,range)}
        fn erase(&self,family:&str,range:&crate::storage::Range<'_>)->crate::storage::Result<u64> {self.inner.erase(family,range)}
        fn present(&self,family:&str)->crate::storage::Result<bool> {self.inner.present(family)}
        fn custody(&self)->crate::storage::Result<()> {self.inner.custody()}
        fn location(&self)->Option<&str> {self.inner.location()}
        fn scoped(&self)->bool {self.inner.scoped()}
        fn writing(&self)->crate::storage::Result<bool> {self.inner.writing()}
        fn changes(&self)->u64 {self.inner.changes()}
        fn mark(&self)->crate::storage::Result<i64> {self.inner.mark()}
        fn schema_mark(&self)->crate::storage::Result<i64> {self.inner.schema_mark()}
        fn allocated_bytes(&self)->crate::storage::Result<u64> {self.inner.allocated_bytes()}
        fn prepare_declared_families(&self,names:&[&str])->crate::storage::Result<()> {self.inner.prepare_declared_families(names)}
        fn checkpoint(&self)->crate::storage::Result<crate::storage::Checkpoint> {self.inner.checkpoint()}
        fn close_checkpoint(&self,checkpoint:crate::storage::Checkpoint,commit:bool)->crate::storage::Result<()> {self.inner.close_checkpoint(checkpoint,commit)}
        fn overwrites_removed(&self)->crate::storage::Result<bool> {self.inner.overwrites_removed()}
        fn open_scope(&self,intent:crate::storage::Intent)->crate::storage::Result<()> {
            if self.selected && matches!(intent,crate::storage::Intent::Write) {self.probe.write_scopes.fetch_add(1,Ordering::AcqRel);}
            let outer=!self.inner.scoped();
            self.inner.open_scope(intent)?;
            if outer {self.reading.set(matches!(intent,crate::storage::Intent::Read));} Ok(())
        }
        fn close_scope(&self,commit:bool)->crate::storage::Result<()> {
            self.inner.close_scope(commit)?;
            if self.selected && !self.inner.scoped() && self.reading.replace(false) {
                let callback=locked(&self.probe.after_read).take();
                if let Some(callback)=callback {callback();}
            }
            Ok(())
        }
    }
    struct NoMessages;
    impl Link for NoMessages {fn send(&self,_:&str,_:&Message)->Option<Answer> {None}}

    struct Fixture {
        copies:Arc<Copies>,probe:Arc<Probe>,scope:GroupIdentity,path:PathBuf,
        _dir:tempfile::TempDir,
    }
    impl Fixture {
        fn new()->Self {Self::with_clock(Arc::new(||1_000_000))}
        fn with_clock(clock:Clock)->Self {
            let temporary=tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();let state=temporary.path().canonicalize().unwrap();
            let owner="a".repeat(64);
            let computer_key=Arc::new(ComputerKey::from_bytes(vec![71;32]).unwrap());
            let computer=super::super::ComputerSigner::of(&computer_key).unwrap().computer_id();
            let key=super::super::AccountKey::generate().unwrap();let address=key.address();
            let computers=vec![computer.clone()];
            let row=super::super::ComputersRow::sign_with_voters(&address,1,&computers,&computers,&computers,&key).unwrap();
            let raw=sign_in_rows(&state).unwrap();let probe=Arc::new(Probe::default());
            let copies=Arc::new(Copies::new(CopiesConfig { user: "person".into(),stores:Some(Arc::new(ProbeOpener(probe.clone()))),address,
                owner:owner.clone(),computer,row,records:state.join("records.sqlite"),limits:Some(Limits::fixed(1<<20,1<<30)),sign_in:raw.clone()},
                Arc::new(NoMessages),clock).unwrap().with_state(state.clone())
                .with_secrets_key(computer_key,state,Some(secrets_key::generate().unwrap())));
            assert!(copies.claim(1_000_000));assert!(copies.may_admit());
            // The writer heard its own feed when it took the turn; a copy that gave up the turn still admits within the bound.
            copies.heard_at.store(1_000_000,Ordering::Release);
            let scope=GroupIdentity {id:"readiness-race".into(),incarnation:"first".into(),generation:1};
            let resource=group_key(&scope,&scope.resource(&owner).unwrap()).unwrap();
            let path=copies.records.path(&resource);*locked(&probe.target)=Some(path.clone());
            let stream=group_stream(&scope,&owner).unwrap();
            *locked(&probe.pending_slot)=Some(content_crypto::advanced::blake3::hash(
                &serde_json::to_vec(&("complete-command-stream/v1","pending",&stream,"")).unwrap()).to_hex().to_string());
            locked(&copies.resources).insert(resource);
            commit(&path,&owner,&scope,0);
            Self {copies,probe,scope,path,_dir:temporary}
        }
        /// Whether this copy holds every group it keeps materialized (`Copies::filling` is its negation).
        fn ready(&self)->bool {!self.copies.filling()}
    }
    /// Commit genuine record mutations and their complete frame through one
    /// physical SQLite transaction; the probe never invents frontier numbers.
    fn commit(path:&Path,owner:&str,scope:&GroupIdentity,version:i64) {
        commit_pending(path,owner,scope,version,None);
    }
    fn commit_pending(path:&Path,owner:&str,scope:&GroupIdentity,version:i64,source:Option<&str>) {
        let raw=sqlite::open_owned(path,SCHEMA,placements::bounds()).unwrap();
        raw.open_scope(Intent::Write).unwrap();
        let limits=group_limits().unwrap();let capture=live_adopt::CommandCapture::unbound(&raw,limits);
        let recording=live_adopt::Recording::new(&raw);recording.bind(Some(capture.clone()));
        let mut store=RecordStore::new(&recording,Box::new(RealClock),Limits::fixed(1<<20,1<<30)).unwrap();
        if version==0 {store.mutate_local_with_check(owner,crate::local_account::own_records::IDENTITY,
            crate::records::Mutation {id:"command-domain".into(),expected_version:0,request_key:"header".into(),deleted:false,value:json!(scope)},||Ok(())).unwrap();}
        store.mutate_local_with_check(owner,"own-records",crate::records::Mutation {id:"live-value".into(),expected_version:version,
            request_key:format!("real-commit-{version}"),deleted:false,value:json!({"version":version})},||Ok(())).unwrap();
        drop(store);let effects=capture.final_effects(&recording).unwrap();
        let stream=group_stream(scope,owner).unwrap();let bound=group_binding(scope,owner).unwrap();
        commit_log::bind_stream(&recording,&stream,&bound,limits).unwrap();
        commit_log::bind_stream(&recording,&scope.copy_namespace(owner).unwrap(),&bound,limits).unwrap();
        let frame=commit_log::append_commit(&recording,&stream,&format!("real-commit-{version}"),&effects,limits).unwrap();
        if let Some(source)=source {
            commit_log::prepare(&recording,&stream,&commit_log::Pending {source:source.into(),term:1,sequence:frame.sequence,
                digest:commit_log::digest_of(&frame,limits).unwrap(),base:frame.sequence-1},limits).unwrap();
        }
        drop(recording);raw.close_scope(true).unwrap();
    }

    #[test]
    fn writer_renews_before_domain_maintenance_crosses_the_old_term_edge() {
        let now=Arc::new(AtomicI64::new(1_000_000));let clock=now.clone();
        let fixture=Fixture::with_clock(Arc::new(move||clock.load(Ordering::Acquire)));
        let term=fixture.copies.holding().unwrap();
        let old=fixture.copies.writer_rows.read(&fixture.copies.id).unwrap().unwrap();
        now.store(old.expires_at_ms-settings().clock_margin_ms-1,Ordering::Release);
        assert_eq!(fixture.copies.holding(),Some(term));
        let clock=now.clone();
        *locked(&fixture.probe.after_read)=Some(Arc::new(move||{clock.fetch_add(2,Ordering::AcqRel);}));
        fixture.copies.tick();
        assert!(locked(&fixture.probe.after_read).is_none(),"maintenance actually crossed the old term edge on its physical read");
        assert_eq!(fixture.copies.holding(),Some(term),"maintenance must not expire a term before its renewal is attempted");
        assert!(fixture.copies.writer_rows.read(&fixture.copies.id).unwrap().unwrap().expires_at_ms>old.expires_at_ms);
        assert!(fixture.copies.may_admit() && fixture.ready());
    }

    #[test]
    fn an_aging_term_is_refreshed_by_each_tick_before_maintenance_crosses_its_edge() {
        let now=Arc::new(AtomicI64::new(1_000_000));let clock=now.clone();
        let fixture=Fixture::with_clock(Arc::new(move||clock.load(Ordering::Acquire)));
        let term=fixture.copies.holding().unwrap();
        for round in 0..3 {
            let old=fixture.copies.writer_rows.read(&fixture.copies.id).unwrap().unwrap();
            now.store(old.expires_at_ms-settings().clock_margin_ms-1,Ordering::Release);
            assert_eq!(fixture.copies.holding(),Some(term),"round {round}: the term is still held before the tick");
            let clock=now.clone();
            *locked(&fixture.probe.after_read)=Some(Arc::new(move||{clock.fetch_add(2,Ordering::AcqRel);}));
            fixture.copies.tick();
            assert!(locked(&fixture.probe.after_read).is_none(),"round {round}: maintenance crossed the term edge on its physical read");
            assert_eq!(fixture.copies.holding(),Some(term),"round {round}: the tick renewed the term before maintenance crossed its edge");
            assert!(fixture.copies.writer_rows.read(&fixture.copies.id).unwrap().unwrap().expires_at_ms>old.expires_at_ms,"round {round}: the renewed term runs later");
            assert!(fixture.copies.may_admit() && fixture.ready(),"round {round}: writes keep being admitted");
        }
    }

    #[test]
    fn a_failed_physical_read_does_not_invent_missing_materialization() {
        let fixture=Fixture::new();assert!(fixture.ready());
        assert!(fixture.copies.refresh_group_materialized(&fixture.scope).unwrap());
        let before=fixture.copies.group_position(&fixture.scope).unwrap().1;
        fixture.probe.fail_group_read_once.store(true,Ordering::Release);
        let error=fixture.copies.refresh_group_materialized(&fixture.scope);
        assert!(!fixture.probe.fail_group_read_once.load(Ordering::Acquire),"the selected physical read actually failed");
        assert!(matches!(&error,Err(Error::Unavailable(_))),"the affected work retains its physical source failure");
        let cause=error.unwrap_err().cause();
        assert_eq!(cause.file(),"src/account/computers/copies.rs");
        assert_eq!(cause.condition(),"crate::storage::Error::Unavailable");
        assert!(fixture.copies.may_admit() && fixture.ready(),"a failed sample cannot replace a previously qualified materialization frontier");
        let after=fixture.copies.group_position(&fixture.scope).unwrap().1;
        assert_eq!(after.materialized,before.materialized);
        assert_eq!(after.stored,before.stored);
        assert!(fixture.copies.refresh_group_materialized(&fixture.scope).unwrap());
    }

    #[test]
    fn a_proved_binding_conflict_still_closes_materialization_readiness() {
        let fixture=Fixture::new();assert!(fixture.ready());
        assert!(fixture.copies.refresh_group_materialized(&fixture.scope).unwrap());
        let wrong=GroupIdentity {incarnation:"different-birth".into(),..fixture.scope.clone()};
        assert!(matches!(fixture.copies.refresh_group_materialized(&wrong),Err(Error::Conflict(_))));
        assert!(!fixture.ready(),"a proved namespace mismatch still closes the native admission gate");
        assert!(fixture.copies.group_ready(&fixture.scope),"the original physical history itself was not mutated");
    }

    #[test]
    fn a_complete_commit_between_read_snapshots_is_not_missing_materialization() {
        let fixture=Fixture::new();assert!(fixture.ready());
        let (path,owner,scope)=(fixture.path.clone(),fixture.copies.owner.clone(),fixture.scope.clone());
        *locked(&fixture.probe.after_read)=Some(Arc::new(move||commit(&path,&owner,&scope,1)));
        let ready=fixture.copies.group_ready(&fixture.scope);
        assert!(locked(&fixture.probe.after_read).is_none(),"the real second commit occurred after the first snapshot closed");
        let key=group_key(&fixture.scope,&fixture.scope.resource(&fixture.copies.owner).unwrap()).unwrap();
        fixture.copies.mark_group_materialized(&key,ready);
        assert!(ready && fixture.copies.may_admit() && fixture.ready(),"an intervening complete commit is not missing materialization or sign-out");
        assert_eq!(fixture.copies.group_position(&fixture.scope).unwrap().1.materialized,2);
    }

    #[test]
    fn complete_domain_maintenance_takes_no_writer_while_another_writer_is_held() {
        let fixture=Fixture::new();let db=rusqlite::Connection::open(&fixture.path).unwrap();
        db.execute_batch("BEGIN IMMEDIATE").unwrap();
        let before=fixture.probe.write_scopes.load(Ordering::Acquire);
        assert_eq!(fixture.copies.materialize_group_page(&fixture.scope).unwrap(),0);
        assert_eq!(fixture.probe.write_scopes.load(Ordering::Acquire),before,"a complete domain needs no maintenance write reservation");
        assert!(!db.is_autocommit(),"the actual external reservation remains held");
        assert!(fixture.copies.may_admit() && fixture.ready());db.execute_batch("ROLLBACK").unwrap();
    }
    #[test]
    fn an_unmaterialized_copy_is_not_ready_and_a_materialized_one_stays_ready_without_the_turn() {
        for unmaterialized in [true,false] {
            let fixture=Fixture::new();assert!(fixture.ready());
            if unmaterialized {
                let empty=GroupIdentity {id:"incomplete-encrypted-copy".into(),..fixture.scope.clone()};
                let key=group_key(&empty,&empty.resource(&fixture.copies.owner).unwrap()).unwrap();
                let path=fixture.copies.records.path(&key);
                let raw=sqlite::open_owned(&path,SCHEMA,placements::bounds()).unwrap();
                let stream=group_stream(&empty,&fixture.copies.owner).unwrap();
                // Receive an actual complete encrypted snapshot at cut zero.
                // Finishing its transport does not materialize its plaintext.
                let source=sqlite::open_owned(&fixture._dir.path().join("empty-snapshot-source.sqlite"),SCHEMA,placements::bounds()).unwrap();
                let limits=group_limits().unwrap();
                let mut snapshot=opaque_map::PhysicalSnapshot::begin(&source,&stream,&"e".repeat(64),&"f".repeat(64),limits).unwrap();
                let page=snapshot.page(&mut |_,_|panic!("empty source has no rows to seal")).unwrap();
                let seal=snapshot.seal().unwrap();
                raw.open_scope(Intent::Write).unwrap();
                opaque_map::begin_map_bootstrap(&raw,&stream,snapshot.head(),limits).unwrap();
                opaque_map::append_map_page(&raw,&stream,&page,limits).unwrap();
                opaque_map::finish_map_bootstrap(&raw,&stream,&seal,limits).unwrap();
                raw.close_scope(true).unwrap();
                let front=fixture.copies.group_position(&empty).unwrap().1;
                assert!(front.stored>front.materialized);
                let ready=fixture.copies.group_ready(&empty);assert!(!ready);
                fixture.copies.mark_group_materialized(&key,ready);
            } else {fixture.copies.give_up();}
            if !unmaterialized {
                // A materialized copy keeps admitting from its own state after it gives up the writer turn (59a82512a).
                assert!(fixture.ready(),"a materialized copy stays ready after it gives up the writer turn");
                continue;
            }
            assert!(!fixture.ready(),"an unmaterialized group is never ready");
        }
    }

    #[test]
    fn source_pending_after_resolution_never_becomes_a_false_unmaterialized_copy() {
        let fixture=Fixture::new();let member=group_key(&fixture.scope,"own-records").unwrap();
        assert!(fixture.copies.read(&member,"live-value").unwrap().record.is_some(),"same actual read seam works before pending");
        let (path,owner,scope,source)=(fixture.path.clone(),fixture.copies.owner.clone(),fixture.scope.clone(),fixture.copies.me.clone());
        *locked(&fixture.probe.after_missing_pending)=Some(Arc::new(move||commit_pending(&path,&owner,&scope,1,Some(&source))));
        assert_eq!(fixture.copies.materialize_group_page(&fixture.scope).unwrap(),0);
        assert!(locked(&fixture.probe.after_missing_pending).is_none(),"real frame+Pending committed only after resolution observed absence");
        assert!(fixture.copies.may_admit() && fixture.ready(),"the complete committed prefix keeps session admission");
        let raw=sqlite::open_owned(&fixture.path,SCHEMA,placements::bounds()).unwrap();
        let stream=group_stream(&fixture.scope,&fixture.copies.owner).unwrap();let limits=group_limits().unwrap();
        let pending=commit_log::pending(&raw,&stream,limits).unwrap().unwrap();
        assert_eq!(pending.sequence,2);assert_eq!(pending.base,1);
        assert!(commit_log::physical_commit(&raw,&stream,2,limits).unwrap().is_some(),"maintenance preserves the exact original physical frame");
        assert!(fixture.copies.read(&member,"live-value").is_err(),"that SAME domain reader cannot disclose a prepared postimage");
        let key=group_key(&fixture.scope,&fixture.scope.resource(&fixture.copies.owner).unwrap()).unwrap();
        fixture.copies.mark_group_materialized(&key,false);
        assert!(!fixture.ready(),"exercise an earlier conservative readiness refusal");
        fixture.copies.finalize_group_storage(&raw,&fixture.scope).unwrap();
        assert!(commit_log::pending(&raw,&stream,limits).unwrap().is_none());
        assert!(fixture.copies.may_admit() && fixture.ready());
        assert_eq!(fixture.copies.read(&member,"live-value").unwrap().record.unwrap().value["version"],1,
            "original source finalization recovers its actual command without another effect");
        fixture.copies.mark_group_materialized(&key,false);
        fixture.copies.finalize_group_storage(&raw,&fixture.scope).unwrap();
        assert!(fixture.copies.may_admit() && fixture.ready(),"already-finalized recovery also requalifies readiness");
    }

    #[test]
    fn finalized_prefix_ahead_of_plaintext_still_withholds_readiness() {
        let fixture=Fixture::new();let member=group_key(&fixture.scope,"own-records").unwrap();
        assert!(fixture.copies.read(&member,"live-value").unwrap().record.is_some());
        let source_path=fixture._dir.path().join("actual-source.sqlite");
        // Preserve the exact shared first frame, including its timestamps and
        // history bytes; an independently generated first command is not the
        // same history merely because its logical values compare equal.
        let stream=group_stream(&fixture.scope,&fixture.copies.owner).unwrap();let limits=group_limits().unwrap();
        let target=sqlite::open_owned(&fixture.path,SCHEMA,placements::bounds()).unwrap();
        let first=commit_log::physical_commit(&target,&stream,1,limits).unwrap().unwrap();
        let source=sqlite::open_owned(&source_path,SCHEMA,placements::bounds()).unwrap();
        source.open_scope(Intent::Write).unwrap();
        let bound=group_binding(&fixture.scope,&fixture.copies.owner).unwrap();
        commit_log::bind_stream(&source,&stream,&bound,limits).unwrap();
        commit_log::bind_stream(&source,&fixture.scope.copy_namespace(&fixture.copies.owner).unwrap(),&bound,limits).unwrap();
        commit_log::apply_commit(&source,&stream,&first,limits).unwrap();
        let seeded=commit_log::physical_commit(&source,&stream,1,limits).unwrap().unwrap();
        assert_eq!(seeded,first,"source and copy begin with the exact same retained command frame");
        // Seal every later frame with this one retained stream token key.
        fixture.copies.token_key(&source,&fixture.scope).unwrap();
        source.close_scope(true).unwrap();drop(source);drop(target);
        for version in 1..3 {commit(&source_path,&fixture.copies.owner,&fixture.scope,version);}
        let (target_path,owner,scope,copies)=(fixture.path.clone(),fixture.copies.owner.clone(),fixture.scope.clone(),fixture.copies.clone());
        *locked(&fixture.probe.after_missing_pending)=Some(Arc::new(move|| {
            let source=sqlite::open_owned(&source_path,SCHEMA,placements::bounds()).unwrap();
            let target=sqlite::open_owned(&target_path,SCHEMA,placements::bounds()).unwrap();
            let stream=group_stream(&scope,&owner).unwrap();let limits=group_limits().unwrap();
            target.open_scope(Intent::Write).unwrap();let mut last=None;
            for sequence in 1..=3 {
                let frame=commit_log::physical_commit(&source,&stream,sequence,limits).unwrap().unwrap();
                let wire=copies.seal_commit(&scope,&frame,&source).unwrap();
                commit_log::retain_opaque(&target,&stream,&opaque_commit(&wire).unwrap(),limits).unwrap();last=Some(frame);
            }
            let last=last.unwrap();
            commit_log::prepare(&target,&stream,&commit_log::Pending {source:"other-current-source".into(),term:1,sequence:3,
                digest:commit_log::digest_of(&last,limits).unwrap(),base:2},limits).unwrap();
            target.close_scope(true).unwrap();
            let (_,front,_,committed)=copies.group_snapshot(&scope).unwrap();
            assert_eq!(front.materialized,1);assert_eq!(committed,2);assert_eq!(front.stored,3);
            let ready=copies.group_ready(&scope);assert!(!ready,"actual finalized prefix still needs materialization");
            let key=group_key(&scope,&scope.resource(&owner).unwrap()).unwrap();
            copies.mark_group_materialized(&key,ready);assert!(copies.filling());
        }));
        assert_eq!(fixture.copies.materialize_group_page(&fixture.scope).unwrap(),1,"only the complete finalized frame is applied");
        let target=sqlite::open_owned(&fixture.path,SCHEMA,placements::bounds()).unwrap();
        let stream=group_stream(&fixture.scope,&fixture.copies.owner).unwrap();let limits=group_limits().unwrap();
        assert!(commit_log::physical_commit(&target,&stream,2,limits).unwrap().is_some());
        assert!(commit_log::physical_commit(&target,&stream,3,limits).unwrap().is_none(),"maintenance never materializes the prepared frame");
        assert!(commit_log::pending(&target,&stream,limits).unwrap().is_some());
        let (_,front,_,committed)=fixture.copies.group_snapshot(&fixture.scope).unwrap();
        assert_eq!(front.materialized,2);assert_eq!(committed,2);assert_eq!(front.stored,3);
        assert!(fixture.copies.may_admit() && fixture.ready(),"only a complete committed prefix restores session admission");
        assert!(fixture.copies.read(&member,"live-value").is_err(),"the same working reader cannot disclose the still-prepared postimage");
    }

}

crate::impl_caused!(WriteRefused);

#[cfg(test)]
mod request_key_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// A link whose first try runs the message, keeps its answer by request key, and loses the answer on the way back. A try
    /// with a key already answered gets the kept answer instead of running the message again (the answering computer's
    /// `kept_answer`).
    #[derive(Default)]
    struct LostOnce {
        keys: std::sync::Mutex<Vec<String>>,
        runs: AtomicUsize,
        kept: std::sync::Mutex<std::collections::HashMap<String, Answer>>,
    }

    impl Link for LostOnce {
        fn send(&self, to: &str, message: &Message) -> Option<Answer> {
            self.send_keyed(to, message, "unkeyed")
        }

        fn send_keyed(&self, _to: &str, _message: &Message, request_key: &str) -> Option<Answer> {
            let tries = {
                let mut keys = self.keys.lock().unwrap();
                keys.push(request_key.to_owned());
                keys.len()
            };
            if let Some(answer) = self.kept.lock().unwrap().get(request_key).cloned() {
                return Some(answer);
            }
            self.runs.fetch_add(1, Ordering::AcqRel);
            self.kept.lock().unwrap().insert(request_key.to_owned(), Answer::Done);
            (tries > 1).then_some(Answer::Done)
        }
    }

    #[test]
    fn a_retry_after_a_lost_answer_carries_the_same_key_and_the_message_runs_once() {
        let link = LostOnce::default();
        let answer = send_once_more_when_lost(&link, "peer", &Message::Vouch { term: 1, stamp: 1 });
        assert_eq!(answer, Some(Answer::Done), "the retry got the answer the first try produced");
        let keys = link.keys.lock().unwrap().clone();
        assert_eq!(keys.len(), 2, "the lost first try was sent again");
        assert_eq!(keys[0], keys[1], "every try of one logical request carries the same key");
        assert_eq!(link.runs.load(Ordering::Acquire), 1, "the message ran once");
    }

    /// A link whose first try is refused `refusal` (before the message ran) and whose later tries answer, keeping the key.
    #[derive(Default)]
    struct RefusedBeforeRunning {
        keys: std::sync::Mutex<Vec<String>>,
        refusal: &'static str,
    }

    impl Link for RefusedBeforeRunning {
        fn send(&self, to: &str, message: &Message) -> Option<Answer> {
            self.send_keyed(to, message, "unkeyed")
        }

        fn send_keyed(&self, _to: &str, _message: &Message, request_key: &str) -> Option<Answer> {
            let tries = {
                let mut keys = self.keys.lock().unwrap();
                keys.push(request_key.to_owned());
                keys.len()
            };
            if tries == 1 {
                return Some(Answer::Refused { code: self.refusal.to_owned(), cause: crate::cause!(), writer: None });
            }
            Some(Answer::Done)
        }
    }

    #[test]
    fn a_refusal_that_never_started_is_sent_again_and_any_other_refusal_is_the_answer() {
        let handed_over = RefusedBeforeRunning { refusal: NOT_ANSWERING_YET, ..Default::default() };
        assert_eq!(send_once_more_when_lost(&handed_over, "peer", &Message::Vouch { term: 1, stamp: 1 }), Some(Answer::Done),
            "the handover refusal was sent again and the second try answered");
        let keys = handed_over.keys.lock().unwrap().clone();
        assert_eq!(keys.len(), 2, "one resend");
        assert_eq!(keys[0], keys[1], "the resend carries the same request key");

        let other = RefusedBeforeRunning { refusal: "not_writer", ..Default::default() };
        let answer = send_once_more_when_lost(&other, "peer", &Message::Vouch { term: 1, stamp: 1 });
        assert!(matches!(answer, Some(Answer::Refused { ref code, .. }) if code == "not_writer"), "{answer:?}");
        assert_eq!(other.keys.lock().unwrap().len(), 1, "a refusal that may have run is not sent again");
    }

    #[test]
    fn each_logical_request_gets_its_own_key() {
        let first = new_request_key().unwrap();
        let second = new_request_key().unwrap();
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}

// ---- incident 5 (a writer stops renewing and a joiner goes silent): a refused pull's backoff answers a bare false ----

/// A link that answers nothing: no peer is reachable from this scenario's copy.
struct Unreachable;

impl Link for Unreachable {
    fn send(&self, _to: &str, _message: &Message) -> Option<Answer> {
        None
    }
}

/// Incident 5: a copy whose writer pull was refused waits out its backoff before it asks that computer again. The refusal
/// carries its reason (`PullOutcome::Refused`), and a pull asked during the backoff is refused as `backing-off` with no pull
/// sent (D07).
#[cfg(test)]
fn writer_that_stops_renewing_is_refused_and_replaced_body() -> std::result::Result<(), String> {
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    let state = temporary.path().canonicalize().map_err(|error| error.to_string())?;
    let account = super::AccountKey::generate().map_err(|error| format!("{error:?}"))?;
    let address = account.address();
    let computers = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    let row = super::ComputersRow::sign_with_voters(&address, 1, &computers, &computers, &computers, &account)
        .map_err(|error| format!("{error:?}"))?;
    let now = 1_000_000;
    let copies = Copies::new(
        CopiesConfig {
            user: "person".into(),
            stores: None,
            address,
            owner: computers[0].clone(),
            computer: computers[0].clone(),
            row,
            records: state.join("records.sqlite"),
            limits: Some(Limits::fixed(1 << 20, 1 << 30)),
            sign_in: sign_in_rows(&state).map_err(|error| format!("{error:?}"))?,
        },
        Arc::new(Unreachable),
        Arc::new(move || now),
    )
    .map_err(|error| format!("{error:?}"))?;
    copies.heed_not_writer(&computers[1], None, now);
    let PullOutcome::Refused(first) = copies.sign_in_follow(&computers[1], true) else {
        return Err("a refused writer's pull went through".into());
    };
    if first.word == "backing-off" {
        return Err("the first pull after the refusal was held by the backoff, though no pull had been asked".into());
    }
    let PullOutcome::Refused(during_backoff) = copies.sign_in_follow(&computers[1], true) else {
        return Err("a refused writer is asked again inside its backoff".into());
    };
    if during_backoff.word != "backing-off" {
        return Err(format!("the pull inside the backoff was refused as {}, not backing-off", during_backoff.word));
    }
    Ok(())
}

#[cfg(test)]
mod stall_scenario_tests {
    #[test]
    fn writer_that_stops_renewing_is_refused_and_replaced() {
        crate::simulation::verdict("writer-that-stops-renewing-is-refused-and-replaced", super::writer_that_stops_renewing_is_refused_and_replaced_body);
    }
}

/// The writer a refusal names that this computer may follow: a voter of the account, other than the refuser and this computer,
/// with a term at least as new as this computer's own row. A computer that does not vote cannot hold the writer term, so a
/// term it names is never followed. Otherwise a sole voter that holds its term would learn the non-voter's term and give
/// its own up (measured 2026-11-12: arm1 claimed each account's term and lost it in the same second).
fn followable_writer<'a>(
    named: Option<&'a super::messages::RefusedWriter>,
    from: &str,
    me: &str,
    voters: &[String],
    before: Option<&WriterRow>,
) -> Option<&'a super::messages::RefusedWriter> {
    named.filter(|named| named.computer != from && named.computer != me && voters.contains(&named.computer))
        .filter(|named| before.is_none_or(|row| row.term <= named.term))
}

#[cfg(test)]
mod followable_writer_tests {
    use super::{followable_writer, WriterRow};
    use crate::account::computers::messages::RefusedWriter;

    fn named(computer: &str, term: u64) -> RefusedWriter {
        RefusedWriter { computer: computer.to_string(), term }
    }

    fn own(writer: &str, term: u64) -> WriterRow {
        WriterRow { writer: writer.to_string(), term, expires_at_ms: 0 }
    }

    /// A sole voter that holds its term keeps it when a non-voter refuses its pull and names a higher term: the named computer
    /// cannot hold the writer term, so the refusal is not followed.
    #[test]
    fn a_non_voter_named_with_a_higher_term_is_not_followed() {
        let voters = vec!["arm1".to_string()];
        let before = own("arm1", 116);
        let refusal = named("hel1", 184);
        assert!(followable_writer(Some(&refusal), "hel1", "arm1", &voters, Some(&before)).is_none());
    }

    #[test]
    fn a_voter_named_with_a_term_at_least_as_new_is_followed() {
        let voters = vec!["arm1".to_string(), "fsn1".to_string()];
        let before = own("arm1", 116);
        let refusal = named("fsn1", 117);
        assert_eq!(followable_writer(Some(&refusal), "hel1", "arm1", &voters, Some(&before)).map(|w| w.computer.as_str()), Some("fsn1"));
    }

    #[test]
    fn a_voter_with_an_older_term_than_this_computers_row_is_not_followed() {
        let voters = vec!["arm1".to_string(), "fsn1".to_string()];
        let before = own("arm1", 116);
        let refusal = named("fsn1", 115);
        assert!(followable_writer(Some(&refusal), "hel1", "arm1", &voters, Some(&before)).is_none());
    }

    #[test]
    fn a_refusal_that_names_the_refuser_or_this_computer_is_not_followed() {
        let voters = vec!["arm1".to_string(), "hel1".to_string()];
        let before = own("arm1", 116);
        assert!(followable_writer(Some(&named("hel1", 200)), "hel1", "arm1", &voters, Some(&before)).is_none());
        assert!(followable_writer(Some(&named("arm1", 200)), "hel1", "arm1", &voters, Some(&before)).is_none());
    }
}
