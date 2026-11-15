//! Deleting an account completely when its person asks: one kept deletion, run in bounded steps that resume where a
//! stop left them, and never done twice. The port of old trillion src/account-erasure-policy.mjs (551 lines) with its
//! pace (src/account-deletion-pace.json, records/native-lifecycle-continuation.json) and the person's own delete
//! (src/account-routes.mjs:857-871 `account/delete`, src/worker.mjs:3358-3423 `deleteAccount`).
//!
//! Non-negotiable invariants (old :64-333):
//! 1. One kept deletion per account (old `account-erasure`, `account-erasure-continuation`): a row in the account's own
//!    lists (`account/rows`), id `settings.json` `row_prefix` + the account's user id, written compare-and-set on the row read.
//!    Asking to delete an account whose deletion is kept continues that deletion (old src/worker.mjs:3359-3366: "a
//!    delete pressed again while it finishes continues it"); one whose deletion is complete is refused
//!    `account_erasure_complete` (old :286-287) and nothing runs again.
//! 2. Bounded steps in a fixed order (`settings.json` `steps`; old :217-253 `continueAccountErasure`: tool runs, the
//!    account's store, then its own rows last, old src/worker.mjs:3393-3420). Each step erases one owner's rows through
//!    that owner's own functions (`Step`), one bounded page at a time, and the row keeps the step and its cursor after
//!    every page, so a process that stops anywhere resumes at the page it was on; a page done twice is the same page.
//! 3. While a deletion is kept, nothing else of the account answers (old src/worker.mjs:3360-3365 `accountBeingDeleted`):
//!    the account routes refuse every other operation (`deleting`, src/account/account_routes.rs `admitted`).
//! 4. The account-rows step is last and erases every row of the account in every family of its own rows (`account/rows`:
//!    its computers rows and its lists), expired rows too, except the kept deletion row, which ends terminal with when
//!    the account was erased. Sign-in keeps no row here: it is the Better Auth Workshop tool, which erases its own.
//! 5. A failing step is never parked (old :150-171 `armAccountErasure`): it waits `failure_delays_ms`, and past
//!    `maximum_consecutive_failures` a step failing with the same words waits `repeat_growth` times longer, up to
//!    `longest_repeat_delay_ms`; a failure its step says is passing waits `transient_delays_ms` and never counts; its
//!    kept reason names the step and its words with every identifier taken out (`failure_shape`, old :18-22
//!    `deletionFailureShape`). A page that moved nothing `stall_after` times in a row waits longer (old :136-148).
//! 6. Who may delete: the caller the account's routes admit as the account (`account/signed_in.rs`); nothing more is
//!    asked here.
//!
//! Dropped from the old file, by the rules (Durable Object, KV and Worker plumbing; central shared storage):
//! - the identity Durable Object's erasure (old :360-366 `eraseAccountIdentity`, src/account-erasure-identity.mjs), the
//!   share index (src/account-share-index-erasure.mjs), the app state book (src/account-app-state-erasure.mjs), the born
//!   account's policy owner (src/born-account-erasure.mjs), the shared network command pages, their quota permits and
//!   metadata retirement (old :336-551: `advanceSharedAccountErasure`, `retryAccountErasurePage`,
//!   `settleInterruptedAccountErasurePage`, `admitAccountErasure`, `quotaReserveErasure`, `closeAccountErasureQuota`,
//!   `nextAccountErasureMetadataSource`, `validateAccountErasureCommand`, `recordAccountErasureTerminal`), the
//!   published-item and host-resource and raw-export erasures (src/published-account-erasure.mjs,
//!   src/host-resource-account-erasure.mjs, src/raw-export-account-erasure.mjs): each is worker-host, the parts of an
//!   account the hosted Worker kept in other objects; trillion-local keeps an account only in its own state folder;
//! - the policy update's pause and its carry, the forwarder's upgrade and the superseded deletion (old :106-129,
//!   :278-333): they reconcile two Durable Objects that each kept a copy of the deletion; here the one row is the deletion;
//! - the alarm that drives the deletion with no caller (old :174 `setAlarm`): an always-on default; the deletion goes
//!   on each time it is asked (the account's delete asked again), and answers when it may try again;
//! - the transient words of the platform (old pace `transient_messages`): a step says itself that its failure passes;
//! - the retry rule stamp (old `rule`, :192-202 `redriveErasureUnderCurrentRule`): no delay outlives a call here; the
//!   operator's redrive (old :182-191 `redriveAccountErasure`) is the person's own (`redrive`);
//! - payment, camera, share owner and app installation clean-up of old src/worker.mjs `deleteAccount`: product features.
//!
//! Stored values, owned by this file: lists `Deletion`, id `row_prefix` + the account's user id.

