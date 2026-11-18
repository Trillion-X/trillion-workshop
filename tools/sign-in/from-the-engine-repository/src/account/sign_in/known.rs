//! Which of an account's passkeys are known (may confirm a guarded change), and which changes to the ways in need a
//! known passkey's confirmation. Ported from old trillion src/passkey-authority.mjs; it sits beside `passkeys.rs`
//! (where a passkey is saved and used) and `ways.rs` `may_change` (which session may change ways at all).
//!
//! A passkey's user-verification flag is self-reported and no attestation is asked for, and a fresh sign-in is
//! something an AI can hold (an emailed code it read, a passkey link it made), so the wall is custody of enrollment:
//! every passkey row carries its provenance (`Authority`), fixed when it is saved (old :1-8).
//!
//! Non-negotiable invariants (old :10-31):
//! 1. The wait is the computer's DATA (`settings.json` `authority`), never an account's row. A change to the ways in
//!    (removing a way, replacing a held way, ending another browser) is held while anything waits, and on an account
//!    with a known passkey needs that passkey's confirmation for exactly that change. Notices are bounded per window.
//! 2. A passkey is known only from `authority.from`, fixed when it is saved: at once for the sign-up passkey; after the
//!    notice wait for one a known passkey vouched for, and for one added without a confirmation only on an account with
//!    no known passkey (or while a recovery waits); never for one added without a confirmation to an account that has
//!    a known passkey (unvouched). A row with no provenance (saved before provenance existed) is classified once, as
//!    unvouched beside a known passkey, else as waiting out the notice from when it is classified, and told.
//! 3. Any use of a known passkey cancels everything waiting that no known passkey confirmed: such waiting passkeys
//!    become unvouched, a waiting recovery ends.
//! 4. A recovery that has run its wait unknows every passkey known before it started; nothing else unknows one.
//! 5. Signing in or confirming rewrites a passkey's row with the same provenance; only saving it, a vouch or invariant
//!    3 sets it.
//!
//! 6. A change that destroys the account (deleting it, src/account/erase.rs), on an account with no known passkey,
//!    waits out the notice wait: the first ask starts it and is told; the same change asked again once it has passed
//!    goes ahead; a known passkey's use (invariant 3) or a cancel ends the wait (old :176-195 `delayedChange`,
//!    `cancelDelayed`). It is kept in the account's authority row (`AuthorityRow::delayed`).
//!
//! Dropped from the old file, and why:
//! - moving an account away (old invariant 6's `account/move`): trillion-local's sign-in has no operation for it;
//! - the sign-up evidence of `legacyAuthority` (old :89-97 `signUp`) and the operator's one-time migration it fed: no
//!   sign-up record exists here, and no guard read it at run time even there;
//! - telling the person on every channel and by mail (old :228-233 `tellAuthorityNotice`): trillion-local has no channel to
//!   tell a person by. Every notice is kept, with its words, in the account's authority row (`AuthorityRow::notices`,
//!   which also bounds them as old :197-204 `takeNoticeRoom` did) and answered by `sign-in:passkeys`, for the tool
//!   that tells the person;
//! - a confirmation carried into the add-a-passkey ceremony (old src/account-routes.mjs:596 `vouched`): a known passkey
//!   vouches for the new one afterwards (`vouch`), which gives it the same provenance and wait;
//! - the operator's passkey link for another account (`passkeys/link-for`, `linkForNotice`): no operator account exists;
//! - ceiling, billing and account confirm words (`cap`, `paid-ceiling`, `account/*`): product features.
//!
//! Stored values, owned by this file:
//! - lists: `AuthorityRow` = `{recovery, notices}`, id `ROW_PREFIX` + the account's user id;
//! - passkeys: the `authority` of each `Passkey` (`passkeys.rs`).

use super::passkeys::Passkey;
use super::store::{Family, Row, Store};
use super::{now_ms, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The start of the account's authority row's id; the account's user id follows (old :41 `recoveryKey`).
pub(crate) const ROW_PREFIX: &str = "passkey-recovery:";
/// The step a refusal names when it wants a known passkey's confirmation (old src/passkey-authority.json
/// `step_needed`): a caller runs `sign-in:confirm-change` for the exact change and sends the same request again.
pub(crate) const STEP_NEEDED: &str = "passkey-confirmation";
const HOUR_MS: u64 = 3_600_000;

/// How a passkey was added (old src/passkey-authority.json `provenance`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Provenance {
    SignUp,
    KnownPasskey,
    Notice,
    Unvouched,
}

