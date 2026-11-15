//! Where an account is kept and how many copies: the account's own rule, as list rows in its account rows (family
//! `lists`, beside `settings:sign-in`), run on the same formula, trigger and workflow engines every list runs on
//! (src/rule_bindings/rules_and_runs.rs). the person, 2026-11-03: no single folder or computer may ever hold the only copy,
//! "configurable per account as rows edited like the rest of his lists and wired to the formula, trigger and workflow
//! engines".
//!
//! The rows, each `{revision, settings}` and changed by one compare-and-set on its revision (ids: `copy_rule` in
//! `computers/settings.json`, then the account's user id):
//! - the copies row (`copies_prefix`): `CopySettings`, the least computers that keep a copy, vote, may answer and report
//!   they are always on;
//! - the copy rules row (`rules_prefix`): `CopyRules`, the formula of the copies row's computed field `short_by`, the
//!   trigger rule that reads it, and the workflow the rule starts;
//! - the offered-computers list (`offered_prefix`): the computers the account may add, first first, each with what its
//!   report said (`has_room`, `always_on`);
//! - one row per workflow run (`run_prefix` + user id + `:` + run id).
//!
//! All of them are made with the account from the making computer's config `new_accounts` (`copies`, `copies_rules`;
//! the offered list starts empty), travel with the copies like every account row (`lists` is in `copied_families`), and
//! are read and changed through the door (src/account/account_routes.rs).
//!
//! How it runs, after every write of the computers row or of these rows (the door), and at each sweep (a computer re-reads
//! every account it holds every `sweep_every_ms`, the port of old trillion src/keep-running.mjs's hourly sweep):
//! 0. The offered-computers list is filled from the computers' own reports (`fill_offered`, `Reported`): every computer
//!    posts its report to its forwarder every `report_every_ms` and hears every live computer's (src/forwarder/gateway.rs
//!    `take_report`); a computer that reports it takes new accounts is offered with its `has_room` and `always_on`.
//! 1. `short_by` is worked out by the formula evaluator from the copies row and the live counts of the computers row
//!    (`Live`): `short_by_each`, one formula per count, then the rules row's `short_by` formula over them (the shipped
//!    one: the largest and 0, one `op:core.max` over a list of selections). Nothing in code takes the largest.
//! 2. The copies row, with `short_by` and the live counts, is handed to the trigger rules as one change with the rule row.
//!    A send whose payload names the rules row's workflow (`then.workflow_id`) starts one run of it under the send's key
//!    (one run per key, as Trillion's workflows started), unless a run is still working: one computer is added at a time.
//! 3. Each working run is run by the workflow runner. An ask named `add_computer_ask` is answered here by the computers
//!    operation `add-computer` (`computers::apply`) naming the first offered computer with room that keeps no copy yet, as
//!    a computer that may answer (when always-on computers are short, the first such one that reports it is always on;
//!    when only they are short, none other, so a computer that cannot meet the rule is never added); an ask named `voter_step_ask` by `add-computer` again with `voter`, once that computer
//!    reports it caught up (`Copies::caught_up` at the writer), so the voters change by one step as every row edit does.
//!    An ask this file cannot answer yet leaves the run `working`, with why in `blocked`; the next write or sweep tries
//!    again, and so does the writer at once when a computer reports it caught up (`run_soon`, from `Message::CaughtUp`)
//!    or the reports heard change. The added computer is told at once by the computer that writes (src/native_entry/
//!    computer.rs `tell_again`: a row that names a computer the last told row did not), so it joins by itself. A run whose account is no longer short before it added a computer, or whose added computer was removed
//!    before it voted, is `ended` with why in `blocked`, so the next send may start another.
//!
//! What it never does: refuse a read, or remove anything. The one refusal that reads this rule is the door's
//! (`computers_below_copy_rule`): an edit of the computers row that lowers the computers that keep a copy below
//! `least_copy_keepers` (`below_rule`), unless the same edit lowers the rule. Every other count only informs (the
//! runs, `short_by`), as the computers list does (answer-decision.md point 3).
//!
//! Every number and word is DATA: the rows (the account's) and `computers/settings.json` `copy_rule` (the names the door
//! and the workflow agree on).

use crate::refusal_cause::CodedError;
use super::{apply, settings, AccountKey, ComputersRow, Operation, Refused as ComputersRefused, Subject};
use crate::account::rows::store::{Family, Row, Store};
use crate::storage::Storage;
use crate::rule_bindings::rules_and_runs as runs;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The names this file and the door read (`computers/settings.json` `copy_rule`).
#[derive(Debug, Deserialize)]
pub(crate) struct CopyRuleSettings {
    #[serde(rename = "_what")]
    _what: String,
    pub copies_prefix: String,
    pub rules_prefix: String,
    pub offered_prefix: String,
    pub run_prefix: String,
    pub list_name: String,
    pub change_kind: String,
    pub rule_partition: String,
    pub workflow_partition: String,
    pub add_computer_ask: String,
    pub voter_step_ask: String,
    pub most_runs: usize,
    pub most_passes: usize,
    pub most_offered: usize,
    pub sweep_every_ms: u64,
    pub report_path: String,
    pub report_every_ms: u64,
    pub report_held_ms: u64,
    pub room_bytes: u64,
    /// The free inodes a volume needs above its stores' floor for the computer to say it has room: a volume full of small
    /// files (the Workshop installs) runs out of inodes before bytes (hel1, 2026-11-11).
    pub room_inodes: u64,
}

/// The path part, after `/a/<address>/<message_path>/`, a computer posts its own report to the forwarder on
/// (src/forwarder/gateway.rs). A computer id is 64 hex, so it never names a computer.
pub fn report_path() -> &'static str {
    &names().report_path
}

/// How often a computer posts its own report and hears the others' (src/native_entry/computer.rs `keep_reporting`).
pub fn report_every_ms() -> u64 {
    names().report_every_ms
}

/// How long a computer keeps a report it heard once the forwarder no longer answers it (`hear_reports`).
pub fn report_held_ms() -> u64 {
    names().report_held_ms
}

/// The free bytes a computer needs above its stores' floor to say it has room for one more account (`has_room`).
pub fn room_bytes() -> u64 {
    names().room_bytes
}

/// The free inodes a volume needs for the same room (`has_room`).
pub fn room_inodes() -> u64 {
    names().room_inodes
}

/// Whether a computer has room for one more account: it holds fewer accounts than its limit (`under_limit`), and every
/// volume it writes to has `room_bytes` free above the floor its stores keep (`keep_free`). `frees` holds each volume's
/// free bytes, the accounts volume and the releases volume; None for a volume that could not be read, which is no room.
pub fn has_room(under_limit: bool, frees: &[Option<u64>], inodes: &[Option<u64>], keep_free: u64) -> bool {
    let Some(needed) = keep_free.checked_add(room_bytes()) else { return false };
    let needed_inodes = room_inodes();
    under_limit
        && frees.iter().all(|free| free.is_some_and(|free| free >= needed))
        && inodes.iter().all(|free| free.is_some_and(|free| free >= needed_inodes))
}

/// The most reports the forwarder answers and a computer keeps.
pub fn most_reports() -> usize {
    names().most_offered
}

fn names() -> &'static CopyRuleSettings {
    &settings().copy_rule
}

/// The refusal code of an edit that leaves fewer computers that keep a copy than the account's rule asks.
pub(crate) const BELOW: &str = "computers_below_copy_rule";
/// The code a stale change of one of these rows is refused with.
pub(crate) const STALE: &str = "copies_revision_changed";

/// The purpose of answering for an account: a computer named as answering in its computers row.
pub(crate) const ANSWER: &str = "answer";
/// The purpose of keeping a copy of an account (a computer named as a copy keeper).
pub(crate) const SYNC: &str = "sync";
/// The purpose of voting for an account's writer (a computer named as a voter).
pub(crate) const VOTE: &str = "vote";

/// Host kinds (`host_kinds` in `computers/settings.json`): one list row per account and computer, holding the computer's
/// kind, which names the purposes its computers may hold.
#[derive(Debug, Deserialize)]
pub(crate) struct HostKindSettings {
    #[serde(rename = "_what")]
    _what: String,
    pub prefix: String,
    pub existing_kind: String,
    pub new_kind: String,
    pub offered_kind: String,
    pub own_kind: String,
    pub making_kind: String,
    pub default_places_kind: String,
    pub kinds: std::collections::BTreeMap<String, HostKindRule>,
}

/// What one host kind may hold.
#[derive(Debug, Deserialize)]
pub(crate) struct HostKindRule {
    pub allowed_purposes: Vec<String>,
}