use super::rows::{self, now_ms, store::{Family, Row, Store}};
use crate::account_files::{names::Carry, AccountFiles, LIVE, SET_ASIDE};
use crate::records::{Records, MAX_PAGE_ITEMS};
use crate::storage::{record_store::RecordStore, Storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Instant;

/// `erase/settings.json`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub row_prefix: String,
    pub steps: Vec<String>,
    pub pages_per_call: usize,
    pub rows_per_page: usize,
    pub records: Vec<String>,
    pub failure_delays_ms: Vec<u64>,
    pub maximum_consecutive_failures: u32,
    pub repeat_growth: u64,
    pub longest_repeat_delay_ms: u64,
    pub transient_delays_ms: Vec<u64>,
    pub stall_after: u32,
    pub longest_stall_delay_ms: u64,
    pub shape_chars: usize,
}

/// The steps an account's deletion knows, by the names `steps` lists.
pub(crate) const TOOL_RUNS: &str = "tool-runs";
pub(crate) const FILES: &str = "files";
pub(crate) const RECORDS: &str = "records";
pub(crate) const ACCOUNT_ROWS: &str = "account-rows";

impl Settings {
    fn valid(&self) -> bool {
        let known = [TOOL_RUNS, FILES, RECORDS, ACCOUNT_ROWS];
        self.steps.last().map(String::as_str) == Some(ACCOUNT_ROWS)
            && self.steps.iter().all(|step| known.contains(&step.as_str()))
            && self.steps.iter().enumerate().all(|(at, step)| !self.steps[..at].contains(step))
            && (1..=1000).contains(&self.pages_per_call)
            && (1..=MAX_PAGE_ITEMS).contains(&self.rows_per_page)
            && !self.failure_delays_ms.is_empty() && !self.transient_delays_ms.is_empty()
            && self.maximum_consecutive_failures >= 1 && self.repeat_growth >= 1 && self.stall_after >= 1
            && (16..=2000).contains(&self.shape_chars) && !self.row_prefix.is_empty()
            && self.records.iter().all(|resource| crate::storage::record_store_resources::declares(resource))
    }
}

pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        let settings: Settings = serde_json::from_slice(include_bytes!("erase/settings.json")).expect("erase/settings.json is valid");
        assert!(settings.valid(), "erase/settings.json names its steps, account-rows last, and bounded pages and waits");
        settings
    })
}

/// `erase/words.json`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Words {
    #[serde(rename = "_what")]
    _what: String,
    pub deleted: String,
    pub being_deleted: String,
    pub waits: String,
    pub already_deleted: String,
    pub not_begun: String,
    pub redriven: String,
    pub not_redriven: String,
}

pub(crate) fn words() -> &'static Words {
    static WORDS: OnceLock<Words> = OnceLock::new();
    WORDS.get_or_init(|| serde_json::from_slice(include_bytes!("erase/words.json")).expect("erase/words.json is valid"))
}

/// The kept deletion (old `account-erasure` and `account-erasure-continuation` in one row).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Deletion {
    /// When it began (old `deleting_since`), UTC ms.
    pub began_at: u64,
    /// The step it is on (one of `steps`), and that step's cursor.
    pub step: String,
    pub cursor: String,
    /// How many rows each step erased.
    pub erased: BTreeMap<String, u64>,
    /// When the account was erased (old `account-erased-at`): set once, terminal.
    pub erased_at: Option<u64>,
    pub continuation: Continuation,
}