/// A passkey's provenance (old :68-74 `authorityFor`): how, when, and from when it is known (`None`: never).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Authority {
    pub by: Provenance,
    pub at: u64,
    pub from: Option<u64>,
    /// What a known passkey's use cancelled (invariant 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<Provenance>,
    /// Classified once because it was saved before provenance existed (old :89-97 `legacyAuthority`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub classified: bool,
}

/// One provenance's settings.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct ProvenanceSettings {
    pub gains_authority: bool,
    pub wait_hours: u64,
}

/// `settings.json` `authority`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct AuthoritySettings {
    pub provenance: BTreeMap<Provenance, ProvenanceSettings>,
    pub notice_most: usize,
    pub notice_window_hours: u64,
}

impl AuthoritySettings {
    pub(crate) fn valid(&self) -> bool {
        [Provenance::SignUp, Provenance::KnownPasskey, Provenance::Notice, Provenance::Unvouched].iter().all(|by| self.provenance.contains_key(by))
            && self.provenance.values().all(|row| row.wait_hours <= 24 * 400)
            && (1..=100).contains(&self.notice_most) && (1..=24 * 30).contains(&self.notice_window_hours)
    }

    fn wait_ms(&self, by: Provenance) -> u64 {
        self.provenance.get(&by).map_or(0, |row| row.wait_hours.saturating_mul(HOUR_MS))
    }
}

fn authority_settings() -> &'static AuthoritySettings {
    &super::settings().authority
}

/// The words the sign-in's own operations answer with (the account's words row, `operations`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OperationWords {
    #[serde(rename = "_what", default, skip_serializing_if = "String::is_empty")]
    _what: String,
    pub too_many_calls: String,
    pub not_known_yet: String,
    pub never_known: String,
    pub needs_known_passkey: String,
    pub held_while_waiting: String,
    pub too_many_notices: String,
    pub added_title: String,
    pub added_body: String,
    pub added_vouched_body: String,
    pub added_unvouched_body: String,
    pub recovery_title: String,
    pub recovery_body: String,
    pub recovery_started: String,
    pub recovery_cancelled: String,
    pub recovery_not_needed: String,
    pub vouched: String,
    pub already_known: String,
    pub not_a_change: String,
    pub confirmed_title: String,
    pub confirmed_body: String,
    pub legacy_title: String,
    pub legacy_unvouched_body: String,
    pub legacy_waits_body: String,
    pub delayed_title: String,
    pub delayed_body: String,
    pub delayed_started: String,
    pub delayed_waiting: String,
    pub delayed_other: String,
    pub delayed_cancelled: String,
    /// What a confirmation is for, one row per change a confirmation may be for (old `confirm_words`).
    pub confirm_words: BTreeMap<String, String>,
}

/// The account's operation words, from its words row (`words_row.rs`); `Error::WordsMissing` when it has none.
pub(crate) fn words(store: &Store<'_>, account: &str) -> Result<OperationWords> {
    super::words_row::current(store, account)?.map(|words| words.operations).ok_or(crate::cause!(super::Error::WordsMissing))
}

/// `template` with each `{name}` of `values` filled in (old :39 `said`).
pub(crate) fn said(template: &str, values: &[(&str, &str)]) -> String {
    values.iter().fold(template.to_string(), |text, (name, value)| text.replace(&format!("{{{name}}}"), value))
}

/// A time as the notices say it, in UTC (old :40 `when`).
fn when(ms: u64) -> String {
    let seconds = i64::try_from(ms / 1000).unwrap_or(i64::MAX);
    chrono::DateTime::from_timestamp(seconds, 0).map_or_else(String::new, |at| at.format("%a, %d %b %Y %H:%M:%S GMT").to_string())
}

/// A recovery: started at, and from when it unknows the passkeys known before it started.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Recovery {
    pub started_at: u64,
    pub from: u64,
}

/// One notice the person is to be told (old `{ key, title, body }`), and whether it took room in the window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Notice {
    pub at: u64,
    pub title: String,
    pub body: String,
    pub counted: bool,
}