/// The account's least counts. Each is how many computers of its computers row must do that job.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CopySettings {
    /// Computers that keep a copy (the row's `holders`).
    pub least_copy_keepers: u64,
    /// Computers that vote on the writer row.
    pub least_voters: u64,
    /// Computers that keep a copy and may answer.
    pub least_may_answer: u64,
    /// Computers that may answer and report they are always on (a report only: no computer is required to be).
    pub least_always_on: u64,
}

impl CopySettings {
    /// Whether the counts hold together: at least one computer keeps a copy, none is above the hard admission bound of a
    /// row (`most_admitted_computers`), the may-answer computers are among the keepers, the always-on among the may-answer.
    pub fn valid(&self) -> bool {
        let most = settings().limits.most_admitted_computers as u64;
        self.least_copy_keepers >= 1
            && [self.least_copy_keepers, self.least_voters, self.least_may_answer, self.least_always_on].iter().all(|least| *least <= most)
            && self.least_may_answer <= self.least_copy_keepers
            && self.least_always_on <= self.least_may_answer
    }
}

/// The account's own rule: the formulas of `short_by`, the trigger rule that reads it, the workflow it starts.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CopyRules {
    /// How short the account is of each count, one formula per count, each the formula evaluator's binding over the
    /// copies row's `least_*` (`self`) and the live counts (`Live`, `context`) by field name. A count at or above its
    /// least reads 0. The add-a-computer step reads them to know which kind of computer is short.
    pub short_by_each: Map<String, Value>,
    /// The formula of the copies row's computed field `short_by`, over the same fields and `short_by_each` (the answers
    /// of the formulas above, by count): the shipped row takes the largest of them and 0 with one `op:core.max` over a
    /// list of selections (a literal list whose items are selections, src/rule_bindings: crates/composition-ast
    /// `SelectSource::Literal`). Nothing in code takes the largest.
    pub short_by: Value,
    /// The trigger rule as the trigger rules read it (`id`, `match_condition`, `dispatch`).
    pub rule: Value,
    /// The workflow definition as the workflow runner reads it (`id`, `steps`, `edges`, ...).
    pub workflow: Value,
}

impl CopyRules {
    /// Whether the rows read as a formula, a rule with an id and a workflow definition with an id.
    pub fn valid(&self) -> bool {
        !self.short_by_each.is_empty()
            && self.short_by_each.values().all(Value::is_object)
            && self.short_by.is_object()
            && self.rule.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty())
            && self.workflow_id().is_some()
            && serde_json::from_value::<workflow_core::Definition>(self.workflow.clone()).is_ok()
    }

    fn workflow_id(&self) -> Option<&str> {
        self.workflow.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
    }
}

/// One computer the account may add, as its report said when it was offered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Offered {
    /// Its computer id (64 lowercase hex).
    pub computer: String,
    /// Whether it has room for another copy.
    pub has_room: bool,
    /// Whether it reports it is always on.
    #[serde(default)]
    pub always_on: bool,
    /// The host kind it is added as (`host_kinds`); None: the settings' `offered_kind`.
    #[serde(default)]
    pub kind: Option<String>,
}

/// One of these list rows as stored: the revision that orders its changes and its settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListRow<T> {
    pub revision: u64,
    pub settings: T,
}

/// Why a change of one of these rows is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    Invalid(crate::refusal_cause::Cause),
    Stale(crate::refusal_cause::Cause),
    Storage(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Stale(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Invalid(_), Self::Invalid(_)) => true,
            (Self::Stale(_), Self::Stale(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


fn row_id(prefix: &str, account: &str) -> String {
    format!("{prefix}{account}")
}

fn read_row<T: DeserializeOwned>(store: &Store<'_>, prefix: &str, account: &str) -> Result<Option<Row<ListRow<T>>>, Refused> {
    read_row_id(store, &row_id(prefix, account), account)
}

fn read_row_id<T: DeserializeOwned>(store: &Store<'_>, id: &str, account: &str) -> Result<Option<Row<ListRow<T>>>, Refused> {
    Ok(store.get::<ListRow<T>>(Family::Lists, id).map_err(|error| Refused::Storage(error.cause()))?.filter(|row| row.account == account))
}

fn set_row<T: Serialize + DeserializeOwned + Clone>(store: &Store<'_>, prefix: &str, account: &str, expected_revision: u64, value: T)
    -> Result<ListRow<T>, Refused> {
    set_row_id(store, &row_id(prefix, account), account, expected_revision, value)
}

fn set_row_id<T: Serialize + DeserializeOwned + Clone>(store: &Store<'_>, id: &str, account: &str, expected_revision: u64, value: T)
    -> Result<ListRow<T>, Refused> {
    if expected_revision >= 1 << 53 {
        return Err(crate::cause!(Refused::Invalid));
    }
    let before = read_row_id::<T>(store, id, account)?;
    let current = before.as_ref().map_or(0, |row| row.value.revision);
    if current != expected_revision {
        return Err(crate::cause!(Refused::Stale));
    }
    let kept = ListRow { revision: current + 1, settings: value };
    let after = Row { id: id.to_string(), account: account.to_string(), expires_at: 0, value: kept.clone() };
    match before {
        None => store.insert(Family::Lists, &after).map_err(|error| Refused::Stale(error.cause()))?,
        Some(prior) => {
            if !store.replace_if(Family::Lists, &prior, &after).map_err(|error| Refused::Storage(error.cause()))? {
                return Err(crate::cause!(Refused::Stale));
            }
        }
    }
    Ok(kept)
}

/// The account's copies row, when it has one.
pub(crate) fn copies(store: &Store<'_>, account: &str) -> Result<Option<ListRow<CopySettings>>, Refused> {
    Ok(read_row(store, &names().copies_prefix, account)?.map(|row| row.value))
}

/// Change the copies row from `expected_revision` (0: no row yet).
pub(crate) fn set_copies(store: &Store<'_>, account: &str, expected_revision: u64, value: CopySettings) -> Result<ListRow<CopySettings>, Refused> {
    if !value.valid() {
        return Err(crate::cause!(Refused::Invalid));
    }
    set_row(store, &names().copies_prefix, account, expected_revision, value)
}

/// A computer's host kind row: the kind its account names it by.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostKindRow {
    pub kind: String,
}

/// The host kind `computer` has in its own row for `account`; `None` when it has no row (the default is the caller's).
pub(crate) fn host_kind_row(store: &Store<'_>, account: &str, computer: &str) -> Result<Option<String>, Refused> {
    Ok(read_row_id::<HostKindRow>(store, &host_kind_id(account, computer), account)?.map(|row| row.value.settings.kind))
}

/// Whether a computer of `kind` may hold `purpose`. A kind the settings do not name holds nothing.
pub(crate) fn host_kind_allows(kind: &str, purpose: &str) -> bool {
    settings().host_kinds.kinds.get(kind).is_some_and(|rule| rule.allowed_purposes.iter().any(|allowed| allowed == purpose))
}

/// Change the host kind of `computer` for `account` from `expected_revision` (0: no row yet). `kind` must be a kind the
/// settings name, and `computer` a 64-hex computer id.
pub(crate) fn set_host_kind(store: &Store<'_>, account: &str, computer: &str, expected_revision: u64, kind: &str)
    -> Result<ListRow<HostKindRow>, Refused> {
    if !settings().host_kinds.kinds.contains_key(kind) || computer.len() != 64 || !computer.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(crate::cause!(Refused::Invalid));
    }
    set_row_id(store, &host_kind_id(account, computer), account, expected_revision, HostKindRow { kind: kind.to_string() })
}

fn host_kind_id(account: &str, computer: &str) -> String {
    format!("{}{account}:{computer}", settings().host_kinds.prefix)
}

/// The account's copy rules row, when it has one.
pub(crate) fn rules(store: &Store<'_>, account: &str) -> Result<Option<ListRow<CopyRules>>, Refused> {
    Ok(read_row(store, &names().rules_prefix, account)?.map(|row| row.value))
}

/// Where the values an account uses come from: its own row (`Stored`), or, for an account with no such row, the shipped
/// default (`Defaulted`), read at use and never written back.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Source<T> {
    Stored(T),
    Defaulted(T),
}

impl<T> Source<T> {
    pub(crate) fn value(self) -> T {
        match self {
            Source::Stored(value) | Source::Defaulted(value) => value,
        }
    }
}

/// The copies values `account` uses: its own copies row, else the shipped default.
pub(crate) fn copies_source(store: &Store<'_>, account: &str) -> Result<Source<CopySettings>, Refused> {
    Ok(match copies(store, account)? {
        Some(row) => Source::Stored(row.settings),
        None => Source::Defaulted(crate::account::rows::shipped().copies.clone()),
    })
}

/// The copy rules `account` uses: its own rules row, else the shipped default.
pub(crate) fn rules_source(store: &Store<'_>, account: &str) -> Result<Source<CopyRules>, Refused> {
    Ok(match rules(store, account)? {
        Some(row) => Source::Stored(row.settings),
        None => Source::Defaulted(crate::account::rows::shipped().copies_rules.clone()),
    })
}

/// Change the copy rules row from `expected_revision` (0: no row yet).
pub(crate) fn set_rules(store: &Store<'_>, account: &str, expected_revision: u64, value: CopyRules) -> Result<ListRow<CopyRules>, Refused> {
    if !value.valid() {
        return Err(crate::cause!(Refused::Invalid));
    }
    set_row(store, &names().rules_prefix, account, expected_revision, value)
}

/// The account's offered-computers list, when it has one.
pub(crate) fn offered(store: &Store<'_>, account: &str) -> Result<Option<ListRow<Vec<Offered>>>, Refused> {
    Ok(read_row(store, &names().offered_prefix, account)?.map(|row| row.value))
}

/// Change the offered-computers list from `expected_revision` (0: no row yet). Each computer once, each a computer id, at
/// most `most_offered`.
pub(crate) fn set_offered(store: &Store<'_>, account: &str, expected_revision: u64, value: Vec<Offered>) -> Result<ListRow<Vec<Offered>>, Refused> {
    let mut seen = std::collections::BTreeSet::new();
    if value.len() > names().most_offered
        || !value.iter().all(|offered| crate::account::rows::tokens::owner_text_ok(&offered.computer) && seen.insert(offered.computer.clone()))
    {
        return Err(crate::cause!(Refused::Invalid));
    }
    set_row(store, &names().offered_prefix, account, expected_revision, value)
}

/// What one computer's own report said, as the forwarder holds it (src/forwarder/gateway.rs, `report_path`): whether it is
/// always on, takes new accounts and has room for another account, and when it last reported (milliseconds since the
/// Unix epoch, the forwarder's clock).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reported {
    pub computer: String,
    pub always_on: bool,
    pub takes_new_accounts: bool,
    pub has_room: bool,
    pub last_seen: u64,
    /// The seal formats the computer can open (`sealed_versions` of its report). Absent until a computer reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_versions: Option<Vec<u32>>,
    /// The computer's service unit state, as its report last said it (`OwnReport::unit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<UnitState>,
}

/// The state of a computer's own service unit as systemd reports it (`systemctl show`): what it is doing and how many times
/// it has restarted since it was loaded. A place reports it each tick, so a restart loop is seen by its peers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnitState {
    /// systemd's ActiveState (`active`, `activating`, `failed`, ...).
    pub active: String,
    /// systemd's SubState (`running`, `auto-restart`, ...).
    pub sub: String,
    /// systemd's NRestarts: restarts since the unit was loaded.
    pub restarts: u64,
}

/// What a computer posts of itself (`report_path`): what its own report says (src/account/computers.rs `ComputerReport`:
/// `always_on`, `takes_new_accounts`) and whether it has room for another account (fewer accounts than its `accounts`
/// limit).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnReport {
    pub always_on: bool,
    pub takes_new_accounts: bool,
    pub has_room: bool,
    /// The seal formats this computer can open, when it reports them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sealed_versions: Option<Vec<u32>>,
    /// This computer's own service unit, when its config names one (`ComputerConfig::unit`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<UnitState>,
}