/// When the deletion may go on, and why it waits (old `account-erasure-continuation`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Continuation {
    /// `pending`, `retry`, `stalled` or `recovery-required` (old :144, :160, :167).
    pub state: String,
    pub due_at: u64,
    pub failures: u32,
    pub repeats: u32,
    pub beyond_bound: u32,
    pub transient_failures: u32,
    pub stalled: u32,
    pub last_failure: Option<Failure>,
    pub first_failed_at: Option<u64>,
}

/// A step's kept failure: which step, its words with every identifier taken out, and whether it said it passes.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Failure {
    #[serde(default = "legacy_failure_cause")]
    pub cause: crate::refusal_cause::ReportedCause,
    pub step: String,
    pub shape: String,
    pub transient: bool,
}

fn legacy_failure_cause() -> crate::refusal_cause::ReportedCause {
    crate::cause!(account_erasure historical_origin_unrecorded).into()
}
impl PartialEq for Failure {
    fn eq(&self, other: &Self) -> bool {
        self.step == other.step && self.shape == other.shape && self.transient == other.transient
    }
}
impl Eq for Failure {}
impl Failure {
    pub fn cause(&self) -> crate::refusal_cause::ReportedCause { self.cause.clone() }
}
crate::impl_caused!(Failure);


/// One page a step took: how many rows it erased, and its next cursor (`None`: the step is complete).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Page {
    pub erased: u64,
    pub next: Option<String>,
}

/// Why a step's page failed: its words, and whether the step says the failure passes (a busy store, a held file).
#[derive(Clone, Debug)]
pub(crate) struct StepFailure {
    pub cause: crate::refusal_cause::ReportedCause,
    pub words: String,
    pub transient: bool,
}

impl PartialEq for StepFailure {
    fn eq(&self, other: &Self) -> bool { self.words == other.words && self.transient == other.transient }
}
impl Eq for StepFailure {}
impl StepFailure {
    pub fn cause(&self) -> crate::refusal_cause::ReportedCause { self.cause.clone() }
}
crate::impl_caused!(StepFailure);


/// One step of a deletion: one owner's rows of the account, erased a bounded page at a time after `cursor`.
pub(crate) trait Step {
    fn page(&mut self, cursor: &str) -> Result<Page, StepFailure>;
}

/// Why a deletion step was refused.
#[derive(Clone, Debug)]
pub(crate) enum Refused {
    /// The account's deletion is already complete (409).
    Complete(crate::refusal_cause::Cause),
    /// No deletion is kept.
    NotBegun(crate::refusal_cause::Cause),
    /// The caller is no longer admitted, or another driver changed the row in a way this call cannot take.
    NotCurrent(crate::refusal_cause::Cause),
    /// A step its driver has not given (a caller that cannot reach that owner).
    StepMissing(String, crate::refusal_cause::Cause),
    Storage(crate::refusal_cause::Cause),
}
impl Refused {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Complete(cause) => cause.clone(),
            Self::NotBegun(cause) => cause.clone(),
            Self::NotCurrent(cause) => cause.clone(),
            Self::StepMissing(_, cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refused);

impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Complete(_), Self::Complete(_)) => true,
            (Self::NotBegun(_), Self::NotBegun(_)) => true,
            (Self::NotCurrent(_), Self::NotCurrent(_)) => true,
            (Self::StepMissing(a0, _), Self::StepMissing(b0, _)) => a0 == b0,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}
impl Eq for Refused {}


impl From<rows::Error> for Refused {
    fn from(error: rows::Error) -> Self {
        Refused::Storage(error.cause())
    }
}

impl Refused {
    /// The refusal code the account routes answer, and its words.
    pub(crate) fn code_and_words(&self) -> (&'static str, String) {
        let words = words();
        match self {
            Refused::Complete(_) => ("account_erasure_complete", words.already_deleted.clone()),
            Refused::NotBegun(_) => ("account_erasure_not_begun", words.not_begun.clone()),
            Refused::NotCurrent(_) => ("current_workspace_rights_refused", String::new()),
            Refused::StepMissing(_, _) => ("account_erasure_step_unavailable", String::new()),
            Refused::Storage(_) => ("current_source_unavailable", String::new()),
        }
    }
}

fn row_id(account: &str) -> String {
    format!("{}{account}", settings().row_prefix)
}