/// The account's authority row: its recovery, and the notices of the last window.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct AuthorityRow {
    pub recovery: Option<Recovery>,
    pub notices: Vec<Notice>,
    /// A change that destroys the account, waiting out its notice (invariant 6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delayed: Option<Delayed>,
}

/// A delayed change (old :184 `{ change, started_at, from }`): the change's key, when it was first asked, and from
/// when asking it again lets it go ahead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Delayed {
    pub change: String,
    pub started_at: u64,
    pub from: u64,
}

/// What asking a delayed change answers (old :179-189 `delayedChange`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Delay {
    /// The same change, asked again once its wait has passed: it goes ahead now, and the wait is ended.
    GoAhead,
    /// The wait was started now and the person told: the words say until when.
    Started(String),
}

fn row_id(account: &str) -> String {
    format!("{ROW_PREFIX}{account}")
}

/// Why a guarded step was refused.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// Something waits (a passkey, a recovery), so no way in may change now (invariant 1; 409).
    HeldWhileWaiting(crate::refusal_cause::Cause),
    /// The change needs a known passkey's confirmation bound to it (403, `STEP_NEEDED`).
    NeedsKnownPasskey(crate::refusal_cause::Cause),
    /// The confirming passkey is not known: its words say until when, or that it never is.
    NotKnown(String, crate::refusal_cause::Cause),
    /// Not a change a confirmation may be for.
    NotAChange(crate::refusal_cause::Cause),
    /// No such passkey on this account.
    NoPasskey(crate::refusal_cause::Cause),
    /// Too many notices in the window (429).
    TooManyNotices(crate::refusal_cause::Cause),
    /// The confirmation's ceremony failed its checks.
    PasskeyRefused(crate::refusal_cause::Cause),
    /// A delayed change waits (invariant 6; 409): its words say until when, or that another change waits.
    Delayed(String, crate::refusal_cause::Cause),
    /// The account has no words row (`words_row::MISSING`): nothing worded is told or answered.
    WordsMissing(crate::refusal_cause::Cause),
    Storage(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::HeldWhileWaiting(cause) => cause.clone(),
            Self::NeedsKnownPasskey(cause) => cause.clone(),
            Self::NotKnown(_, cause) => cause.clone(),
            Self::NotAChange(cause) => cause.clone(),
            Self::NoPasskey(cause) => cause.clone(),
            Self::TooManyNotices(cause) => cause.clone(),
            Self::PasskeyRefused(cause) => cause.clone(),
            Self::Delayed(_, cause) => cause.clone(),
            Self::WordsMissing(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refused);

impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::HeldWhileWaiting(_), Self::HeldWhileWaiting(_)) => true,
            (Self::NeedsKnownPasskey(_), Self::NeedsKnownPasskey(_)) => true,
            (Self::NotKnown(left, _), Self::NotKnown(right, _)) => left == right,
            (Self::NotAChange(_), Self::NotAChange(_)) => true,
            (Self::NoPasskey(_), Self::NoPasskey(_)) => true,
            (Self::TooManyNotices(_), Self::TooManyNotices(_)) => true,
            (Self::PasskeyRefused(_), Self::PasskeyRefused(_)) => true,
            (Self::Delayed(left, _), Self::Delayed(right, _)) => left == right,
            (Self::WordsMissing(_), Self::WordsMissing(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


impl From<super::Error> for Refused {
    fn from(error: super::Error) -> Self {
        let cause = error.cause();
        match error {
            super::Error::PasskeyRefused(_) => Refused::PasskeyRefused(cause),
            super::Error::WordsMissing(_) => Refused::WordsMissing(cause),
            _ => Refused::Storage(cause),
        }
    }
}

impl Refused {
    /// The refusal code the account routes answer and its words: the account's (`words`), or the code alone when it
    /// has no words row.
    pub(crate) fn code_and_words(&self, words: Option<&OperationWords>) -> (&'static str, String) {
        let said = |pick: fn(&OperationWords) -> &String| words.map(|words| pick(words).clone()).unwrap_or_default();
        match self {
            Refused::HeldWhileWaiting(_) => ("sign_in_held_while_waiting", said(|words| &words.held_while_waiting)),
            Refused::NeedsKnownPasskey(_) => ("sign_in_needs_known_passkey", said(|words| &words.needs_known_passkey)),
            Refused::NotKnown(said, _) => ("sign_in_passkey_not_known", said.clone()),
            Refused::NotAChange(_) => ("original_input_refused", said(|words| &words.not_a_change)),
            Refused::NoPasskey(_) => ("original_input_refused", String::new()),
            Refused::TooManyNotices(_) => ("sign_in_too_many_notices", said(|words| &words.too_many_notices)),
            Refused::PasskeyRefused(_) => ("sign_in_passkey_refused", String::new()),
            Refused::Delayed(said, _) => ("sign_in_change_waits", said.clone()),
            Refused::WordsMissing(_) => (super::words_row::MISSING, String::new()),
            Refused::Storage(_) => ("current_source_unavailable", String::new()),
        }
    }
}

/// How a passkey being saved was added (old :62-66 `provenanceOf`, without `vouched`, see the module notes).
pub(crate) fn provenance_of(sign_up: bool, known: bool, recovering: bool) -> Provenance {
    if sign_up {
        Provenance::SignUp
    } else if !known || recovering {
        Provenance::Notice
    } else {
        Provenance::Unvouched
    }
}

/// The provenance a passkey row carries (old :70-74 `authorityFor`). `not_before` holds a notice-route passkey back
/// until a waiting recovery ends.
pub(crate) fn authority_for(by: Provenance, now: u64, not_before: u64) -> Authority {
    let settings = authority_settings();
    let gains = settings.provenance.get(&by).is_some_and(|row| row.gains_authority);
    Authority { by, at: now, from: gains.then(|| now.saturating_add(settings.wait_ms(by)).max(not_before)), cancelled: None, classified: false }
}

/// When a passkey is known from, or `None` when it never is (old :78-81 `authorityFrom`); a row with no provenance is
/// never known until it is classified.
pub(crate) fn authority_from(passkey: &Passkey) -> Option<u64> {
    passkey.authority.as_ref().and_then(|authority| authority.from)
}

/// Whether a passkey is known now; a recovery that ran its wait unknows those known before it started (old :126-130).
pub(crate) fn has_authority(passkey: &Passkey, now: u64, recovery: Option<&Recovery>) -> bool {
    let Some(from) = authority_from(passkey) else { return false };
    if from > now {
        return false;
    }
    !recovery.is_some_and(|recovery| recovery.from <= now && from <= recovery.started_at)
}

/// The account's passkeys as authority sees them (old :135-146 `authorityState`).
#[derive(Clone, Debug)]
pub(crate) struct State {
    pub passkeys: Vec<Row<Passkey>>,
    /// The ids of the passkeys known now.
    pub known: Vec<String>,
    /// The ids of the passkeys that will be known after their wait.
    pub waiting: Vec<String>,
    /// A recovery still waiting.
    pub recovery: Option<Recovery>,
    /// A recovery that ran its wait.
    pub recovered: Option<Recovery>,
    pub notices: Vec<Notice>,
}

/// Most passkeys one account's state reads.
const MOST_PASSKEYS: usize = 1000;

fn read_row(store: &Store<'_>, account: &str) -> Result<Option<Row<AuthorityRow>>> {
    store.get(Family::Lists, &row_id(account))
}

/// Change the account's authority row by `change`, compared and set on the row read, again on a newer row. `change`
/// answers whether to write.
fn change_row(store: &Store<'_>, account: &str, mut change: impl FnMut(&mut AuthorityRow) -> bool) -> Result<AuthorityRow> {
    for _ in 0..8 {
        let before = read_row(store, account)?;
        let mut value = before.as_ref().map(|row| row.value.clone()).unwrap_or_default();
        if !change(&mut value) {
            return Ok(value);
        }
        let after = Row { id: row_id(account), account: account.to_string(), expires_at: 0, value: value.clone() };
        let written = match &before {
            Some(before) => store.replace_if(Family::Lists, before, &after)?,
            None => store.insert(Family::Lists, &after).is_ok(),
        };
        if written {
            return Ok(value);
        }
    }
    Err(crate::cause!(super::Error::Storage))
}

/// Drop notices older than the window; whether the window has room for one more counted notice.
fn prune(row: &mut AuthorityRow, now: u64) -> bool {
    let settings = authority_settings();
    let window = settings.notice_window_hours.saturating_mul(HOUR_MS);
    row.notices.retain(|notice| now.saturating_sub(notice.at) < window);
    row.notices.iter().filter(|notice| notice.counted).count() < settings.notice_most
}

/// Keep `notice` for the person when the window has room (old :197-204 `takeNoticeRoom`); false when it has none.
pub(crate) fn take_notice_room(store: &Store<'_>, account: &str, now: u64, title: &str, body: &str) -> Result<bool> {
    let mut room = false;
    change_row(store, account, |row| {
        room = prune(row, now);
        if room {
            row.notices.push(Notice { at: now, title: title.to_string(), body: body.to_string(), counted: true });
        }
        room
    })?;
    Ok(room)
}

/// Keep a notice that takes no room (a classification, a confirmation: old :120-121 and :222-226 told those beside
/// the window).
fn tell(store: &Store<'_>, account: &str, now: u64, title: &str, body: &str) -> Result<()> {
    change_row(store, account, |row| {
        prune(row, now);
        row.notices.push(Notice { at: now, title: title.to_string(), body: body.to_string(), counted: false });
        true
    })?;
    Ok(())
}

/// The account's passkeys as authority sees them now. Passkeys saved before provenance existed are classified first
/// (old :109-123 `classifyLegacy`): only their provenance is written, and the person is told.
pub(crate) fn state(store: &Store<'_>, account: &str, now: u64) -> Result<State> {
    let row = read_row(store, account)?.map(|row| row.value).unwrap_or_default();
    let mut passkeys: Vec<Row<Passkey>> = store.list(Family::Passkeys, account, MOST_PASSKEYS)?;
    if passkeys.iter().any(|row| row.value.authority.is_none()) {
        passkeys = classify_legacy(store, account, passkeys, row.recovery.as_ref(), now)?;
    }
    let recovery = row.recovery;
    let done = recovery.is_some_and(|recovery| recovery.from <= now);
    let known: Vec<String> = passkeys.iter().filter(|key| has_authority(&key.value, now, recovery.as_ref())).map(|key| key.id.clone()).collect();
    let waiting = passkeys.iter()
        .filter(|key| !known.contains(&key.id) && authority_from(&key.value).is_some_and(|from| from > now))
        .map(|key| key.id.clone()).collect();
    let notices = read_row(store, account)?.map(|row| row.value.notices).unwrap_or_default();
    Ok(State {
        passkeys,
        known,
        waiting,
        recovery: recovery.filter(|_| !done),
        recovered: recovery.filter(|_| done),
        notices,
    })
}

/// Classify the rows with no provenance (old :89-97 `legacyAuthority` with no sign-up evidence, see the module notes):
/// unvouched when the account keeps a known passkey, else waiting out the notice from `now`. Told once.
fn classify_legacy(store: &Store<'_>, account: &str, passkeys: Vec<Row<Passkey>>, recovery: Option<&Recovery>, now: u64)
    -> Result<Vec<Row<Passkey>>> {
    let known = passkeys.iter().any(|row| row.value.authority.is_some() && has_authority(&row.value, now, recovery));
    let by = if known { Provenance::Unvouched } else { Provenance::Notice };
    let mut kept = Vec::with_capacity(passkeys.len());
    let mut classified = 0usize;
    let mut from = None;
    for row in passkeys {
        if row.value.authority.is_some() {
            kept.push(row);
            continue;
        }
        let mut after = row.clone();
        after.value.authority = Some(Authority { classified: true, ..authority_for(by, now, 0) });
        if store.replace_if(Family::Passkeys, &row, &after)? {
            classified += 1;
            from = authority_from(&after.value);
            kept.push(after);
        } else if let Some(now_kept) = store.get::<Passkey>(Family::Passkeys, &row.id)? {
            // Another reader classified it first (or it signed in): keep what is stored.
            kept.push(now_kept);
        }
    }
    if classified > 0 {
        let words = words(store, account)?;
        let count = classified.to_string();
        let body = match from {
            Some(from) => said(&words.legacy_waits_body, &[("count", &count), ("from", &when(from))]),
            None => said(&words.legacy_unvouched_body, &[("count", &count)]),
        };
        tell(store, account, now, &words.legacy_title, &body)?;
    }
    Ok(kept)
}

/// Whether the account's next added passkey is known at once, waits, or never is, and from when (invariant 2).
pub(crate) fn for_new_passkey(store: &Store<'_>, account: &str, sign_up: bool, now: u64) -> Result<Authority> {
    if sign_up {
        return Ok(authority_for(Provenance::SignUp, now, 0));
    }
    let state = state(store, account, now)?;
    let by = provenance_of(false, !state.known.is_empty(), state.recovery.is_some());
    Ok(authority_for(by, now, state.recovery.map_or(0, |recovery| recovery.from)))
}

/// The notice for an added passkey (old :209-215 `addedNotice`); `None` for the sign-up passkey (old :207).
pub(crate) fn added_notice(words: &OperationWords, authority: &Authority) -> Option<(String, String)> {
    if authority.by == Provenance::SignUp {
        return None;
    }
    let body = match authority.from {
        None => words.added_unvouched_body.clone(),
        Some(from) if authority.by == Provenance::KnownPasskey => said(&words.added_vouched_body, &[("from", &when(from))]),
        Some(from) => said(&words.added_body, &[("from", &when(from))]),
    };
    Some((words.added_title.clone(), body))
}

/// What a cancel did (old :166-174 `cancelWaiting`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Cancelled {
    pub passkeys: Vec<String>,
    pub recovery: bool,
}

/// A known passkey of `account` was used (invariant 3): every waiting passkey no known passkey confirmed becomes
/// unvouched, and a waiting recovery ends.
pub(crate) fn cancel_waiting(store: &Store<'_>, account: &str, now: u64) -> Result<Cancelled> {
    let state = state(store, account, now)?;
    let mut cancelled = Cancelled::default();
    for row in state.passkeys.iter().filter(|row| state.waiting.contains(&row.id)) {
        let Some(authority) = row.value.authority.as_ref().filter(|authority| authority.by == Provenance::Notice) else { continue };
        let mut after = row.clone();
        after.value.authority = Some(Authority { cancelled: Some(authority.by), ..authority_for(Provenance::Unvouched, now, 0) });
        if store.replace_if(Family::Passkeys, row, &after)? {
            cancelled.passkeys.push(row.id.clone());
        }
    }
    // A known passkey's use also ends a delayed change waiting (old :172 `delete(delayedKey)`).
    change_row(store, account, |row| row.delayed.take().is_some())?;
    if state.recovery.is_some() {
        change_row(store, account, |row| {
            let waiting = row.recovery.is_some_and(|recovery| recovery.from > now);
            if waiting {
                row.recovery = None;
            }
            waiting
        })?;
        cancelled.recovery = true;
    }
    Ok(cancelled)
}

/// The refusal for a change to the ways in (old :239-243 `guardedChangeRefusal`), or `Ok` when it may go. `channel`
/// marks a change to the ways the person signs in or is told, which is held while anything waits; `confirmed` says
/// whether a known passkey confirmed exactly this change (`confirmed`). On an account with no known passkey nothing
/// only the person can do exists, so the change goes (the risk the old DATA stated).
pub(crate) fn guarded(state: &State, channel: bool, confirmed: bool) -> std::result::Result<(), Refused> {
    if channel && (!state.waiting.is_empty() || state.recovery.is_some()) {
        return Err(crate::cause!(Refused::HeldWhileWaiting));
    }
    if state.known.is_empty() || confirmed {
        return Ok(());
    }
    Err(crate::cause!(Refused::NeedsKnownPasskey))
}

/// Whether a way in of `account` may be removed or a held one replaced now (old src/account-routes.mjs:113-116
/// `wayInRefusal`): `guarded` with `channel`, read now.
pub(crate) fn way_change(store: &Store<'_>, account: &str, confirmed: bool) -> std::result::Result<(), Refused> {
    guarded(&state(store, account, now_ms())?, true, confirmed)
}

/// Removing passkey `id` (old :247-250 `removalRefusal`): a known passkey goes only with a known passkey's confirmation;
/// one that is not known (waiting: the cancel; unvouched) goes with the caller's sign-in alone.
pub(crate) fn removal(state: &State, id: &str, confirmed: bool) -> std::result::Result<(), Refused> {
    if !state.known.iter().any(|known| known == id) {
        return Ok(());
    }
    guarded(state, false, confirmed)
}

/// A change a confirmation may be for: `{action, ...}` with an action of `confirm_words` and text values only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Change(BTreeMap<String, String>);

impl Change {
    /// The change `value` names, when a confirmation may be for it.
    pub(crate) fn of(value: &Value, words: &OperationWords) -> std::result::Result<Change, Refused> {
        let object: &Map<String, Value> = value.as_object().ok_or(crate::cause!(Refused::NotAChange))?;
        let mut fields = BTreeMap::new();
        for (name, value) in object {
            fields.insert(name.clone(), value.as_str().ok_or(crate::cause!(Refused::NotAChange))?.to_string());
        }
        let action = fields.get("action").ok_or(crate::cause!(Refused::NotAChange))?;
        if !words.confirm_words.contains_key(action) || fields.len() > 4 || fields.values().any(|text| text.len() > 512) {
            return Err(crate::cause!(Refused::NotAChange));
        }
        Ok(Change(fields))
    }

    /// The change for `action` with `fields`.
    pub(crate) fn named(action: &str, fields: &[(&str, &str)]) -> Change {
        let mut map: BTreeMap<String, String> = fields.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect();
        map.insert("action".into(), action.into());
        Change(map)
    }

    /// One text for exactly this change, the same for any order its fields were written in (old src/cap-change.mjs
    /// `changeKey`).
    pub(crate) fn key(&self) -> String {
        serde_json::to_string(&self.0).unwrap_or_default()
    }

    /// What the page shows while the passkey prompt for this change is up (old :49-52 `confirmWords`).
    pub(crate) fn words(&self, words: &OperationWords) -> String {
        let template = self.0.get("action").and_then(|action| words.confirm_words.get(action)).cloned().unwrap_or_default();
        let values: Vec<(&str, &str)> = self.0.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
        said(&template, &values)
    }

    pub(crate) fn as_value(&self) -> Value {
        serde_json::to_value(&self.0).unwrap_or(Value::Null)
    }
}

/// Whether `confirmation` (a passkey assertion over a challenge `sign-in:confirm-change` made for exactly `change`) is
/// a known passkey's: `Ok(false)` with none; refused when the passkey is not known (old :158-162 `notKnownWords`).
/// A known passkey's confirmation is a use of it (invariant 3, cancelling what waits) and is told (old :222-226).
pub(crate) fn confirmed(store: &Store<'_>, account: &str, origin: Option<&str>, change: &Change, confirmation: Option<&Value>)
    -> std::result::Result<bool, Refused> {
    let Some(confirmation) = confirmation else { return Ok(false) };
    let origin = origin.ok_or(crate::cause!(Refused::PasskeyRefused))?;
    let used = super::passkeys::confirm(store, account, origin, &change.key(), confirmation)?;
    let now = now_ms();
    let state = state(store, account, now)?;
    let words = words(store, account)?;
    if !state.known.contains(&used.id) {
        let said_now = match authority_from(&used.value) {
            Some(from) if from > now => said(&words.not_known_yet, &[("from", &when(from))]),
            _ => words.never_known.clone(),
        };
        return Err(Refused::NotKnown(said_now, crate::cause!()));
    }
    cancel_waiting(store, account, now)?;
    tell(store, account, now, &words.confirmed_title, &said(&words.confirmed_body, &[("words", &change.words(&words))]))?;
    Ok(true)
}

/// A known passkey's confirmation vouches for passkey `id` (old :271-276 `vouch`, src/account-routes.mjs:677-689): it
/// is known once its notice has passed, and the person is told. Answers the words.
pub(crate) fn vouch(store: &Store<'_>, account: &str, id: &str, confirmed: bool) -> std::result::Result<String, Refused> {
    let now = now_ms();
    let words = words(store, account)?;
    let state = state(store, account, now)?;
    let row = state.passkeys.iter().find(|row| row.id == id).ok_or(crate::cause!(Refused::NoPasskey))?;
    if state.known.iter().any(|known| known == id) {
        return Ok(words.already_known.clone());
    }
    if state.known.is_empty() || !confirmed {
        return Err(crate::cause!(Refused::NeedsKnownPasskey));
    }
    let authority = authority_for(Provenance::KnownPasskey, now, 0);
    let mut after = row.clone();
    after.value.authority = Some(authority.clone());
    if !store.replace_if(Family::Passkeys, row, &after)? {
        return Err(crate::cause!(Refused::Storage));
    }
    if let Some((title, body)) = added_notice(&words, &authority) {
        tell(store, account, now, &title, &body)?;
    }
    Ok(said(&words.vouched, &[("from", &when(authority.from.unwrap_or(now)))]))
}

/// Start or cancel a recovery for an account whose known passkeys are lost (old :253-267 `recover`). Answers the words.
pub(crate) fn recover(store: &Store<'_>, account: &str, cancel: bool) -> std::result::Result<String, Refused> {
    let now = now_ms();
    let words = words(store, account)?;
    let state = state(store, account, now)?;
    if cancel {
        if state.recovery.is_some() {
            change_row(store, account, |row| row.recovery.take().is_some())?;
        }
        return Ok(words.recovery_cancelled.clone());
    }
    if let Some(recovery) = state.recovery {
        return Ok(said(&words.recovery_started, &[("from", &when(recovery.from))]));
    }
    if state.known.is_empty() {
        return Ok(words.recovery_not_needed.clone());
    }
    let recovery = Recovery { started_at: now, from: now.saturating_add(authority_settings().wait_ms(Provenance::Notice)) };
    let from = when(recovery.from);
    let body = said(&words.recovery_body, &[("from", &from)]);
    let mut room = false;
    change_row(store, account, |row| {
        room = prune(row, now);
        if room {
            row.notices.push(Notice { at: now, title: words.recovery_title.clone(), body: body.clone(), counted: true });
            row.recovery = Some(recovery);
        }
        room
    })?;
    if !room {
        return Err(crate::cause!(Refused::TooManyNotices));
    }
    Ok(said(&words.recovery_started, &[("from", &from)]))
}

/// Ask the change `change` that destroys the account, on an account with no known passkey (invariant 6, old :176-189
/// `delayedChange`): the same change asked again once its wait has passed goes ahead; one asked while a wait runs is
/// refused with until when; otherwise the wait starts now, takes a notice's room and is told.
pub(crate) fn delayed(store: &Store<'_>, account: &str, change: &Change, now: u64) -> std::result::Result<Delay, Refused> {
    let key = change.key();
    let words = words(store, account)?;
    let row = read_row(store, account)?.map(|row| row.value).unwrap_or_default();
    match &row.delayed {
        Some(waiting) if waiting.change == key && waiting.from <= now => {
            change_row(store, account, |row| row.delayed.take().is_some())?;
            return Ok(Delay::GoAhead);
        }
        Some(waiting) if waiting.from > now => {
            let template = if waiting.change == key { &words.delayed_waiting } else { &words.delayed_other };
            return Err(Refused::Delayed(said(template, &[("from", &when(waiting.from))]), crate::cause!()));
        }
        _ => {}
    }
    let started = Delayed { change: key, started_at: now, from: now.saturating_add(authority_settings().wait_ms(Provenance::Notice)) };
    let from = when(started.from);
    let body = said(&words.delayed_body, &[("from", &from)]);
    let mut room = false;
    change_row(store, account, |row| {
        room = prune(row, now);
        if room {
            row.notices.push(Notice { at: now, title: words.delayed_title.clone(), body: body.clone(), counted: true });
            row.delayed = Some(started.clone());
        }
        room
    })?;
    if !room {
        return Err(crate::cause!(Refused::TooManyNotices));
    }
    Ok(Delay::Started(said(&words.delayed_started, &[("from", &from)])))
}

/// End a delayed change waiting (old :192-195 `cancelDelayed`: any recent sign-in may, cancelling destroys nothing).
/// Answers the words.
pub(crate) fn cancel_delayed(store: &Store<'_>, account: &str) -> std::result::Result<String, Refused> {
    let words = words(store, account)?;
    change_row(store, account, |row| row.delayed.take().is_some())?;
    Ok(words.delayed_cancelled)
}

/// What a listing of the account's passkeys says of each: never its key, only its name, dates and authority.
pub(crate) fn described(state: &State) -> Vec<Value> {
    state.passkeys.iter().map(|row| serde_json::json!({
        "id": row.id,
        "name": row.value.name,
        "created_at": row.value.created_at,
        "last_used_at": row.value.last_used_at,
        "provenance": row.value.authority.as_ref().map(|authority| authority.by),
        "known": state.known.contains(&row.id),
        "known_from": authority_from(&row.value),
    })).collect()
}

/// The settings the tests read.
#[cfg(test)]
pub(crate) fn wait_ms_for_tests(by: Provenance) -> u64 {
    authority_settings().wait_ms(by)
}

#[cfg(test)]
#[path = "known_tests.rs"]
mod tests;