/// The forwarder's answer to a report: every report it holds of a computer whose own session is live now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportsAnswer {
    pub reports: Vec<Reported>,
}

/// Counts each change of the heard reports (`hear_reports`): a choice made from them is kept until this moves.
static HEARD_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The revision of the heard reports; it moves each time what a computer reports changes.
pub(crate) fn heard_revision() -> u64 {
    HEARD_REVISION.load(std::sync::atomic::Ordering::Acquire)
}

/// The reports this computer last heard from the forwarder (`hear_reports`), for every account it holds.
fn heard_reports() -> &'static std::sync::Mutex<Vec<Reported>> {
    static HEARD: std::sync::OnceLock<std::sync::Mutex<Vec<Reported>>> = std::sync::OnceLock::new();
    HEARD.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// The seal formats a computer last reported it can open, None when it reported none or was not heard.
pub(crate) fn heard_sealed_versions(computer: &str) -> Option<Vec<u32>> {
    let held = heard_reports().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    held.iter().find(|report| report.computer == computer).and_then(|report| report.sealed_versions.clone())
}

/// Keep `reports` as what this computer last heard of the other computers' own reports (each once, at most
/// `most_offered`), at `now_ms`. A computer heard before that the forwarder no longer answers (its session ended, or the
/// forwarder restarted and forgot every report it held) keeps what it last said for `report_held_ms` after it was last
/// seen (`merge_heard`), so a forwarder restart does not blank `last_seen` nor drop always-on computers from the rule's
/// counts. Answers whether what each computer reports of itself changed (when each was last seen aside).
pub fn hear_reports(reports: Vec<Reported>, now_ms: u64) -> bool {
    let mut held = heard_reports().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let merged = merge_heard(&held, reports, now_ms, report_held_ms());
    absent_alert_rows().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).extend(absent_alerts(&held, &merged, now_ms));
    let unseen = |reports: &[Reported]| reports.iter().map(|report| Reported { last_seen: 0, ..report.clone() }).collect::<Vec<_>>();
    let changed = unseen(&held) != unseen(&merged);
    *held = merged;
    if changed {
        HEARD_REVISION.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    }
    changed
}

/// What a computer holds after hearing `fresh` at `now_ms`, having held `held`: every fresh report (each computer once,
/// the latest seen), then each held report of a computer the fresh ones do not name and that was last seen at most
/// `held_ms` before now; by computer id, at most `most_offered`.
pub fn merge_heard(held: &[Reported], mut fresh: Vec<Reported>, now_ms: u64, held_ms: u64) -> Vec<Reported> {
    fresh.sort_by(|a, b| a.computer.cmp(&b.computer).then(b.last_seen.cmp(&a.last_seen)));
    fresh.dedup_by(|a, b| a.computer == b.computer);
    let kept = held.iter()
        .filter(|report| fresh.binary_search_by(|one| one.computer.cmp(&report.computer)).is_err())
        .filter(|report| now_ms.saturating_sub(report.last_seen) <= held_ms)
        .cloned()
        .collect::<Vec<_>>();
    fresh.extend(kept);
    fresh.sort_by(|a, b| a.computer.cmp(&b.computer));
    fresh.truncate(names().most_offered);
    fresh
}

/// A computer the rule stopped counting (incident 16): it was silent past `report_held_ms`, so `merge_heard` dropped it.
/// One row per drop, naming the computer and how long it had been silent (`computer-absent`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AbsentAlert {
    pub kind: String,
    pub computer: String,
    pub silent_ms: u64,
    pub raised_at_ms: u64,
}

/// The computers `held` named that `merged` no longer does, each with how long it had been silent at `now_ms`.
pub fn absent_alerts(held: &[Reported], merged: &[Reported], now_ms: u64) -> Vec<AbsentAlert> {
    held.iter()
        .filter(|report| !merged.iter().any(|kept| kept.computer == report.computer))
        .map(|report| AbsentAlert { kind: "computer-absent".to_string(), computer: report.computer.clone(), silent_ms: now_ms.saturating_sub(report.last_seen), raised_at_ms: now_ms })
        .collect()
}

/// The alerts `hear_reports` has raised, oldest first. Every account's copy rule writes them into its own rows
/// (`record_absences`), so they stay here until the process ends.
fn absent_alert_rows() -> &'static std::sync::Mutex<Vec<AbsentAlert>> {
    static ALERTS: std::sync::OnceLock<std::sync::Mutex<Vec<AbsentAlert>>> = std::sync::OnceLock::new();
    ALERTS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// The `computer-absent` alerts this process has raised.