/// The account's kept deletion, if one was begun.
pub(crate) fn kept(store: &Store<'_>, account: &str) -> rows::Result<Option<Row<Deletion>>> {
    store.get(Family::Lists, &row_id(account))
}

/// Whether a deletion of the account is kept and not complete: nothing else of the account answers then (invariant 3).
pub(crate) fn deleting(store: &Store<'_>, account: &str) -> rows::Result<bool> {
    Ok(kept(store, account)?.is_some_and(|row| row.value.erased_at.is_none()))
}

/// Begin the account's deletion, or answer the one kept (invariant 1, old :278-333 `beginAccountErasure`).
pub(crate) fn begin(store: &Store<'_>, account: &str, now: u64) -> Result<Row<Deletion>, Refused> {
    for _ in 0..4 {
        if let Some(row) = kept(store, account)? {
            if row.value.erased_at.is_some() {
                return Err(crate::cause!(Refused::Complete));
            }
            return Ok(row);
        }
        let first = settings().steps.first().cloned().unwrap_or_default();
        let row = Row {
            id: row_id(account),
            account: account.to_string(),
            expires_at: 0,
            value: Deletion {
                began_at: now,
                step: first,
                cursor: String::new(),
                erased: BTreeMap::new(),
                erased_at: None,
                continuation: Continuation { state: "pending".into(), ..Continuation::default() },
            },
        };
        if store.insert(Family::Lists, &row).is_ok() {
            return Ok(row);
        }
    }
    Err(crate::cause!(Refused::Storage))
}

/// Where a deletion stands after one call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Progress {
    /// Every step is done: the account is erased.
    Complete { erased_at: u64 },
    /// Pages were taken; more are left.
    Going { step: String },
    /// It may not go on before `due_at` (a failure's or a stall's wait).
    Waiting { due_at: u64, state: String },
    /// A page failed now; its failure is kept and it waits.
    Failed { step: String, due_at: u64 },
}

/// The steps one call drives, by name; the account-rows step is this file's own (`account_rows_page`).
pub(crate) struct Steps<'a> {
    pub given: Vec<(&'static str, &'a mut dyn Step)>,
}

/// One call's work on the account's kept deletion (old :204-259 `continueAccountErasure`): at most `pages_per_call`
/// pages of the steps before the account-rows step, none after `until`, each kept before the next. `current` is asked
/// before every page of a step other than the account-rows step (which removes the account's computers rows, the rows
/// that say where the account is answered).
pub(crate) fn advance(store: &Store<'_>, account: &str, steps: &mut Steps<'_>, until: Instant, current: &dyn Fn() -> bool)
    -> Result<Progress, Refused> {
    let rules = settings();
    // The account-rows step's pages are not counted: once it has begun, the account's computers rows may be gone at the
    // next call, so no computer answers it then; it runs to its end in this one (each page still bounded, and none after
    // `until`).
    let mut taken = 0;
    loop {
        let before = kept(store, account)?.ok_or(crate::cause!(Refused::NotBegun))?;
        let deletion = &before.value;
        if let Some(erased_at) = deletion.erased_at {
            return Ok(Progress::Complete { erased_at });
        }
        let now = now_ms();
        if deletion.continuation.due_at > now {
            return Ok(Progress::Waiting { due_at: deletion.continuation.due_at, state: deletion.continuation.state.clone() });
        }
        if Instant::now() >= until {
            return Ok(Progress::Going { step: deletion.step.clone() });
        }
        let step = deletion.step.clone();
        if step != ACCOUNT_ROWS {
            if taken == rules.pages_per_call {
                return Ok(Progress::Going { step });
            }
            taken += 1;
        }
        let page = if step == ACCOUNT_ROWS {
            account_rows_page(store, account)
        } else {
            if !current() {
                return Err(crate::cause!(Refused::NotCurrent));
            }
            let given = steps.given.iter_mut().find(|(name, _)| *name == step).ok_or_else(|| Refused::StepMissing(step.clone(), crate::cause!()))?;
            given.1.page(&deletion.cursor)
        };
        let mut after = before.clone();
        let failed = match page {
            Ok(page) => {
                moved(&mut after.value, &page, now);
                None
            }
            Err(failure) => {
                failed(&mut after.value, &step, &failure, now);
                Some(after.value.continuation.due_at)
            }
        };
        if !store.replace_if(Family::Lists, &before, &after)? {
            // Another call took this page first: it is read again.
            continue;
        }
        if let Some(due_at) = failed {
            return Ok(Progress::Failed { step, due_at });
        }
        if let Some(erased_at) = after.value.erased_at {
            return Ok(Progress::Complete { erased_at });
        }
        if after.value.continuation.due_at > now {
            return Ok(Progress::Waiting { due_at: after.value.continuation.due_at, state: after.value.continuation.state.clone() });
        }
    }
}

/// A page that moved: its count kept, its cursor or the next step taken, the failures reset; a page that moved nothing
/// (no row, the same cursor) counts toward a stall (old :136-148).
fn moved(deletion: &mut Deletion, page: &Page, now: u64) {
    let rules = settings();
    *deletion.erased.entry(deletion.step.clone()).or_default() += page.erased;
    let still = page.erased == 0 && page.next.as_deref() == Some(deletion.cursor.as_str());
    let stalled = if still { deletion.continuation.stalled + 1 } else { 0 };
    match &page.next {
        Some(next) => deletion.cursor = next.clone(),
        None => {
            let at = rules.steps.iter().position(|step| *step == deletion.step).unwrap_or(rules.steps.len());
            match rules.steps.get(at + 1) {
                Some(next) => deletion.step = next.clone(),
                None => deletion.erased_at = Some(now),
            }
            deletion.cursor = String::new();
        }
    }
    let wait = if stalled >= rules.stall_after {
        let growth = rules.repeat_growth.saturating_pow(stalled - rules.stall_after + 1);
        rules.failure_delays_ms[0].saturating_mul(growth).min(rules.longest_stall_delay_ms)
    } else {
        0
    };
    deletion.continuation = Continuation {
        state: if wait > 0 { "stalled".into() } else { "pending".into() },
        due_at: if wait > 0 { now.saturating_add(wait) } else { 0 },
        stalled,
        ..Continuation::default()
    };
}

/// A failed page kept (old :150-171): its reason, and when it may be tried again.
fn failed(deletion: &mut Deletion, step: &str, failure: &StepFailure, now: u64) {
    let rules = settings();
    let said = Failure { cause: failure.cause.clone(), step: step.to_string(), shape: failure_shape(&failure.words), transient: failure.transient };
    let prior = &deletion.continuation;
    let same = prior.last_failure.as_ref().is_some_and(|last| last.step == said.step && last.shape == said.shape);
    deletion.continuation = if failure.transient {
        let transient = prior.transient_failures + 1;
        let wait = rules.transient_delays_ms[(transient as usize - 1).min(rules.transient_delays_ms.len() - 1)];
        Continuation {
            state: if prior.state == "recovery-required" { prior.state.clone() } else { "retry".into() },
            due_at: now.saturating_add(wait),
            transient_failures: transient,
            last_failure: Some(said),
            ..prior.clone()
        }
    } else {
        let failures = (prior.failures + 1).min(rules.maximum_consecutive_failures);
        let repeats = if same { prior.repeats + 1 } else { 0 };
        let beyond = if same && prior.failures >= rules.maximum_consecutive_failures { prior.beyond_bound + 1 } else { 0 };
        let base = rules.failure_delays_ms[(failures as usize - 1).min(rules.failure_delays_ms.len() - 1)];
        let wait = base.saturating_mul(rules.repeat_growth.saturating_pow(beyond)).min(rules.longest_repeat_delay_ms);
        Continuation {
            state: if failures >= rules.maximum_consecutive_failures { "recovery-required".into() } else { "retry".into() },
            due_at: now.saturating_add(wait),
            failures,
            repeats,
            beyond_bound: beyond,
            transient_failures: 0,
            stalled: 0,
            first_failed_at: if same { prior.first_failed_at.or(Some(now)) } else { Some(now) },
            last_failure: Some(said),
        }
    };
}