pub fn absent_alerts_raised() -> Vec<AbsentAlert> {
    absent_alert_rows().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// Write each alert as one row of the account's sign-in lists, keyed by its kind, computer and the time it was raised, so
/// the same alert written twice is one row. Answers how many rows it wrote.
pub(crate) fn record_absences(store: &Store<'_>, account: &str, alerts: &[AbsentAlert]) -> Result<usize, Refused> {
    let mut written = 0;
    for alert in alerts {
        let id = format!("alert:{}:{}:{}", alert.kind, alert.computer, alert.raised_at_ms);
        if store.get::<AbsentAlert>(Family::Lists, &id).map_err(|error| Refused::Storage(error.cause()))?.is_some() {
            continue;
        }
        store.insert(Family::Lists, &Row { id, account: account.to_owned(), expires_at: 0, value: alert.clone() }).map_err(|error| Refused::Storage(error.cause()))?;
        written += 1;
    }
    Ok(written)
}

/// What this computer last heard of the other computers' own reports, less any last seen more than `report_held_ms`
/// ago (the forwarder has not been heard from since).
pub fn reports(clock: &dyn crate::storage::time_source::Clock) -> Vec<Reported> {
    let now = crate::storage::record_store::clock_ms(clock);
    let held = heard_reports().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    held.iter().filter(|report| now.saturating_sub(report.last_seen) <= report_held_ms()).cloned().collect()
}

/// The offered-computers list filled from the computers' own reports: every computer whose report says it takes new
/// accounts is offered, with what its report says now (`has_room`, `always_on`), after the computers already offered;
/// one already offered gets what its report says now; one offered by hand that no report names stays as it is. Written
/// (one compare-and-set on the list's revision) only when it changes. Answers whether it wrote.
fn offer_refused(error: Refused) -> CodedError<&'static str> {
    CodedError::with_cause(match error {
        Refused::Invalid(_) => "original_input_refused",
        Refused::Stale(_) => STALE,
        Refused::Storage(_) => "current_source_unavailable",
    }, error.cause())
}

/// The host kind `computer` has for `account`: its kind row, else the kind its offer names (`Offered.kind`, else
/// `host_kinds.offered_kind`), which is the kind it is written with when it is added.
fn joining_kind(store: &Store<'_>, account: &str, computer: &str) -> Result<String, CodedError<&'static str>> {
    if let Some(kind) = host_kind_row(store, account, computer).map_err(offer_refused)? {
        return Ok(kind);
    }
    let offers = offered(store, account).map_err(|error| CodedError::with_cause("current_source_unavailable", error.cause()))?
        .map(|row| row.settings).unwrap_or_default();
    Ok(offers.into_iter().find(|offer| offer.computer == computer).and_then(|offer| offer.kind)
        .unwrap_or_else(|| settings().host_kinds.offered_kind.clone()))
}

/// Write `computer`'s host kind for `account` from its offer when it has no kind row yet. The copy rule writes it before the
/// computer is added, so the added roles are the ones its kind allows.
fn write_offered_kind(store: &Store<'_>, account: &str, computer: &str) -> Result<(), CodedError<&'static str>> {
    if host_kind_row(store, account, computer).map_err(offer_refused)?.is_some() {
        return Ok(());
    }
    let kind = joining_kind(store, account, computer)?;
    set_host_kind(store, account, computer, 0, &kind).map(|_| ()).map_err(offer_refused)
}

pub(crate) fn fill_offered(store: &Store<'_>, here: &Here<'_>) -> Result<bool, Refused> {
    if here.reports.is_empty() {
        return Ok(false);
    }
    let kept = offered(store, here.account)?;
    let revision = kept.as_ref().map_or(0, |row| row.revision);
    let before = kept.map(|row| row.settings).unwrap_or_default();
    let mut after = before.clone();
    for report in here.reports.iter().filter(|report| report.takes_new_accounts) {
        let entry = Offered { kind: None, computer: report.computer.clone(), has_room: report.has_room, always_on: report.always_on };
        match after.iter().position(|offered| offered.computer == report.computer) {
            // A report refreshes what the computer reports, and keeps the host kind its offer names.
            Some(at) => after[at] = Offered { kind: after[at].kind.clone(), ..entry },
            None if after.len() < names().most_offered => after.push(entry),
            None => {}
        }
    }
    if after == before {
        return Ok(false);
    }
    match set_offered(store, here.account, revision, after) {
        Ok(_) => Ok(true),
        // Another write changed the list first: the next write or sweep fills it again.
        Err(Refused::Stale(_)) => Ok(false),
        Err(other) => Err(other),
    }
}

/// The accounts (owner ids) whose writer heard a computer report it caught up since the copy rule last ran for them
/// (`run_soon`), and the wait the copy rule's sweep waits on.
fn caught_up_heard() -> &'static (std::sync::Mutex<std::collections::BTreeSet<String>>, std::sync::Condvar) {
    static HEARD: std::sync::OnceLock<(std::sync::Mutex<std::collections::BTreeSet<String>>, std::sync::Condvar)> = std::sync::OnceLock::new();
    HEARD.get_or_init(|| (std::sync::Mutex::new(std::collections::BTreeSet::new()), std::sync::Condvar::new()))
}

/// The copy rule of the account `owner` runs at once (`wait_run_soon`), not at the next sweep: its writer heard another
/// computer report it caught up (`Message::CaughtUp`), so a run waiting for that computer makes it a voter now; or this
/// computer heard a changed set of reports (`hear_reports`), so a run waiting for an offered computer may add one now.
pub fn run_soon(owner: &str) {
    let (heard, wake) = caught_up_heard();
    if heard.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(owner.to_owned()) {
        wake.notify_all();
    }
}

/// The latest stamp at which a computer reported it caught up to the writer of an account (plan I-1: a voter is admitted
/// only once a majority of the voters are caught up). One row per (account, computer), in the account's sign-in lists,
/// keyed `caught-up:<computer>`; a later report replaces it, an older one does not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CaughtUpStamp {
    pub stamp: i64,
}

/// Record that `computer` reported it caught up at `stamp` to the writer whose account rows are `storage`, for the account
/// keyed `user`. Keeps the latest stamp only.
pub(crate) fn note_caught_up(storage: &dyn Storage, user: &str, computer: &str, stamp: i64) -> Result<(), Refused> {
    let store = Store::new(storage);
    let id = format!("caught-up:{computer}");
    if let Some(held) = store.get::<CaughtUpStamp>(Family::Lists, &id).map_err(|error| Refused::Storage(error.cause()))? {
        if held.value.stamp >= stamp {
            return Ok(());
        }
        store.remove(Family::Lists, &id).map_err(|error| Refused::Storage(error.cause()))?;
    }
    store.insert(Family::Lists, &Row { id, account: user.to_owned(), expires_at: 0, value: CaughtUpStamp { stamp } })
        .map_err(|error| Refused::Storage(error.cause()))
}

/// Whether `computer` has reported it caught up to the writer whose account rows the store holds (see `note_caught_up`).
pub(crate) fn caught_up(store: &Store<'_>, user: &str, computer: &str) -> Result<bool, Refused> {
    let id = format!("caught-up:{computer}");
    Ok(store.get::<CaughtUpStamp>(Family::Lists, &id).map_err(|error| Refused::Storage(error.cause()))?
        .is_some_and(|row| row.account == user))
}

/// Serializes the tests that hear computers: the heard set is one process-wide list, so each such test holds the guard
/// `hear_for_test` returns for as long as it runs.
#[cfg(test)]
static HEARD_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test fixture: holds the heard set for the test's life and empties it, for a test that hears its own reports with
/// `hear_reports` (its guard is the one `hear_for_test` takes).
#[cfg(test)]
pub(crate) fn heard_lock_for_test() -> std::sync::MutexGuard<'static, ()> {
    let guard = HEARD_TESTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    heard_reports().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    guard
}

/// Test fixture: resets the heard set and hears each of `computers` at the clock's time, as a report that offers nothing (no
/// new accounts, no room, not always on): admission sees it heard, and the offered list does not change. The guard it returns
/// holds the heard set for the test.
#[cfg(test)]
pub(crate) fn hear_for_test(clock: &dyn crate::storage::time_source::Clock, computers: &[&str]) -> std::sync::MutexGuard<'static, ()> {
    let guard = heard_lock_for_test();
    let now = crate::storage::record_store::clock_ms(clock);
    let reports = computers.iter().map(|computer| Reported {
        sealed_versions: None, unit: None, computer: computer.to_string(), always_on: false, takes_new_accounts: false, has_room: false, last_seen: now,
    }).collect();
    hear_reports(reports, now);
    guard
}

/// Test fixture: records that each of `computers` reported it caught up to the writer whose account rows are `storage`, as
/// the copies' `CaughtUp` handler does (`note_caught_up`), so an admission that counts caught-up voters sees them.
#[cfg(test)]
pub(crate) fn catch_up_for_test(storage: &dyn Storage, user: &str, computers: &[&str]) {
    for computer in computers {
        note_caught_up(storage, user, computer, 1).unwrap();
    }
}

/// The computers that reported themselves to this computer (`reports`), by id.
pub(crate) fn heard_ids(clock: &dyn crate::storage::time_source::Clock) -> Vec<String> {
    reports(clock).into_iter().map(|report| report.computer).collect()
}

/// Wait at most `wait` for an account `holds` (an owner id this computer holds) whose writer heard a computer report it
/// caught up, and take every such account. Accounts another computer in the same process holds stay for it.
pub fn wait_run_soon(wait: std::time::Duration, holds: &dyn Fn(&str) -> bool) -> Vec<String> {
    let (heard, wake) = caught_up_heard();
    let held = heard.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (mut held, _) = wake.wait_timeout_while(held, wait, |held| !held.iter().any(|owner| holds(owner)))
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let taken: Vec<String> = held.iter().filter(|owner| holds(owner)).cloned().collect();
    held.retain(|owner| !holds(owner));
    taken
}

/// The rows a new account starts with: its copies row and its copy rules row (the computer config's `new_accounts`). Only
/// creation writes them: an account that opens later keeps the values it was pinned with (`repair_older_rules` aside).
pub(crate) fn write_missing(store: &Store<'_>, account: &str, copies_row: &CopySettings, rules_row: &CopyRules) -> Result<usize, Refused> {
    let mut written = 0;
    if copies(store, account)?.is_none() {
        match set_copies(store, account, 0, copies_row.clone()) {
            Ok(_) => written += 1,
            Err(Refused::Stale(_)) => {}
            Err(other) => return Err(other),
        }
    }
    match rules(store, account) {
        Ok(Some(_)) => {}
        Ok(None) => match set_rules(store, account, 0, rules_row.clone()) {
            Ok(_) => written += 1,
            Err(Refused::Stale(_)) => {}
            Err(other) => return Err(other),
        },
        Err(_) => written += repair_older_rules(store, account, rules_row)?,
    }
    Ok(written)
}

/// At each start: the rows an account opened with are its own, so nothing is written for a missing copies or rules row
/// (`write_missing` at creation did that). A rules row of an older shape (before `short_by_each`) is replaced by the
/// starting rules row at its revision, once. Answers how many rows this call wrote.
pub(crate) fn repair_on_open(store: &Store<'_>, account: &str, rules_row: &CopyRules) -> Result<usize, Refused> {
    match rules(store, account) {
        Err(_) => repair_older_rules(store, account, rules_row),
        Ok(_) => Ok(0),
    }
}

/// Replace a rules row of an older shape with the starting rules row, at its revision: one compare-and-set on the stored text.
fn repair_older_rules(store: &Store<'_>, account: &str, rules_row: &CopyRules) -> Result<usize, Refused> {
    let id = row_id(&names().rules_prefix, account);
    // Read as its stored text, so the compare-and-set matches it exactly.
    let held = store.get::<Box<serde_json::value::RawValue>>(Family::Lists, &id).map_err(|error| Refused::Storage(error.cause()))?
        .filter(|row| row.account == account);
    let Some(held) = held else { return Err(crate::cause!(Refused::Storage)) };
    let read: Value = serde_json::from_str(held.value.get()).map_err(|error| crate::carry_cause!(Refused::Storage, error))?;
    let revision = read["revision"].as_u64().ok_or(crate::cause!(Refused::Storage))?;
    let value = serde_json::to_value(ListRow { revision: revision + 1, settings: rules_row.clone() }).map_err(|error| crate::carry_cause!(Refused::Invalid, error))?;
    let after = Row { id, account: account.to_string(), expires_at: 0, value };
    Ok(usize::from(store.replace_if(Family::Lists, &held, &after).map_err(|error| Refused::Storage(error.cause()))?))
}

// ---------------------------------------------------------------------------------------------------------------
// The live counts, `short_by`, and the computers list.

/// The named copy keepers that answered the account `no_copies_here` and have not answered it joined since, by (owner id, computer).
static REFUSING_KEEPERS: std::sync::Mutex<std::collections::BTreeSet<(String, String)>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Keep what a copy keeper's latest answer about the account says: refused (`no_copies_here`) or joined. Only those two answers
/// change it; any other answer leaves what was kept.
pub(crate) fn note_keeper(account: &str, computer: &str, refused: bool) {
    let mut refusing = REFUSING_KEEPERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = (account.to_owned(), computer.to_owned());
    if refused { refusing.insert(key); } else { refusing.remove(&key); }
}

/// Whether `computer` last answered the account `no_copies_here`.
fn keeper_refused(account: &str, computer: &str) -> bool {
    REFUSING_KEEPERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&(account.to_owned(), computer.to_owned()))
}

/// What the computers row does now, counted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Live {
    pub copy_keepers: u64,
    pub voters: u64,
    pub may_answer: u64,
    pub always_on: u64,
}

/// What this computer knows that the rows do not: who it is, what its report says, who holds the writer turn, and who
/// reported they caught up. The door makes it from the account's copies running here (none: one computer, no voters).
pub(crate) struct Here<'a> {
    /// The account's user id (the account rows' `account`).
    pub account: &'a str,
    /// The account's signing key: it signs every computers row an ask's answer writes.
    pub key: &'a AccountKey,
    /// The account's `account_policy.access` (Null: the shipped limits).
    pub access: &'a Value,
    /// This computer's id, when the account's copies run here.
    pub computer: Option<&'a str>,
    /// Whether this computer's own report says it is always on.
    pub always_on: bool,
    /// What the other computers' own reports said, as this computer last heard them (`reported`): whether each is always
    /// on, takes new accounts and has room, and when it last reported. Empty: none heard.
    pub reports: &'a [Reported],
    /// The computer that holds the writer turn, as this computer's copy holds the writer row.
    pub writer: Option<String>,
    /// Whether a computer reported holding every change this computer holds (`Copies::caught_up`).
    pub caught_up: &'a dyn Fn(&str) -> bool,
    /// Now, in milliseconds since the Unix epoch.
    pub now_ms: u64,
    /// The clock the account's computers rows are applied at (`computers::apply`).
    pub clock: &'a dyn crate::storage::time_source::Clock,
}

impl Here<'_> {
    /// Whether `computer` reports it is always on: this computer's own report, or the other computer's own report as
    /// last heard (null: none heard).
    fn always_on(&self, computer: &str) -> Option<bool> {
        if self.computer == Some(computer) {
            return Some(self.always_on);
        }
        self.reported(computer).map(|report| report.always_on)
    }

    /// When `computer` was last seen: now for this computer, the time of its last report for another (null: none heard).
    fn last_seen(&self, computer: &str) -> Option<u64> {
        if self.computer == Some(computer) {
            return Some(self.now_ms);
        }
        self.reported(computer).map(|report| report.last_seen)
    }

    fn reported(&self, computer: &str) -> Option<&Reported> {
        self.reports.iter().find(|report| report.computer == computer)
    }

    fn caught_up(&self, computer: &str) -> bool {
        self.computer == Some(computer) || (self.caught_up)(computer)
    }

    fn subject(&self) -> Subject {
        Subject::Account(self.key.address())
    }
}

/// The live counts of `row` (none: nothing yet). A may-answer computer counts as always on when its own report says so:
/// this computer's, or another's as last heard (`Here::reports`).
pub(crate) fn live(row: Option<&ComputersRow>, here: &Here<'_>) -> Live {
    let Some(row) = row else { return Live::default() };
    let count = |list: &[String]| list.len() as u64;
    Live {
        // A named keeper counts unless it refuses the account (`no_copies_here`, kept by `note_keeper` until it answers joined):
        // a keeper that holds nothing does not count, so the rule adds a holder for it. One still catching up counts.
        copy_keepers: row.copy_keepers.iter().filter(|computer| {
            here.caught_up(computer);
            !keeper_refused(here.account, computer)
        }).count() as u64,
        voters: count(&row.voters),
        may_answer: count(&row.may_answer),
        always_on: row.may_answer.iter().filter(|computer| here.always_on(computer) == Some(true)).count() as u64,
    }
}

/// The context the `short_by` formula reads: the copies row's least counts and the live counts, by name.
fn formula_context(copies: &CopySettings, live: &Live) -> Value {
    let mut context = serde_json::to_value(copies).unwrap_or_else(|_| json!({}));
    if let (Some(context), Ok(Value::Object(live))) = (context.as_object_mut(), serde_json::to_value(live)) {
        context.extend(live);
    }
    context
}

/// One formula's answer as a count: the evaluator answers an exact decimal as its text; a count is never below 0 and a
/// part of a computer is a whole one. `None` when it is not a number.
fn count_of(formula: &Value, context: &Value) -> Option<u64> {
    let value = runs::evaluate_formula(formula, context).ok()?;
    let number = match &value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }
    .filter(|number| number.is_finite())?;
    Some(if number <= 0.0 { 0 } else { number.ceil() as u64 })
}