/// The deletion's next try is due now, whatever it waited for; its failures, cursor and step are kept (old :182-191
/// `redriveAccountErasure`). Answers whether anything changed.
pub(crate) fn redrive(store: &Store<'_>, account: &str) -> Result<bool, Refused> {
    let before = kept(store, account)?.ok_or(crate::cause!(Refused::NotBegun))?;
    if before.value.erased_at.is_some() {
        return Err(crate::cause!(Refused::Complete));
    }
    if before.value.continuation.due_at <= now_ms() {
        return Ok(false);
    }
    let mut after = before.clone();
    after.value.continuation.due_at = 0;
    Ok(store.replace_if(Family::Lists, &before, &after)?)
}

/// Where the account's deletion stands (old :78-105 `accountErasureState`): times, counts, the step and its failure's
/// step and shape, never an identifier.
pub(crate) fn state(store: &Store<'_>, account: &str) -> rows::Result<Value> {
    let Some(row) = kept(store, account)? else { return Ok(json!({"deletion_kept": false})) };
    let deletion = row.value;
    let continuation = &deletion.continuation;
    Ok(json!({
        "deletion_kept": true,
        "terminal": deletion.erased_at.is_some(),
        "deleting_since": deletion.began_at,
        "erased_at": deletion.erased_at,
        "step": deletion.erased_at.is_none().then_some(deletion.step),
        "erased": deletion.erased,
        "continuation": {
            "state": continuation.state, "due_at": continuation.due_at, "failures": continuation.failures,
            "repeats": continuation.repeats, "beyond_bound": continuation.beyond_bound,
            "transient_failures": continuation.transient_failures, "stalled": continuation.stalled,
            "first_failed_at": continuation.first_failed_at, "last_failure": continuation.last_failure.as_ref().map(|failure| json!({
                "step": failure.step, "shape": failure_shape(&failure.shape), "transient": failure.transient,
            })),
        },
    }))
}

/// A failure's words with every identifier taken out (quoted text, addresses, links, ids, long hex, numbers), so the kept
/// reason says what failed without naming the account or its data (old :20-22 `deletionFailureShape`).
pub(crate) fn failure_shape(words: &str) -> String {
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r#"'[^']*'|"[^"]*"|`[^`]*`"#,
            r"\S+@\S+",
            r"(?i)\b[a-z][a-z0-9+.-]*://\S+",
            r"(?i)\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b",
            r"(?i)\b[0-9a-f]{8,}\b",
            r"\b\d+(?:\.\d+)?\b",
        ]
        .iter()
        .map(|pattern| regex::Regex::new(pattern).expect("a failure shape pattern"))
        .collect()
    });
    let mut text = words.to_string();
    for pattern in patterns {
        text = pattern.replace_all(&text, "?").into_owned();
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(settings().shape_chars).collect()
}

/// One page of the account-rows step (invariant 4): up to `rows_per_page` rows of the first family (`Family::ALL`) that
/// still holds rows of the account, removed through the account's own rows (`Store::remove`); the kept deletion row stays.
fn account_rows_page(store: &Store<'_>, account: &str) -> Result<Page, StepFailure> {
    let unavailable = |error: rows::Error| StepFailure { cause: error.cause().into(), words: "the account's rows did not answer".into(), transient: true };
    let keep = row_id(account);
    for family in Family::ALL {
        let ids = store.ids_of(family, account, settings().rows_per_page + 1).map_err(unavailable)?;
        let ids: Vec<String> = ids.into_iter().filter(|id| !(family == Family::Lists && *id == keep)).collect();
        if ids.is_empty() {
            continue;
        }
        let mut erased = 0;
        for id in ids.iter().take(settings().rows_per_page) {
            if store.remove(family, id).map_err(unavailable)? {
                erased += 1;
            }
        }
        return Ok(Page { erased, next: Some(family.name().to_string()) });
    }
    Ok(Page { erased: 0, next: None })
}

/// The tool-runs step: every tool run the account holds, one page after the cursor at a time, erased by the function
/// it is made of (the shipped tools' `erase_runs_page` on the account's state folder, src/tool_runs/tools/erasure.rs).
pub(crate) struct ToolRunsStep<F>(pub F);

impl<F> Step for ToolRunsStep<F>
where
    F: FnMut(&str) -> Result<crate::tool_runs::tools::erasure::Erased, crate::tool_runs::tools::Failure>,
{
    fn page(&mut self, cursor: &str) -> Result<Page, StepFailure> {
        use crate::tool_runs::tools::Failure as RunFailure;
        let page = (self.0)(cursor).map_err(|failure| StepFailure { cause: failure.cause().into(),
            words: failure.code().to_string(),
            transient: matches!(failure, RunFailure::Busy(_) | RunFailure::Unavailable(_)),
        })?;
        Ok(Page { erased: page.erased as u64, next: page.next })
    }
}

/// Where the files step is (`FilesStep`), kept as the step's cursor.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FilesCursor {
    /// `forget-set-aside`, `live`, `queue` or `release` (empty: the first).
    phase: String,
    /// The name or folder being carried or forgotten, and where its walk resumes.
    name: Option<String>,
    after: Option<String>,
}

/// The files step: every name of the account's files set aside and forgotten for good, so each file is noted for the
/// byte release, then the release run until no byte is left (the account files' own functions: `names.rs`
/// `carry_names`, `forget_set_aside`, `release.rs` `queue_release`, `release_gone_bytes`; old src/person-store.mjs
/// `deleteEverything`, whose files went the same way).
pub(crate) fn files_page<S: Storage + Send>(files: &mut AccountFiles<S>, cursor: &str) -> Result<Page, StepFailure> {
    let failed = |error: crate::account_files::AccountFilesError| StepFailure { cause: error.cause().into(), words: error.to_string(), transient: false };
    let mut at: FilesCursor = if cursor.is_empty() { FilesCursor::default() } else {
        serde_json::from_str(cursor).map_err(|_| StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: "the files cursor is unreadable".into(), transient: false })?
    };
    let limit = Some(settings().rows_per_page);
    let first_of = |listed: Value| -> Option<String> {
        listed["names"].as_array().and_then(|names| names.first()).and_then(|name| name["name"].as_str()).map(str::to_owned)
            .or_else(|| listed["folders"].as_array().and_then(|folders| folders.first()).and_then(Value::as_str).map(str::to_owned))
    };
    let next = |at: &FilesCursor| Some(serde_json::to_string(at).unwrap_or_default());
    match at.phase.as_str() {
        // Names set aside before the deletion are forgotten first, so carrying a live name there meets none.
        "" | "forget-set-aside" => {
            let name = match at.name.clone() {
                Some(name) => Some(name),
                None => first_of(files.call("list_set_aside", &json!({"folder": "/", "limit": 1})).unwrap_or(Ok(Value::Null)).map_err(failed)?),
            };
            let Some(name) = name else {
                return Ok(Page { erased: 0, next: next(&FilesCursor { phase: "live".into(), ..FilesCursor::default() }) });
            };
            let done = match files.forget_set_aside(&name, at.after.as_deref(), limit) {
                Ok(done) => done,
                // Forgotten already (a stop after its last step, before this cursor was kept): the next one.
                Err(crate::account_files::AccountFilesError::NotFound(_)) => json!({"names": 0, "next_after": null}),
                Err(error) => return Err(failed(error)),
            };
            let erased = done["names"].as_u64().unwrap_or(0);
            at = match done["next_after"].as_str() {
                Some(after) => FilesCursor { phase: "forget-set-aside".into(), name: Some(name), after: Some(after.to_owned()) },
                None => FilesCursor { phase: "forget-set-aside".into(), ..FilesCursor::default() },
            };
            Ok(Page { erased, next: next(&at) })
        }
        // Each live name or folder is set aside, then forgotten in the same walk as above.
        "live" => {
            let name = match at.name.clone() {
                Some(name) => Some(name),
                None => first_of(files.list_files(Some("/"), None, Some(1)).map_err(failed)?),
            };
            let Some(name) = name else {
                return Ok(Page { erased: 0, next: next(&FilesCursor { phase: "queue".into(), ..FilesCursor::default() }) });
            };
            let carried = match files.carry_names(Carry { source: &LIVE, from: &name, target: &SET_ASIDE, to: &name, kept: false }, at.after.as_deref(), limit) {
                Ok(carried) => carried,
                // Carried already (a stop after its last step): it is forgotten next.
                Err(crate::account_files::AccountFilesError::NotFound(_)) => json!({"next_after": null}),
                Err(error) => return Err(failed(error)),
            };
            at = match carried["next_after"].as_str() {
                Some(after) => FilesCursor { phase: "live".into(), name: Some(name), after: Some(after.to_owned()) },
                None => FilesCursor { phase: "forget-set-aside".into(), name: Some(name), after: None },
            };
            Ok(Page { erased: 0, next: next(&at) })
        }
        "queue" => {
            let queued = files.queue_release(limit).map_err(failed)?;
            let erased = queued["files"].as_u64().unwrap_or(0);
            let phase = if queued["more"].as_bool() == Some(true) { "queue" } else { "release" };
            Ok(Page { erased, next: next(&FilesCursor { phase: phase.into(), ..FilesCursor::default() }) })
        }
        "release" => {
            let released = files.release_gone_bytes(limit).map_err(failed)?;
            if let Some(why) = released["failed"].as_str() {
                return Err(StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: why.to_owned(), transient: true });
            }
            if files.release_pending().map_err(failed)? {
                return Ok(Page { erased: released["released"].as_u64().unwrap_or(0), next: Some(cursor.to_owned()) });
            }
            Ok(Page { erased: released["released"].as_u64().unwrap_or(0), next: None })
        }
        _ => Err(StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: "the files cursor names no phase".into(), transient: false }),
    }
}