/// How short the account is of each count, by the formula evaluator (`CopyRules::short_by_each`). `None` when a formula
/// does not answer a number.
pub(crate) fn short_by_each(rules: &CopyRules, copies: &CopySettings, live: &Live) -> Option<Map<String, Value>> {
    let context = formula_context(copies, live);
    let mut each = Map::new();
    for (name, formula) in &rules.short_by_each {
        each.insert(name.clone(), json!(count_of(formula, &context)?));
    }
    Some(each)
}

/// `short_by`, the copies row's computed field: the rules row's formula `short_by` over the least counts, the live counts
/// and `each` (`short_by_each`). `None` when the formula does not answer a number.
fn short_by_of(rules: &CopyRules, copies: &CopySettings, live: &Live, each: &Map<String, Value>) -> Option<u64> {
    let mut context = formula_context(copies, live);
    context["short_by_each"] = Value::Object(each.clone());
    count_of(&rules.short_by, &context)
}

/// `short_by` and `short_by_each` together, as the formulas answer them.
pub(crate) fn short_by_both(rules: &CopyRules, copies: &CopySettings, live: &Live) -> Option<(u64, Map<String, Value>)> {
    let each = short_by_each(rules, copies, live)?;
    Some((short_by_of(rules, copies, live, &each)?, each))
}

/// `short_by`: how many computers the account is short of its least, by the rules row's formula.
pub(crate) fn short_by(rules: &CopyRules, copies: &CopySettings, live: &Live) -> Option<u64> {
    short_by_both(rules, copies, live).map(|(short, _)| short)
}

/// The computers row shown as the list `list_name`: one row per computer it names (keepers first, then voters that keep
/// no copy), each with what it does (`keeps_copy`, `may_answer`, `votes`, `writer`), whether its own report says it is
/// always on and when it was last seen (now for this computer; for another, its own report as last heard, null when none
/// was heard) and whether it caught up.
pub(crate) fn computers_list(store: &Store<'_>, here: &Here<'_>) -> Result<Value, Refused> {
    let row = super::read(store, here.account, &here.subject()).map_err(|error| Refused::Storage(error.cause()))?.map(|row| row.value);
    let rows: Vec<Value> = row.iter().flat_map(|row| {
        let named = row.copy_keepers.iter().chain(row.voters.iter().filter(|voter| !row.copy_keepers.contains(voter)));
        named.map(|computer| json!({
            "computer": computer,
            "keeps_copy": row.copy_keepers.contains(computer),
            "may_answer": row.may_answer.contains(computer),
            "votes": row.voters.contains(computer),
            "writer": here.writer.as_deref() == Some(computer.as_str()),
            "always_on": here.always_on(computer),
            "last_seen": here.last_seen(computer),
            "caught_up": here.caught_up(computer),
        })).collect::<Vec<_>>()
    }).collect();
    Ok(json!({"list": names().list_name, "revision": row.as_ref().map(|row| row.revision), "rows": rows}))
}

/// One row of the computers list as a person writes it: what the computer should do now.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ListRowWrite {
    pub computer: String,
    pub keeps_copy: bool,
    #[serde(default)]
    pub may_answer: bool,
    #[serde(default)]
    pub votes: bool,
    #[serde(default)]
    pub writer: bool,
}

impl ListRowWrite {
    /// The computers operation this row write is (`computers::Operation`), against the row as it is now: a computer
    /// that keeps no copy is removed (`remove-computer`); one that should hold the writer turn is moved to
    /// (`move-writer`); a new one is added (`add-computer`); one already named gets its may-answer and vote set
    /// (`set`, the row's other computers as they are). `computers::apply` then makes it, one voter step per edit.
    pub(crate) fn operation(&self, row: Option<&ComputersRow>) -> Operation {
        let computer = self.computer.clone();
        if !self.keeps_copy {
            return Operation::RemoveComputer { pursuit: None, computer };
        }
        if self.writer {
            return Operation::MoveWriter { pursuit: None, computer };
        }
        match row.filter(|row| row.copy_keepers.contains(&computer)) {
            None => Operation::AddComputer { pursuit: None, computer, may_answer: self.may_answer, voter: self.votes },
            Some(row) => {
                let toggled = |list: &[String], on: bool| {
                    let mut list: Vec<String> = list.iter().filter(|named| **named != computer).cloned().collect();
                    if on { list.push(computer.clone()); }
                    list
                };
                Operation::Set {
                    pursuit: None,
                    keeps_copy: row.copy_keepers.clone(),
                    may_answer: toggled(&row.may_answer, self.may_answer),
                    voters: toggled(&row.voters, self.votes),
                }
            }
        }
    }
}

/// Whether an edit from `before` to `after` computers that keep a copy goes below the account's rule: fewer than before,
/// and fewer than `least_copy_keepers` of the copies row, or of `lowered` when the same edit lowers the rule. An edit
/// that adds keepers is never refused, so an account below its rule can always climb back. An account with no copies
/// row has no rule here.
pub(crate) fn below_rule(store: &Store<'_>, account: &str, before: usize, after: usize, lowered: Option<&CopySettings>) -> Result<bool, Refused> {
    let least = match lowered {
        Some(lowered) => Some(lowered.least_copy_keepers),
        None => Some(copies_source(store, account)?.value().least_copy_keepers),
    };
    Ok(after < before && least.is_some_and(|least| (after as u64) < least))
}

// ---------------------------------------------------------------------------------------------------------------
// The rule and its runs.

/// One kept workflow run. A refusal and its source identity are one value;
/// serialization exposes their existing code/payload and additive cause siblings.
#[derive(Clone, Debug)]
pub struct RunRow {
    pub run_id: String,
    pub workflow_id: String,
    pub request_key: String,
    pub started_by: Value,
    pub started_at: String,
    pub input: Value,
    pub answers: Map<String, Value>,
    pub state: String,
    pub status: Value,
    pub waiting: Value,
    pub steps: Value,
    pub added: Option<String>,
    pub blocked: Option<CodedError<String>>,
    pub error: Option<CodedError<Value>>,
}

/// A new observed origin must be written even when its public code is unchanged.
impl PartialEq for RunRow {
    fn eq(&self, other: &Self) -> bool {
        self.run_id == other.run_id
            && self.workflow_id == other.workflow_id
            && self.request_key == other.request_key
            && self.started_by == other.started_by
            && self.started_at == other.started_at
            && self.input == other.input
            && self.answers == other.answers
            && self.state == other.state
            && self.status == other.status
            && self.waiting == other.waiting
            && self.steps == other.steps
            && self.added == other.added
            && same_run_refusal(&self.blocked, &other.blocked)
            && same_run_refusal(&self.error, &other.error)
    }
}
fn same_run_refusal<C: PartialEq>(left: &Option<CodedError<C>>, right: &Option<CodedError<C>>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.code == right.code && left.cause() == right.cause(),
        _ => false,
    }
}

impl Serialize for RunRow {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let fields = 12 + usize::from(self.added.is_some())
            + 2 * usize::from(self.blocked.is_some()) + 2 * usize::from(self.error.is_some());
        let mut row = serializer.serialize_struct("RunRow", fields)?;
        row.serialize_field("run_id", &self.run_id)?;
        row.serialize_field("workflow_id", &self.workflow_id)?;
        row.serialize_field("request_key", &self.request_key)?;
        row.serialize_field("started_by", &self.started_by)?;
        row.serialize_field("started_at", &self.started_at)?;
        row.serialize_field("input", &self.input)?;
        row.serialize_field("answers", &self.answers)?;
        row.serialize_field("state", &self.state)?;
        row.serialize_field("status", &self.status)?;
        row.serialize_field("waiting", &self.waiting)?;
        row.serialize_field("steps", &self.steps)?;
        row.serialize_field("_refusal_causes", "paired")?;
        if let Some(added) = &self.added { row.serialize_field("added", added)?; }
        if let Some(blocked) = &self.blocked {
            row.serialize_field("blocked", &blocked.code)?;
            row.serialize_field("blocked_cause", &blocked.cause())?;
        }
        if let Some(error) = &self.error {
            row.serialize_field("error", &error.code)?;
            row.serialize_field("error_cause", &error.cause())?;
        }
        row.end()
    }
}

/// Input-only shape. It is validated into RunRow before any caller sees it.
/// The marker distinguishes an actual historical missing origin from damage
/// to a newly written pair; historical origins are explicitly unrecorded.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunRowWire {
    run_id: String,
    workflow_id: String,
    request_key: String,
    started_by: Value,
    started_at: String,
    input: Value,
    answers: Map<String, Value>,
    state: String,
    status: Value,
    waiting: Value,
    steps: Value,
    #[serde(default)]
    added: Option<String>,
    #[serde(default)]
    blocked: Option<String>,
    #[serde(default)]
    blocked_cause: Option<crate::refusal_cause::Cause>,
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    error_cause: Option<crate::refusal_cause::Cause>,
    #[serde(default, rename = "_refusal_causes")]
    refusal_causes: Option<String>,
}

impl<'de> Deserialize<'de> for RunRow {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let wire = RunRowWire::deserialize(deserializer)?;
        let paired = match wire.refusal_causes.as_deref() {
            Some("paired") => true,
            None => false,
            Some(_) => return Err(serde::de::Error::custom("unknown run refusal cause format")),
        };
        if (wire.blocked.is_none() && wire.blocked_cause.is_some())
            || (wire.error.is_none() && wire.error_cause.is_some())
            || (paired && (wire.blocked.is_some() != wire.blocked_cause.is_some()
                || wire.error.is_some() != wire.error_cause.is_some()))
        {
            return Err(serde::de::Error::custom("run refusal code and cause must be paired"));
        }
        let blocked = wire.blocked.map(|code| CodedError::with_cause(code,
            wire.blocked_cause.unwrap_or_else(|| crate::cause!(historical_origin_unrecorded blocked))));
        let error = wire.error.map(|value| CodedError::with_cause(value,
            wire.error_cause.unwrap_or_else(|| crate::cause!(historical_origin_unrecorded error))));
        Ok(Self {
            run_id: wire.run_id,
            workflow_id: wire.workflow_id,
            request_key: wire.request_key,
            started_by: wire.started_by,
            started_at: wire.started_at,
            input: wire.input,
            answers: wire.answers,
            state: wire.state,
            status: wire.status,
            waiting: wire.waiting,
            steps: wire.steps,
            added: wire.added, blocked, error,
        })
    }
}

/// What the rule did on one write or sweep.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Outcome {
    /// `short_by` before the runs were run (null: the account has no copies row or rules row, or the formula failed).
    pub short_by: Option<u64>,
    /// Why the rule did not run, when it did not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_run: Option<&'static str>,
    /// The runs this call started.
    pub started: Vec<String>,
    /// Every working run after this call, and the finished or failed runs this call ended.
    pub runs: Vec<RunRow>,
}

fn at_text(now_ms: u64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(i64::try_from(now_ms).unwrap_or(0))
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Every run row of the account, by id, at most `most_runs`.
pub(crate) fn kept_runs(store: &Store<'_>, account: &str) -> Result<Vec<Row<RunRow>>, Refused> {
    let prefix = row_id(&names().run_prefix, account);
    let rows = store.list::<Value>(Family::Lists, account, usize::MAX).map_err(|error| Refused::Storage(error.cause()))?;
    let mut kept = Vec::new();
    for row in rows.into_iter().filter(|row| row.id.starts_with(&prefix)) {
        let Ok(value) = serde_json::from_value::<RunRow>(row.value) else { continue };
        kept.push(Row { id: row.id, account: row.account, expires_at: row.expires_at, value });
    }
    kept.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(kept)
}

/// The rule over the account as it is now, then every working run run on: after a write of the computers row or of the
/// copy rule's rows, and at each sweep. Nothing is refused here: a run that cannot go on says why in its row.
pub(crate) fn after_write(store: &Store<'_>, here: &Here<'_>) -> Result<Outcome, Refused> {
    record_absences(store, here.account, &absent_alerts_raised())?;
    // One run of the rule at a time at this computer: a door write and a sweep woken by a caught-up report must not both
    // answer one run's ask (both would act, one run row would win, and the run would forget the computer it added).
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (copies_row, rules_row) = (copies_source(store, here.account)?.value(), rules_source(store, here.account)?.value());
    fill_offered(store, here)?;
    let computers = super::read(store, here.account, &here.subject()).map_err(|error| Refused::Storage(error.cause()))?.map(|row| row.value);
    let counted = live(computers.as_ref(), here);
    let Some((short, each)) = short_by_both(&rules_row, &copies_row, &counted) else {
        return Ok(Outcome { not_run: Some("short_by_formula_failed"), ..Outcome::default() });
    };
    let mut outcome = Outcome { short_by: Some(short), ..Outcome::default() };
    let mut value = formula_context(&copies_row, &counted);
    value["short_by"] = json!(short);
    value["short_by_each"] = Value::Object(each.clone());
    value["computers_revision"] = json!(computers.as_ref().map_or(0, |row| row.revision));
    let change = json!({"address": row_id(&names().copies_prefix, here.account), "path": [names().change_kind], "value": value});
    let rule_id = rules_row.rule["id"].as_str().unwrap_or_default().to_string();
    // The rule is addressed by the row it is kept in (`rules_prefix`): it is a account row, not one of the records
    // the account's rules are kept as. Only its sends are read here.
    let rule_kind = names().rules_prefix.trim_end_matches(':');
    let fired = runs::rules_over_records(&names().rule_partition, rule_kind, &[(rule_id, rules_row.rule.clone())], &[change], &[])
        .map_err(|error| Refused::Invalid(error.cause()))?;
    let workflow_id = rules_row.workflow_id().unwrap_or_default().to_string();
    let mut kept = kept_runs(store, here.account)?;
    for fire in fired.fires.iter().filter(|fire| fire["later"] != Value::Bool(true)) {
        let payload = &fire["payload"];
        if payload["then"]["workflow_id"].as_str() != Some(workflow_id.as_str()) {
            continue;
        }
        // One computer is added at a time: a run still working is run on instead of starting another.
        if kept.iter().any(|run| run.value.state == "working") || kept.len() >= names().most_runs {
            continue;
        }
        let request_key = runs::send_key(payload);
        let run_id = runs::run_id(&workflow_id, &request_key).map_err(|error| Refused::Invalid(error.cause()))?;
        let id = format!("{}:{run_id}", row_id(&names().run_prefix, here.account));
        if kept.iter().any(|run| run.id == id) {
            continue;
        }
        let run = RunRow {
            run_id: run_id.clone(), workflow_id: workflow_id.clone(), request_key, started_by: payload["rule_id"].clone(),
            started_at: at_text(here.now_ms), input: payload.get("input").cloned().unwrap_or_else(|| json!({})),
            answers: Map::new(), state: "working".into(), status: Value::Null, waiting: json!([]), steps: Value::Null,
            added: None, blocked: None, error: None,
        };
        let row = Row { id, account: here.account.to_string(), expires_at: 0, value: run };
        store.insert(Family::Lists, &row).map_err(|error| Refused::Stale(error.cause()))?;
        outcome.started.push(run_id);
        kept.push(row);
    }
    'runs: for mut run in kept.into_iter().filter(|run| run.value.state == "working") {
        // A run that chose the computer it adds keeps that choice first (`CHOSEN`), then adds it on the next pass: a
        // run row write that fails after the computers row changed never makes the run forget what it added.
        for _ in 0..2 {
            let before = run.value.clone();
            go_on(store, here, &rules_row, short, &each, &mut run.value);
            if run.value == before {
                break;
            }
            let prior = Row { id: run.id.clone(), account: run.account.clone(), expires_at: run.expires_at, value: before };
            if !store.replace_if(Family::Lists, &prior, &run).map_err(|error| Refused::Storage(error.cause()))? {
                // Another write or sweep ran it on first: what it kept counts.
                continue 'runs;
            }
            if run.value.blocked.as_ref().map(|why| why.as_str()) != Some(CHOSEN) {
                break;
            }
        }
        outcome.runs.push(run.value);
    }
    Ok(outcome)
}

/// A computers operation's refusal as the door names it.
fn refusal_code(refused: ComputersRefused) -> CodedError<&'static str> {
    let cause = refused.cause();
    let code = match refused {
        ComputersRefused::Stale(_) => "computers_revision_changed",
        ComputersRefused::Invalid(_) => "original_input_refused",
        ComputersRefused::NoKey(_) => "computers_signing_key_unavailable",
        ComputersRefused::OverLimit(_) => "computers_over_limit",
        ComputersRefused::NoWriterRow(_) => "computers_no_writer_row",
        ComputersRefused::HostKind(_) => "computer_host_kind_cannot_answer",
        ComputersRefused::Unheard(_) => "computer_not_heard",
        ComputersRefused::NoMajority(_) => "computers_no_majority_caught_up",
        ComputersRefused::NoComputer(_) | ComputersRefused::Storage(_) => "current_source_unavailable",
    };
    CodedError::with_cause(code, cause)
}

/// Why a run waits one pass: it chose the computer it adds and keeps that choice before it adds it.
const CHOSEN: &str = "computer_chosen";

/// Why a run ends without finishing: the account is no longer short before it added a computer (the owner met the rule
/// another way), or the computer it added was removed before it could vote.
const ENDS_A_RUN: [&str; 2] = ["no_longer_short", "added_computer_removed"];