/// Where the records step is: the index of the resource in `settings.json` `records`, and the last id erased there.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordsCursor {
    resource: usize,
    after: String,
}

/// One page of the records step: the account's own records in the record store, each erased through the record store's
/// own destruction (`RecordStore::erase`: unreachable at once, removed when the undo window ends), one resource of
/// `settings.json` `records` after another (old src/person-store.mjs `deleteEverything`, the store emptied a bounded
/// slice per call).
pub(crate) fn records_page<S: Storage + Send>(store: &mut RecordStore<S>, account: &str, cursor: &str) -> Result<Page, StepFailure> {
    let failed = |error: crate::records::Error| StepFailure { cause: error.cause().into(), words: error.to_string(), transient: matches!(error, crate::records::Error::Unavailable(_)) };
    let mut at: RecordsCursor = if cursor.is_empty() { RecordsCursor::default() } else {
        serde_json::from_str(cursor).map_err(|_| StepFailure { cause: crate::cause!(account_erasure step_failure).into(), words: "the records cursor is unreadable".into(), transient: false })?
    };
    let resources = &settings().records;
    let Some(resource) = resources.get(at.resource) else { return Ok(Page { erased: 0, next: None }) };
    let page = store.list_page(account, resource, &at.after, settings().rows_per_page).map_err(failed)?;
    let mut erased = 0;
    for record in &page.items {
        if store.erase(account, resource, &record.id).map_err(failed)?.is_some() {
            erased += 1;
        }
    }
    at = match page.next {
        Some(after) => RecordsCursor { resource: at.resource, after },
        None if at.resource + 1 < resources.len() => RecordsCursor { resource: at.resource + 1, after: String::new() },
        None => return Ok(Page { erased, next: None }),
    };
    Ok(Page { erased, next: Some(serde_json::to_string(&at).unwrap_or_default()) })
}

/// The answer a call of the account's delete gives for `progress`.
pub(crate) fn answer(progress: &Progress) -> Value {
    let words = words();
    match progress {
        Progress::Complete { erased_at } => json!({"complete": true, "erased_at": erased_at, "said": words.deleted}),
        Progress::Going { step } => json!({"complete": false, "step": step, "said": words.being_deleted}),
        Progress::Waiting { due_at, state } => json!({"complete": false, "state": state, "due_at": due_at,
            "said": words.waits.replace("{at}", &due_at.to_string())}),
        Progress::Failed { step, due_at } => json!({"complete": false, "failed_step": step, "due_at": due_at,
            "said": words.waits.replace("{at}", &due_at.to_string())}),
    }
}

#[cfg(test)]
#[path = "erase_tests.rs"]
mod tests;