/// Run `run` on, replying to the asks this file answers, at most `most_passes` times. `each` is `short_by_each` now.
fn go_on(store: &Store<'_>, here: &Here<'_>, rules_row: &CopyRules, short: u64, each: &Map<String, Value>, run: &mut RunRow) {
    let names = names();
    for _ in 0..names.most_passes {
        let ran = runs::run_workflow_definition(&json!([rules_row.workflow]), &run.workflow_id, &run.input,
            &Value::Object(run.answers.clone()), &names.workflow_partition, &run.started_at);
        let ran = match ran {
            Ok(ran) => ran,
            Err(error) => {
                run.state = "failed".into();
                let cause = error.cause();
                run.error = Some(CodedError::with_cause(json!(error.code), cause));
                return;
            }
        };
        run.state = match ran["status"].as_str() { Some("completed") => "finished", Some("failed") => "failed", _ => "working" }.into();
        run.status = ran["status"].clone();
        run.waiting = ran["waiting"].clone();
        run.steps = ran["execution_context"]["steps"].clone();
        if let Some(error) = ran.get("error").filter(|error| !error.is_null()) {
            let cause = ran.get("cause").and_then(Value::as_str).and_then(crate::refusal_cause::Cause::from_wire)
                .unwrap_or_else(|| crate::cause!(copy_rule workflow_reported_error));
            run.error = Some(CodedError::with_cause(error.clone(), cause));
        }
        if run.state != "working" {
            run.blocked = None;
            return;
        }
        let waiting: Vec<Value> = run.waiting.as_array().cloned().unwrap_or_default();
        let mut answered = false;
        for ask in waiting {
            let step = ask["step_id"].as_str().unwrap_or_default().to_string();
            let asks = ask["asks"].as_str().unwrap_or_default();
            match answer(store, here, run, asks, short, each) {
                Ok(value) => {
                    run.answers.insert(step, value);
                    run.blocked = None;
                    answered = true;
                }
                Err(why) if ENDS_A_RUN.contains(&why.code) => {
                    run.state = "ended".into();
                    let cause = why.cause();
                    run.blocked = Some(CodedError::with_cause(why.code.to_string(), cause));
                    return;
                }
                Err(why) => { let cause = why.cause(); run.blocked = Some(CodedError::with_cause(why.code.to_string(), cause)); },
            }
        }
        if !answered {
            return;
        }
    }
}

/// The answer to one ask of a run, or why it cannot be answered yet.
fn answer(store: &Store<'_>, here: &Here<'_>, run: &mut RunRow, asks: &str, short: u64, each: &Map<String, Value>) -> Result<Value, CodedError<&'static str>> {
    let names = names();
    let short_of = |count: &str| each.get(count).and_then(Value::as_u64).unwrap_or(0);
    // Short only of computers that report they are always on: only such a computer meets the rule, so no other is added.
    let only_always_on = short_of("always_on") > 0 && each.iter().all(|(count, value)| count == "always_on" || value.as_u64() == Some(0));
    let subject = here.subject();
    let now = super::read(store, here.account, &subject).map_err(|error| CodedError::with_cause("current_source_unavailable", error.cause()))?.map(|row| row.value);
    if asks == names.add_computer_ask {
        let computer = match &run.added {
            Some(added) => added.clone(),
            None if short == 0 => return Err(CodedError::new("no_longer_short")),
            // The choice is kept first (the run row), then made on the next pass.
            None => {
                let offered_row = offered(store, here.account).map_err(|error| CodedError::with_cause("current_source_unavailable", error.cause()))?.map(|row| row.settings).unwrap_or_default();
                let keeps = |computer: &str| now.as_ref().is_some_and(|row| row.copy_keepers.iter().any(|named| named == computer));
                // Only a computer whose kind allows it to keep a copy is added: its kind gives the roles it joins with.
                let mut room: Vec<&Offered> = Vec::new();
                for entry in offered_row.iter().filter(|entry| entry.has_room && !keeps(&entry.computer)) {
                    if host_kind_allows(&joining_kind(store, here.account, &entry.computer)?, SYNC) {
                        room.push(entry);
                    }
                }
                // When always-on computers are short, the first offered one that reports it is always on comes first.
                let chosen = match room.iter().find(|entry| entry.always_on) {
                    Some(entry) if short_of("always_on") > 0 => Some(*entry),
                    _ if only_always_on => return Err(CodedError::new("no_offered_always_on_computer_with_room")),
                    _ => room.first().copied(),
                };
                let chosen = chosen.map(|entry| entry.computer.clone()).ok_or(CodedError::new("no_offered_computer_with_room"))?;
                run.added = Some(chosen);
                return Err(CodedError::new(CHOSEN));
            }
        };
        // Added already (a pass whose run row was not kept): nothing more to do.
        if now.as_ref().is_some_and(|row| row.copy_keepers.contains(&computer)) {
            return Ok(json!({"computer": computer}));
        }
        write_offered_kind(store, here.account, &computer)?;
        let kind = joining_kind(store, here.account, &computer)?;
        // An account with no voters is one computer that writes with no writer row: a second computer that may answer
        // would be a second writer (`computers::Refused::NoWriterRow`). The computer that answers it now becomes its first
        // voter first, so its copies run and the added computer follows them.
        if let Some(in_use) = now.as_ref().filter(|row| row.voters.is_empty()).and_then(|row| row.may_answer.first()) {
            let first = Operation::MoveWriter { pursuit: None, computer: in_use.clone() };
            apply(store, here.account, &first, here.key, here.access, here.clock).map_err(refusal_code)?;
        }
        let operation = Operation::AddComputer { pursuit: None, computer: computer.clone(), may_answer: host_kind_allows(&kind, ANSWER), voter: false };
        apply(store, here.account, &operation, here.key, here.access, here.clock).map_err(refusal_code)?;
        return Ok(json!({"computer": computer}));
    }
    if asks == names.voter_step_ask {
        let computer = run.added.clone().ok_or(CodedError::new("no_computer_added"))?;
        if !now.as_ref().is_some_and(|row| row.copy_keepers.contains(&computer)) {
            return Err(CodedError::new("added_computer_removed"));
        }
        if now.as_ref().is_some_and(|row| row.voters.contains(&computer)) {
            return Ok(json!({"computer": computer, "votes": true}));
        }
        // A computer whose kind does not allow it to vote keeps its copy and is not a voter.
        let kind = joining_kind(store, here.account, &computer)?;
        if !host_kind_allows(&kind, VOTE) {
            return Ok(json!({"computer": computer, "votes": false}));
        }
        if !here.caught_up(&computer) {
            return Err(CodedError::new("waiting_for_caught_up"));
        }
        let operation = Operation::AddComputer { pursuit: None, computer: computer.clone(), may_answer: host_kind_allows(&kind, ANSWER), voter: true };
        apply(store, here.account, &operation, here.key, here.access, here.clock).map_err(refusal_code)?;
        return Ok(json!({"computer": computer, "votes": true}));
    }
    Err(CodedError::new("ask_not_answered_here"))
}

/// The account's copy rule as the door shows it: its rows, the live counts, `short_by` and its runs.
pub(crate) fn shown(store: &Store<'_>, here: &Here<'_>) -> Result<Value, Refused> {
    let copies_row = copies(store, here.account)?;
    let rules_row = rules(store, here.account)?;
    let offered_row = offered(store, here.account)?;
    let computers = super::read(store, here.account, &here.subject()).map_err(|error| Refused::Storage(error.cause()))?.map(|row| row.value);
    let counted = live(computers.as_ref(), here);
    let both = short_by_both(&rules_source(store, here.account)?.value(), &copies_source(store, here.account)?.value(), &counted);
    let (short, each) = (both.as_ref().map(|(short, _)| *short), both.map(|(_, each)| each));
    let runs: Vec<RunRow> = kept_runs(store, here.account)?.into_iter().map(|row| row.value).collect();
    Ok(json!({
        "copies": copies_row, "rules": rules_row, "offered": offered_row,
        "live": counted, "computed": {"short_by": short, "short_by_each": each}, "runs": runs,
    }))
}

/// The rows the tests give an account: the synthetic starting rows src/account/rows/new-accounts.json.
#[cfg(test)]
pub(crate) fn for_tests() -> (CopySettings, CopyRules) {
    let rows: crate::account::rows::StartingRows =
        serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account/rows/new-accounts.json")))
            .expect("the starting rows fixture reads");
    (rows.copies, rows.copies_rules)
}

#[cfg(test)]
#[path = "copy_rule_tests.rs"]
mod tests;

crate::impl_caused!(Refused);
