//! The ways an account signs in besides its passkeys, as one module over the account's own ways row (`WaySettings`,
//! a row of the account's lists beside its sign-in settings row, read at each use; words in its words row, `ways`). A
//! way is a row naming one proof; this module knows the proofs, never a way:
//! - `chosen`: a secret the person chose, kept only as a scrypt key (src/account/credential_verification.rs);
//! - `sent`: a one-use code sent over the row's channel to the way's name, by the tool the account picked for that
//!   channel (`Deliver`, a tool run by its handle);
//! - `timed`: the RFC 6238 code an authenticator app makes from a shared secret (HMAC-SHA1, the protocol those apps
//!   speak);
//! - `listed`: one-use codes made all at once, kept only as BLAKE3 hashes;
//! - `key`: a personal key (`keys.rs`), which approves one waiting AI-app connection within its own scopes.
//!
//! Every way has its whole lifecycle here: add (`add`, then `confirm` for a proof that must answer first), use to
//! sign in (`send_code`, `sign_in`), change (adding a held way again replaces it), remove (`remove`), and recover
//! (a way's `recover_with` rows; a session they started may set the way anew without its current proof).
//!
//! Non-negotiable invariants:
//! 1. No secret is stored as typed: chosen secrets as scrypt keys, codes as BLAKE3 hashes bound to their row, keys by
//!    their fingerprint. A timed secret is the one exception the protocol forces, kept in the account's own rows.
//! 2. Asking for a sign-in code answers the same whether or not the typed name is this account's; a wrong name and a
//!    wrong secret read the same words and cost the same work.
//! 3. A code works once, ends after `code.seconds`, and dies after `code.tries` wrong tries; a timed step signs in once.
//! 4. Tries and sends are counted per account and way within `window_seconds`; a try past the limit is refused before
//!    any secret is checked.
//! 5. A way is added, changed or removed only by a session that started within `fresh_seconds` by a way that may
//!    change ways (`may_change`). The last way that keeps the account reachable, with no passkey, is never removed.
//! 6. A way named in another held way's `also` is not removed while that way is held, and is held before it is added.
//! 7. An account without its ways row has no way besides its passkeys: each step refuses with `Refused::Missing`
//!    (code `sign_in_ways_missing`), never a default.
//!
//! Stored values, owned by this file:
//! - lists:      `WaysRow` = `{revision, ways}`, id `settings:sign-in-ways:` + the account's user id
//! - ways:       `Held`, id = blake3_hex(account, way)
//! - way_codes:  `Waiting` (a sent code or an unfinished add), id = blake3_hex(account, way, purpose)
//! - tries:      `Counted`, id = blake3_hex(account, way, what is counted)
//! - deliveries: `Delivery` (the tool that sends one channel's codes), id = blake3_hex(account, channel)

use super::keys;
use super::store::{Family, Row, Store};
use super::tokens::{blake3_hex, random_hex, same};
use super::{contract, now_ms, Principal};
use crate::account::credential_verification::{make_password_record, verify_password, VerificationPolicy};
use regex::Regex;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use zeroize::Zeroizing;

/// The start of the ways row's id; the account's user id follows.
pub(crate) const ROW_PREFIX: &str = "settings:sign-in-ways:";
/// The refusal code of a missing ways row, at the account's routes and on the sign-in routes.
pub(crate) const MISSING: &str = "sign_in_ways_missing";

/// The input and result shape every message-sending tool shares (the send-messages tools): the fields that
/// carry the recipient, the subject, the plain words (an email sender draws them in the person's look; one that cannot
/// draw refuses before anything is sent) and a stable attempt/tool-run key; the JSON pointer of the provider's id of a
/// message that was sent; and, for one that was not, the pointer saying the tool's own limits held it and the pointer
/// of the words it says why. `kind` names what the message is, so the tool counts a sign-in code under its own limits and
/// not as an ordinary message. The owner journals one run per key and suppresses reruns after an unknown result; that
/// does not promise provider deduplication or exactly-once delivery. Part of the account routes' contract with those tools,
/// not a setting. This module sends nothing else: no sender address (`from`), which those tools' input does not list; a fixed
/// input naming any of these is refused.
const DELIVER_TO: &str = "to";
const DELIVER_KIND: &str = "kind";
const DELIVER_KIND_SIGN_IN_CODE: &str = "sign-in-code";
const DELIVER_SUBJECT: &str = "subject";
const DELIVER_TEXT: &str = "text";
const DELIVER_RETRY_KEY: &str = "idempotencyKey";
const DELIVER_SENT: &str = "/sent/0/messageId";
const DELIVER_LIMITED: &str = "/sent/0/limited";
const DELIVER_SAID: &str = "/sent/0/error";
const DELIVER_UNKNOWN: &str = "/sent/0/unknown";
/// The input fields this module sets on every send; a delivery's fixed input may name none of them.
const DELIVER_SET: [&str; 5] = [DELIVER_TO, DELIVER_KIND, DELIVER_SUBJECT, DELIVER_TEXT, DELIVER_RETRY_KEY];

/// The account's ways and their limits: its own row, changed by its owner (`sign-in:set-ways`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaySettings {
    /// How recently a session must have started to add, change or remove a way.
    pub fresh_seconds: u64,
    /// The window tries and sends are counted in.
    pub window_seconds: u64,
    /// How long an unfinished add (a timed secret waiting for its first code) waits.
    pub setup_seconds: u64,
    pub code: CodeShape,
    pub listed: ListedShape,
    pub timed: TimedShape,
    pub chosen: ChosenShape,
    /// For each kind of name, the input a page asks it in and the one form it is kept by.
    pub names: BTreeMap<String, NameShape>,
    /// The way offered directly under every passkey button that signs in, so no page depends on a passkey working.
    pub code_way: String,
    pub rows: Vec<WayRow>,
    /// The shape this row was written in (`SHAPE_VERSION`). A row kept before the field existed reads as shape 1.
    #[serde(default = "first_shape")]
    pub shape_version: u32,
}

/// Every sent code: its digits, its life, its wrong tries, and the wait before a new code replaces one still working.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodeShape {
    pub digits: usize,
    pub seconds: u64,
    pub tries: u32,
    pub resend_after_seconds: u64,
}

/// Listed codes: how many, their groups of characters from `alphabet`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ListedShape {
    pub count: usize,
    pub groups: usize,
    pub group_length: usize,
    pub alphabet: String,
}

/// Timed codes: their digits, their step and the size of a new secret.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TimedShape {
    pub digits: u32,
    pub seconds: u64,
    pub secret_bytes: usize,
}

/// Chosen secrets: their lengths, and the scrypt cost a new one is kept with (`kdf`) within `kdf_bounds`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChosenShape {
    pub min_length: usize,
    pub max_length: usize,
    pub max_memory_bytes: u64,
    pub kdf: Value,
    pub kdf_bounds: Value,
}

/// One kind of name: the input type and autocomplete a page asks it with, the characters `strip` removes, whether it is
/// made lower case, the `pattern` it must then match and its longest length.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NameShape {
    /// The box's name in the form, as the old page named it (`sign_in_email`, src/pages.mjs `emailField`). Rows and
    /// configs kept before it existed leave it out; `name_field_of` then reads the shipped default at use.
    #[serde(default)]
    pub field: String,
    pub input: String,
    pub autocomplete: String,
    /// What the box says while it is empty (old `placeholder`); empty draws none.
    #[serde(default)]
    pub placeholder: String,
    /// The keyboard the box opens (old `inputmode`); empty sets none.
    #[serde(default)]
    pub inputmode: String,
    /// Whether the box must be filled in (old `required`).
    #[serde(default)]
    pub required: bool,
    pub strip: String,
    pub lower: bool,
    pub pattern: String,
    pub max_length: usize,
}

/// The shape a row without `shape_version` is: the one before the field was added.
fn first_shape() -> u32 {
    1
}

/// The shape this release writes. Stored rows and configs read any shape: unknown fields are kept and ignored, and a
/// missing field takes its default at use (`shape-defaults.json`), so no kept row is rewritten to add one.
pub const SHAPE_VERSION: u32 = 2;

/// The shipped defaults a stored shape leaves out (`shape-defaults.json`), read at use.
#[derive(Deserialize)]
pub(crate) struct ShapeDefaults {
    _what: String,
    /// The box's name in the form for a kind of name, with `{kind}` where the kind goes.
    name_field: String,
    /// The recovery of the text way (old src/pages.mjs phoneSignInPage offers the email code only), and the recovery the
    /// seed wrote before it: a stored row that still holds the earlier one reads as the shipped one, never rewritten.
    text_recover_with: Vec<String>,
    previous_text_recover_with: Vec<String>,
    /// The code message the seed wrote before it was restored to old src/worker.mjs's copy: a stored row that still holds it
    /// reads as the shipped one, never rewritten.
    pub(crate) previous_code_sent: String,
}

pub(crate) fn shape_defaults() -> &'static ShapeDefaults {
    static DEFAULTS: OnceLock<ShapeDefaults> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        let value: ShapeDefaults = serde_json::from_slice(include_bytes!("shape-defaults.json")).expect("shape-defaults.json is valid");
        assert!(value.name_field.contains("{kind}") && !value._what.is_empty(), "shape-defaults.json names its name_field with {{kind}}");
        value
    })
}

/// How a way is checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Proof {
    Chosen,
    Sent,
    Timed,
    Listed,
    Key,
}

/// What a right proof opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Opens {
    Session,
    App,
}

/// One way. `named`: the kind of name the person types (a key of `names`) or none. `also`: ways whose proof a sign-in
/// with this way needs as well. `alone`: whether this way alone keeps the account reachable. `changes_ways`: whether a
/// session it started may add, change or remove ways. `change_needs_current`: the current proof is asked before a held
/// way is changed. `recover_with`: the ways offered when this one cannot be used. `tries` and `sends`: how many the
/// account gets for this way within the window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WayRow {
    pub way: String,
    pub proof: Proof,
    pub channel: Option<String>,
    pub named: Option<String>,
    pub also: Vec<String>,
    pub alone: bool,
    pub changes_ways: bool,
    pub change_needs_current: bool,
    pub recover_with: Vec<String>,
    pub opens: Opens,
    pub tries: usize,
    pub sends: usize,
}

/// The stored row: the ways and the revision that orders their changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaysRow {
    pub revision: u64,
    pub ways: WaySettings,
    /// Fields a newer release wrote, kept as they were so a rewrite by this release loses none of them.
    #[serde(flatten)]
    pub unknown_keys: crate::account::computers::UnknownKeys,
}

/// The text way's recovery as the seed wrote it before the port (`recover_with`: the email code and the backup codes).
/// An account whose stored row still holds it takes the seed's: old src/pages.mjs phoneSignInPage offers the email code only.
/// The longest any lifetime or window may be, in seconds (400 days).
const MOST_SECONDS: u64 = 400 * 24 * 3600;

impl WaySettings {
    /// The row of `way`, when it is one.
    pub(crate) fn row(&self, way: &str) -> Option<&WayRow> {
        self.rows.iter().find(|row| row.way == way)
    }

    /// The ways a page may offer when only the `delivered` channels have a tool picked to send their codes: a sent
    /// way that cannot reach the person is left out, so no page links to a way that would fail.
    pub(crate) fn offering(mut self, delivered: &[String]) -> Self {
        self.rows.retain(|row| row.proof != Proof::Sent || row.channel.as_ref().is_some_and(|channel| delivered.contains(channel)));
        self
    }

    /// Whether the settings hold together: every number in range, every way named once, every way a row names is a row, a sent way has a channel and every named way a kind of name, every name's pattern reads, the code way is
    /// a sent way, and the chosen secrets' cost is one the verifier accepts.
    pub fn valid(&self) -> bool {
        let lifetimes = [self.fresh_seconds, self.window_seconds, self.setup_seconds, self.code.seconds, self.code.resend_after_seconds];
        let mut names: Vec<&str> = self.rows.iter().map(|row| row.way.as_str()).collect();
        names.sort_unstable();
        let unique = names.windows(2).all(|pair| pair[0] != pair[1]);
        let rows_hold = self.rows.iter().all(|row| {
            row.also.iter().chain(&row.recover_with).all(|other| self.row(other).is_some() && *other != row.way)
                && (row.proof == Proof::Sent) == row.channel.is_some()
                && row.named.as_ref().is_none_or(|kind| self.names.contains_key(kind))
                && (row.proof != Proof::Sent || row.named.is_some())
                && row.tries >= 1 && row.tries <= 1000 && row.sends <= 1000
        });
        let names_read = self.names.values().all(|shape| {
            Regex::new(&shape.pattern).is_ok() && (shape.strip.is_empty() || Regex::new(&shape.strip).is_ok()) && shape.max_length >= 1
        });
        let alphabet = self.listed.alphabet.chars().count();
        lifetimes.iter().all(|seconds| (1..=MOST_SECONDS).contains(seconds))
            && unique && rows_hold && names_read
            && self.row(&self.code_way).is_some_and(|row| row.proof == Proof::Sent)
            && (4..=10).contains(&self.code.digits) && (1..=20).contains(&self.code.tries)
            && (1..=100).contains(&self.listed.count) && (1..=8).contains(&self.listed.groups) && (2..=8).contains(&self.listed.group_length)
            && (10..=256).contains(&alphabet)
            && (6..=8).contains(&self.timed.digits) && (15..=120).contains(&self.timed.seconds) && (10..=64).contains(&self.timed.secret_bytes)
            && self.chosen.min_length >= 1 && self.chosen.min_length <= self.chosen.max_length && self.chosen.max_length <= 4096
            && self.chosen_policy().is_ok()
    }

    fn chosen_policy(&self) -> Result<VerificationPolicy> {
        VerificationPolicy::from_settings(&json!({"kdf": self.chosen.kdf, "kdf_bounds": self.chosen.kdf_bounds}), self.chosen.max_memory_bytes)
            .map_err(|error| Refused::Storage(error.cause()))
    }

    fn minutes(seconds: u64) -> u64 {
        seconds.div_ceil(60)
    }
}

/// The form field each proof is typed in, and the fields an add or a change asks for besides it.
pub(crate) const SECRET_FIELD: &str = "password";
pub(crate) const CODE_FIELD: &str = "code";
pub(crate) const KEY_FIELD: &str = "key";
pub(crate) const NEW_SECRET_FIELD: &str = "new_password";
pub(crate) const CURRENT_SECRET_FIELD: &str = "current_password";
pub(crate) const KEY_NAME_FIELD: &str = "key_name";

impl Proof {
    /// The form field a sign-in with this proof types its secret in.
    pub(crate) fn field(self) -> &'static str {
        match self {
            Proof::Chosen => SECRET_FIELD,
            Proof::Sent | Proof::Timed | Proof::Listed => CODE_FIELD,
            Proof::Key => KEY_FIELD,
        }
    }
}

// ---- The account's ways row ----

/// Why a change of the ways row is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum RowRefused {
    /// The settings do not hold together (`WaySettings::valid`).
    Invalid(crate::refusal_cause::Cause),
    /// The row moved on since the revision the caller read.
    Stale(crate::refusal_cause::Cause),
    /// The sign-in storage did not answer.
    Storage(crate::refusal_cause::Cause),
}

impl RowRefused {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Stale(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(RowRefused);

impl PartialEq for RowRefused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Invalid(_), Self::Invalid(_)) => true,
            (Self::Stale(_), Self::Stale(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


fn row_id(account: &str) -> String {
    format!("{ROW_PREFIX}{account}")
}

/// The account's ways row, when it has one.
pub(crate) fn read(store: &Store<'_>, account: &str) -> Result<Option<Row<WaysRow>>> {
    Ok(read_typed(store, account)?.map(|mut row| {
        recovery_as_shipped(&mut row.value.ways);
        row
    }))
}

/// A stored text way that still has the recovery the seed wrote before the port reads as the shipped one, at use. Nothing
/// is written: the row keeps what it stores until the person changes its ways.
fn recovery_as_shipped(ways: &mut WaySettings) {
    let defaults = shape_defaults();
    if let Some(text) = ways.rows.iter_mut().find(|row| row.channel.as_deref() == Some("text")) {
        if text.recover_with.iter().eq(defaults.previous_text_recover_with.iter()) {
            text.recover_with = defaults.text_recover_with.clone();
        }
    }
}

/// The account's ways row with its typed sign-in error, for a page that offers the ways: a row this computer may not
/// admit from (`SourceNotCurrent`) is told apart from a failed read, and only the page reads it that way.
pub(crate) fn read_typed(store: &Store<'_>, account: &str) -> super::Result<Option<Row<WaysRow>>> {
    Ok(store.get::<WaysRow>(Family::Lists, &row_id(account))?.filter(|row| row.account == account))
}

/// The account's ways now; `Refused::Missing` when it has no row.
pub(crate) fn current(store: &Store<'_>, account: crate::account::sign_in::UserId<'_>) -> Result<WaySettings> {
    read(store, account.0)?.map(|row| row.value.ways).ok_or(crate::cause!(Refused::Missing))
}

/// Replace the account's ways with `ways` when the row's revision is still `expected_revision` (0: no row yet). One
/// compare-and-set on the stored value, so a second editor refuses. The new revision is one more.
pub(crate) fn set(store: &Store<'_>, account: &str, expected_revision: u64, ways: WaySettings) -> std::result::Result<WaysRow, RowRefused> {
    if !ways.valid() || expected_revision >= 1 << 53 {
        return Err(crate::cause!(RowRefused::Invalid));
    }
    let before = read(store, account).map_err(|error| RowRefused::Storage(error.cause()))?;
    let current = before.as_ref().map_or(0, |row| row.value.revision);
    if current != expected_revision {
        return Err(crate::cause!(RowRefused::Stale));
    }
    let unknown_keys = before.as_ref().map(|row| row.value.unknown_keys.clone()).unwrap_or_default();
    let value = WaysRow { revision: current + 1, ways, unknown_keys };
    let after = Row { id: row_id(account), account: account.to_string(), expires_at: 0, value: value.clone() };
    match before {
        None => store.insert(Family::Lists, &after).map_err(|error| RowRefused::Stale(error.cause()))?,
        Some(prior) => {
            if !store.replace_if(Family::Lists, &prior, &after).map_err(|error| RowRefused::Storage(error.cause()))? {
                return Err(crate::cause!(RowRefused::Stale));
            }
        }
    }
    Ok(value)
}

// ---- Stored values ----

/// A way the account holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Held {
    pub way: String,
    /// The name in the one form it is kept by (an email, a phone), shown to the account itself; None for an unnamed way.
    pub name: Option<String>,
    pub material: Material,
    pub added_at: u64,
    pub changed_at: u64,
}

/// What a held way keeps to check its proof.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "proof", rename_all = "kebab-case")]
pub(crate) enum Material {
    /// The scrypt record of the chosen secret.
    Chosen { record: Value },
    /// Nothing besides the name: the code goes to it.
    Sent,
    /// The base32 shared secret and the last step that signed in.
    Timed { secret: String, last_step: u64 },
    /// The BLAKE3 hash of each code still unused.
    Listed { hashes: Vec<String> },
}

/// Why a code or setup is waiting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Purpose {
    SignIn,
    Add,
}

impl Purpose {
    fn name(self) -> &'static str {
        match self {
            Purpose::SignIn => "sign-in",
            Purpose::Add => "add",
        }
    }
}

/// A code sent, or an add that waits for its first right answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Waiting {
    pub way: String,
    pub purpose: Purpose,
    pub name: Option<String>,
    pub code_hash: Option<String>,
    /// A timed add's secret, until its first right code.
    pub secret: Option<String>,
    pub tries: u32,
    pub made_at: u64,
    /// Stable identity of the tool run for this code. Older waiting rows did not keep it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt_request_key: Option<String>,
    /// What this computer knows about the attempt. Missing means a pre-metadata row whose send outcome is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryOutcome>,
}

/// The outcome known for one code delivery attempt. `Unknown` never authorizes another code before expiry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum DeliveryOutcome {
    Sent,
    /// The attempt is in progress or could not be recorded after the tool was invoked.
    Pending,
    /// The tool confirmed that no message was sent.
    NotStarted,
    /// The tool may have sent the message; do not mint or send another code before expiry.
    Unknown,
}

/// The tries or sends counted within the window.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Counted {
    pub at: Vec<u64>,
}

/// The tool that sends one channel's codes, and the fixed input it always gets besides what this module sets (`DELIVER_SET`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Delivery {
    pub channel: String,
    pub tool: String,
    pub input: Map<String, Value>,
}

/// Runs one tool of the account's tools by its handle, as the account routes' own tool run does. A sent code goes out
/// through it; this module knows no provider.
pub(crate) trait Deliver: Send + Sync {
    fn run(&self, request_key: &str, tool: &str, input: &Value) -> std::result::Result<Value, DeliverFailure>;
}

#[derive(Clone, Debug, Eq)]
pub(crate) enum DeliverFailure {
    NotStarted(crate::refusal_cause::Cause),
    OutcomeUnknown(crate::refusal_cause::Cause),
}

impl DeliverFailure {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotStarted(cause) => cause.clone(),
            Self::OutcomeUnknown(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(DeliverFailure);

impl PartialEq for DeliverFailure {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NotStarted(_), Self::NotStarted(_)) => true,
            (Self::OutcomeUnknown(_), Self::OutcomeUnknown(_)) => true,
            _ => false,
        }
    }
}


/// Why a way's step was refused. Each has its words (the account's words row, `ways`).
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// The proof is not right (or the name is not this account's); one answer for both.
    Wrong(crate::refusal_cause::Cause),
    /// Too many tries or sends within the window: wait this many minutes.
    TooMany(u64, crate::refusal_cause::Cause),
    /// The code could not be sent; none is waiting.
    NotSent(crate::refusal_cause::Cause),
    /// A message may have been sent. The same code remains usable until it expires; no replacement is sent first.
    DeliveryUnknown(crate::refusal_cause::Cause),
    /// The sending tool's own limits held the code; none is waiting. The tool's words.
    Limited(String, crate::refusal_cause::Cause),
    /// The typed name is not a name of the way's kind.
    NotAName(crate::refusal_cause::Cause),
    TooShort(crate::refusal_cause::Cause),
    TooLong(crate::refusal_cause::Cause),
    /// A change asked for the current proof and it is not right.
    CurrentWrong(crate::refusal_cause::Cause),
    /// No add is waiting, or it ended.
    SetupEnded(crate::refusal_cause::Cause),
    /// This way needs that way to be held first.
    NeedsFirst(String, crate::refusal_cause::Cause),
    /// That held way needs this one.
    NeededBy(String, crate::refusal_cause::Cause),
    /// Removing this would leave no way in.
    LastWayIn(crate::refusal_cause::Cause),
    /// The session did not start recently enough.
    NotFresh(crate::refusal_cause::Cause),
    /// The session started by a way that may not change ways.
    NotThisSession(crate::refusal_cause::Cause),
    /// A way that opens an AI-app connection was used with none waiting.
    NoRequest(crate::refusal_cause::Cause),
    /// A passkey or a recovery waits, so no way in may change now (`known::guarded`).
    HeldWhileWaiting(crate::refusal_cause::Cause),
    /// The account has a known passkey, and this change needs its confirmation (`known::guarded`).
    NeedsKnownPasskey(crate::refusal_cause::Cause),
    /// Not one of the account's ways, or the step does not fit its proof.
    Unknown(crate::refusal_cause::Cause),
    /// The account has no ways row (`MISSING`).
    Missing(crate::refusal_cause::Cause),
    /// The account has no words row, or one that leaves a way of its ways row without words (`words_row::MISSING`):
    /// nothing is sent or drawn without its words.
    WordsMissing(crate::refusal_cause::Cause),
    /// The storage did not answer; never a reason to admit.
    Storage(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Wrong(cause) => cause.clone(),
            Self::TooMany(_, cause) => cause.clone(),
            Self::NotSent(cause) => cause.clone(),
            Self::DeliveryUnknown(cause) => cause.clone(),
            Self::Limited(_, cause) => cause.clone(),
            Self::NotAName(cause) => cause.clone(),
            Self::TooShort(cause) => cause.clone(),
            Self::TooLong(cause) => cause.clone(),
            Self::CurrentWrong(cause) => cause.clone(),
            Self::SetupEnded(cause) => cause.clone(),
            Self::NeedsFirst(_, cause) => cause.clone(),
            Self::NeededBy(_, cause) => cause.clone(),
            Self::LastWayIn(cause) => cause.clone(),
            Self::NotFresh(cause) => cause.clone(),
            Self::NotThisSession(cause) => cause.clone(),
            Self::NoRequest(cause) => cause.clone(),
            Self::HeldWhileWaiting(cause) => cause.clone(),
            Self::NeedsKnownPasskey(cause) => cause.clone(),
            Self::Unknown(cause) => cause.clone(),
            Self::Missing(cause) => cause.clone(),
            Self::WordsMissing(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refused);

impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Wrong(_), Self::Wrong(_)) => true,
            (Self::TooMany(left, _), Self::TooMany(right, _)) => left == right,
            (Self::NotSent(_), Self::NotSent(_)) => true,
            (Self::DeliveryUnknown(_), Self::DeliveryUnknown(_)) => true,
            (Self::Limited(left, _), Self::Limited(right, _)) => left == right,
            (Self::NotAName(_), Self::NotAName(_)) => true,
            (Self::TooShort(_), Self::TooShort(_)) => true,
            (Self::TooLong(_), Self::TooLong(_)) => true,
            (Self::CurrentWrong(_), Self::CurrentWrong(_)) => true,
            (Self::SetupEnded(_), Self::SetupEnded(_)) => true,
            (Self::NeedsFirst(left, _), Self::NeedsFirst(right, _)) => left == right,
            (Self::NeededBy(left, _), Self::NeededBy(right, _)) => left == right,
            (Self::LastWayIn(_), Self::LastWayIn(_)) => true,
            (Self::NotFresh(_), Self::NotFresh(_)) => true,
            (Self::NotThisSession(_), Self::NotThisSession(_)) => true,
            (Self::NoRequest(_), Self::NoRequest(_)) => true,
            (Self::HeldWhileWaiting(_), Self::HeldWhileWaiting(_)) => true,
            (Self::NeedsKnownPasskey(_), Self::NeedsKnownPasskey(_)) => true,
            (Self::Unknown(_), Self::Unknown(_)) => true,
            (Self::Missing(_), Self::Missing(_)) => true,
            (Self::WordsMissing(_), Self::WordsMissing(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


pub(crate) type Result<T> = std::result::Result<T, Refused>;

impl From<super::Error> for Refused {
    fn from(error: super::Error) -> Self {
        let cause = error.cause();
        match error {
            // A session or key that needs the account's sign-in settings row, which it does not have.
            super::Error::SettingsMissing(_) => Refused::Missing(cause),
            _ => Refused::Storage(cause),
        }
    }
}

/// What a right sign-in opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Opened {
    /// A browser session, started by `way`; `left` is how many listed codes are still unused, for a listed way.
    Session { way: String, left: Option<usize> },
    /// An AI-app connection, within these scopes (a personal key's own).
    App { scopes: Vec<String> },
}

/// What an add or change answered.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Added {
    /// The way is held now, under this name when it is named.
    Held(Option<String>),
    /// A code went to `name`; `confirm` finishes.
    CodeSent { name: String },
    /// A timed secret waits for its first right code (`confirm`): its key and the address an app opens.
    Setup { key: String, address: String },
    /// New listed codes, shown only this once.
    Codes(Vec<String>),
    /// A new personal key, shown only this once.
    Key(Zeroizing<String>),
}

/// The fields a page posted, by name.
pub(crate) type Typed = BTreeMap<String, String>;

/// The form field a way's name is typed in: its names shape's `field`, or the shipped default for a shape that leaves it out.
pub(crate) fn name_field_of(ways: &WaySettings, kind: &str) -> Option<String> {
    let shape = ways.names.get(kind)?;
    Some(if shape.field.is_empty() { shape_defaults().name_field.replace("{kind}", kind) } else { shape.field.clone() })
}

/// The value typed into a way's name box (empty when the way names no box).
fn typed_name<'a>(ways: &WaySettings, form: &'a Typed, kind: &str) -> &'a str {
    name_field_of(ways, kind).map_or("", |field| typed(form, &field))
}

fn typed<'a>(form: &'a Typed, field: &str) -> &'a str {
    form.get(field).map_or("", String::as_str)
}

fn id_of(parts: &[&str]) -> String {
    blake3_hex(&parts.join("\n"))
}

fn held_id(account: &str, way: &str) -> String {
    id_of(&[account, way])
}

fn waiting_id(account: &str, way: &str, purpose: Purpose) -> String {
    id_of(&[account, way, purpose.name()])
}

/// The name `text` in the one form a name of `kind` is kept by, or None when it is not one.
pub(crate) fn normal_name(ways: &WaySettings, kind: &str, text: &str) -> Option<String> {
    let shape = ways.names.get(kind)?;
    let trimmed = text.trim();
    if trimmed.chars().count() > shape.max_length {
        return None;
    }
    let mut name = if shape.strip.is_empty() {
        trimmed.to_string()
    } else {
        Regex::new(&shape.strip).ok()?.replace_all(trimmed, "").into_owned()
    };
    if shape.lower {
        name = name.to_lowercase();
    }
    Regex::new(&shape.pattern).ok()?.is_match(&name).then_some(name)
}

/// The account's held ways.
pub(crate) fn held(store: &Store<'_>, account: &str) -> Result<Vec<Row<Held>>> {
    Ok(store.list(Family::Ways, account, usize::MAX)?)
}

fn held_way(store: &Store<'_>, account: &str, way: &str) -> Result<Option<Row<Held>>> {
    Ok(store.get::<Held>(Family::Ways, &held_id(account, way))?.filter(|row| row.account == account))
}

/// Whether the account holds `way` now. A key way is held while the account has a live personal key.
pub(crate) fn holds(store: &Store<'_>, account: &str, way: &WayRow) -> Result<bool> {
    match way.proof {
        Proof::Key => Ok(!keys::list(store, account)?.is_empty()),
        _ => Ok(held_way(store, account, &way.way)?.is_some()),
    }
}

// ---- Counting tries and sends ----

/// Count one try of `what` for `way` of `account` against `most` within the window; refuses (counting nothing) when
/// the window already holds `most`. A limit of zero refuses every try.
fn count(store: &Store<'_>, ways: &WaySettings, account: &str, way: &str, what: &str, most: usize, now: u64) -> Result<()> {
    let window = ways.window_seconds.saturating_mul(1000);
    let id = id_of(&[account, way, what]);
    for _ in 0..8 {
        let found = store.get::<Counted>(Family::Tries, &id)?;
        let mut at: Vec<u64> = found.as_ref().map(|row| row.value.at.clone()).unwrap_or_default();
        at.retain(|when| now.saturating_sub(*when) < window);
        if at.len() >= most {
            return Err(Refused::TooMany(WaySettings::minutes(ways.window_seconds), crate::cause!()));
        }
        at.push(now);
        let next = Row { id: id.clone(), account: account.to_string(), expires_at: now.saturating_add(window), value: Counted { at } };
        let written = match &found {
            Some(before) => store.replace_if(Family::Tries, before, &next)?,
            None => store.insert(Family::Tries, &next).is_ok(),
        };
        if written {
            return Ok(());
        }
    }
    Err(crate::cause!(Refused::Storage))
}

// ---- Codes ----

fn random_bytes(count: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; count];
    SystemRandom::new().fill(&mut buffer).expect("the operating system's random source answers");
    buffer
}

/// `count` characters of `alphabet`, each from a random byte below the largest multiple of its length (no bias).
fn random_from(alphabet: &[char], count: usize) -> String {
    let below = (256 / alphabet.len()) * alphabet.len();
    let mut out = String::with_capacity(count);
    while out.chars().count() < count {
        for byte in random_bytes(count * 2) {
            if usize::from(byte) < below && out.chars().count() < count {
                out.push(alphabet[usize::from(byte) % alphabet.len()]);
            }
        }
    }
    out
}

/// A code of the way's digits, from the system's random source with no modulo bias (a sign-up's code uses it too).
pub(crate) fn new_code(ways: &WaySettings) -> String {
    let digits: Vec<char> = ('0'..='9').collect();
    random_from(&digits, ways.code.digits)
}

/// The hash a waiting code is kept under: its pending id and the code, so one code cannot be checked against another id.
pub(crate) fn code_hash(id: &str, code: &str) -> String {
    blake3_hex(&format!("{id}\n{code}"))
}

/// Only the digits of a typed code.
fn digits_of(typed: &str) -> String {
    typed.chars().filter(char::is_ascii_digit).collect()
}

// ---- Timed codes (RFC 6238 over RFC 4226) ----

const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn base32(bytes: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for byte in bytes {
        value = (value << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(BASE32[((value >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(char::from(BASE32[((value << (5 - bits)) & 31) as usize]));
    }
    out
}

fn from_base32(text: &str) -> Vec<u8> {
    let (mut bits, mut value, mut out) = (0u32, 0u32, Vec::new());
    for letter in text.bytes().map(|b| b.to_ascii_uppercase()) {
        let Some(index) = BASE32.iter().position(|b| *b == letter) else { continue };
        value = (value << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    out
}

/// The `digits`-digit code of one time step of a base32 secret.
pub(crate) fn timed_code(secret: &str, step: u64, digits: u32) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &from_base32(secret));
    let mac = ring::hmac::sign(&key, &step.to_be_bytes());
    let mac = mac.as_ref();
    let at = usize::from(mac[mac.len() - 1] & 15);
    let number = (u32::from(mac[at] & 127) << 24) | (u32::from(mac[at + 1]) << 16) | (u32::from(mac[at + 2]) << 8) | u32::from(mac[at + 3]);
    format!("{:0width$}", number % 10u32.pow(digits), width = digits as usize)
}

/// The step a typed code belongs to (the current one or one either side, and after `after`), or None. Every step is
/// compared whole, so the time taken says nothing about the code.
fn timed_step(ways: &WaySettings, secret: &str, typed: &str, now: u64, after: Option<u64>) -> Option<u64> {
    let code = digits_of(typed);
    if code.len() != ways.timed.digits as usize {
        return None;
    }
    let current = now / 1000 / ways.timed.seconds;
    let mut found = None;
    for step in [current.saturating_sub(1), current, current + 1] {
        let right = same(&timed_code(secret, step, ways.timed.digits), &code);
        if right && after.is_none_or(|after| step > after) && found.is_none() {
            found = Some(step);
        }
    }
    found
}

/// The address an authenticator app opens for `secret`, naming `issuer` (the account routes' host).
pub(crate) fn timed_address(ways: &WaySettings, issuer: &str, secret: &str) -> String {
    let issuer: String = url::form_urlencoded::byte_serialize(issuer.as_bytes()).collect();
    format!("otpauth://totp/{issuer}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits={}&period={}", ways.timed.digits, ways.timed.seconds)
}

/// A secret as a person types it: groups of four.
pub(crate) fn in_groups(secret: &str) -> String {
    secret.as_bytes().chunks(4).map(|chunk| String::from_utf8_lossy(chunk).into_owned()).collect::<Vec<_>>().join(" ")
}

// ---- Listed codes ----

/// A typed listed code in the one form it is kept by: lower case letters and digits only.
fn normal_listed(typed: &str) -> String {
    typed.to_lowercase().chars().filter(char::is_ascii_alphanumeric).collect()
}

fn listed_hash(account: &str, code: &str) -> String {
    id_of(&[account, code])
}

fn new_listed(ways: &WaySettings, account: &str) -> (Vec<String>, Vec<String>) {
    let shape = &ways.listed;
    let alphabet: Vec<char> = shape.alphabet.chars().collect();
    let mut shown = Vec::with_capacity(shape.count);
    let mut hashes = Vec::with_capacity(shape.count);
    for _ in 0..shape.count {
        let code = random_from(&alphabet, shape.groups * shape.group_length);
        hashes.push(listed_hash(account, &normal_listed(&code)));
        let chars: Vec<char> = code.chars().collect();
        shown.push(chars.chunks(shape.group_length).map(|group| group.iter().collect::<String>()).collect::<Vec<_>>().join("-"));
    }
    (shown, hashes)
}

// ---- Chosen secrets ----

/// Whether a chosen secret is within the way's length bounds (the reset asks before it spends the code).
pub(crate) fn chosen_length(ways: &WaySettings, secret: &str) -> Result<()> {
    let length = secret.chars().count();
    if length < ways.chosen.min_length {
        return Err(crate::cause!(Refused::TooShort));
    }
    if length > ways.chosen.max_length {
        return Err(crate::cause!(Refused::TooLong));
    }
    Ok(())
}

/// Whether `secret` is the one `record` keeps, and whether it was kept at an older cost. With no record it is checked
/// against the policy's made-up key, so a way that is not held costs the same work and is never right.
fn chosen_right(ways: &WaySettings, record: Option<&Value>, secret: &str) -> Result<(bool, bool)> {
    let checked = verify_password(Some(secret), record, &ways.chosen_policy()?).map_err(|error| Refused::Storage(error.cause()))?;
    Ok((checked.matches, checked.needs_rehash))
}

// ---- Sending ----

/// Send `code` to `to` over `channel` with the words of `purpose`, through the tool the account picked for it.
#[allow(clippy::too_many_arguments)]
fn deliver(store: &Store<'_>, ways: &WaySettings, account: &str, channel: &str, to: &str, purpose: Purpose, code: &str,
    request_key: &str, sender: Option<&dyn Deliver>) -> Result<()> {
    let sender = sender.ok_or(crate::cause!(Refused::NotSent))?;
    let chosen = store.get::<Delivery>(Family::Deliveries, &id_of(&[account, channel]))?
        .filter(|row| row.account == account).ok_or(crate::cause!(Refused::NotSent))?;
    let words = super::words_row::current(store, account)?.ok_or(crate::cause!(Refused::WordsMissing))?;
    let words = &words.ways.messages;
    let message = match purpose {
        Purpose::SignIn => &words.sign_in,
        Purpose::Add => &words.confirm,
    };
    let minutes = WaySettings::minutes(ways.code.seconds).to_string();
    let fill = |text: &str| text.replace("{code}", code).replace("{minutes}", &minutes);
    let mut input = chosen.value.input.clone();
    input.insert(DELIVER_TO.into(), json!(to));
    input.insert(DELIVER_KIND.into(), json!(DELIVER_KIND_SIGN_IN_CODE));
    input.insert(DELIVER_SUBJECT.into(), json!(fill(&message.subject)));
    input.insert(DELIVER_TEXT.into(), json!(fill(&message.text)));
    input.insert(DELIVER_RETRY_KEY.into(), json!(request_key));
    let answer = sender.run(request_key, &chosen.value.tool, &Value::Object(input)).map_err(|failure| match failure {
        DeliverFailure::NotStarted(cause) => Refused::NotSent(cause),
        DeliverFailure::OutcomeUnknown(cause) => Refused::DeliveryUnknown(cause),
    })?;
    receipt(&answer)
}

/// Reads the tool's answer to one code: sent only with a message id; a refused send is named; anything else is unknown.
fn receipt(answer: &Value) -> Result<()> {
    let message_id = answer.pointer(DELIVER_SENT).and_then(Value::as_str).filter(|id| !id.trim().is_empty());
    let limited = answer.pointer(DELIVER_LIMITED) == Some(&Value::Bool(true));
    match () {
        _ if answer.get("unknown") == Some(&Value::Bool(true)) || answer.pointer(DELIVER_UNKNOWN) == Some(&Value::Bool(true)) => Err(crate::cause!(Refused::DeliveryUnknown)),
        _ if limited && message_id.is_some() => Err(crate::cause!(Refused::DeliveryUnknown)),
        _ if limited => {
            Err(Refused::Limited(answer.pointer(DELIVER_SAID).and_then(Value::as_str).unwrap_or_default().to_string(), crate::cause!()))
        }
        _ if message_id.is_some() => Ok(()),
        // The send tool explicitly guarantees no effect, with an error explaining the per-recipient refusal.
        _ if (answer.pointer(DELIVER_UNKNOWN) == Some(&Value::Bool(false)) || answer.get("unknown") == Some(&Value::Bool(false)))
            && (answer.pointer(DELIVER_SAID).and_then(Value::as_str).is_some() || answer.get("error").and_then(Value::as_str).is_some()) => Err(crate::cause!(Refused::NotSent)),
        // A missing or malformed receipt cannot prove that no provider effect occurred.
        _ => Err(crate::cause!(Refused::DeliveryUnknown)),
    }
}

/// Record the tool's answer only while `before` is still the exact waiting row. A late answer cannot revive a code
/// that was used, cancelled, expired and replaced, or superseded by a newer attempt.
fn record_delivery(store: &Store<'_>, before: &Row<Waiting>, outcome: DeliveryOutcome) -> Result<bool> {
    let mut after = before.clone();
    after.value.delivery = Some(outcome);
    store.replace_if(Family::WayCodes, before, &after).map_err(Into::into)
}

/// Claim and run one code attempt. The candidate is written before the tool call, and every outcome update is a CAS
/// against that exact attempt so a late result cannot change a newer or withdrawn row.
#[allow(clippy::too_many_arguments)]
fn issue_attempt(store: &Store<'_>, previous: Option<&Row<Waiting>>, row: &Row<Waiting>, ways: &WaySettings,
    channel: &str, to: &str, purpose: Purpose, code: &str, sender: Option<&dyn Deliver>) -> Result<()> {
    match previous {
        Some(before) => {
            if !store.replace_if(Family::WayCodes, before, row)? { return Err(crate::cause!(Refused::DeliveryUnknown)); }
        }
        None => store.insert(Family::WayCodes, row)?,
    }
    let attempt_key = row.value.attempt_request_key.as_deref().ok_or(crate::cause!(Refused::Storage))?;
    let (outcome, refusal) = match deliver(store, ways, &row.account, channel, to, purpose, code, attempt_key, sender) {
        Ok(()) => (DeliveryOutcome::Sent, None),
        Err(refused @ (Refused::NotSent(_) | Refused::Limited(_, _) | Refused::WordsMissing(_) | Refused::Storage(_))) =>
            (DeliveryOutcome::NotStarted, Some(refused)),
        Err(refused @ Refused::DeliveryUnknown(_)) => (DeliveryOutcome::Unknown, Some(refused)),
        Err(other) => {
            let _ = record_delivery(store, row, DeliveryOutcome::Unknown);
            return Err(other);
        }
    };
    if !record_delivery(store, row, outcome)? {
        return if outcome == DeliveryOutcome::NotStarted { Err(refusal.unwrap_or(crate::cause!(Refused::NotSent))) }
            else { Err(crate::cause!(Refused::DeliveryUnknown)) };
    }
    match outcome {
        DeliveryOutcome::Sent => Ok(()),
        DeliveryOutcome::NotStarted => Err(refusal.unwrap_or(crate::cause!(Refused::NotSent))),
        DeliveryOutcome::Pending | DeliveryOutcome::Unknown => Err(refusal.unwrap_or(crate::cause!(Refused::DeliveryUnknown))),
    }
}

/// The channels the account picked a tool for.
pub(crate) fn deliveries(store: &Store<'_>, account: &str) -> Result<Vec<Delivery>> {
    Ok(store.list::<Delivery>(Family::Deliveries, account, usize::MAX)?.into_iter().map(|row| row.value).collect())
}

/// Pick the tool that sends `channel`'s codes, with the input it always gets; no tool stops sending on that channel.
/// A channel none of the account's ways sends on is refused, and so is a fixed input naming a field this module sets.
pub(crate) fn set_delivery(store: &Store<'_>, ways: &WaySettings, account: &str, channel: &str, tool: Option<&str>, input: Map<String, Value>)
    -> Result<()> {
    if !ways.rows.iter().any(|row| row.channel.as_deref() == Some(channel)) || DELIVER_SET.iter().any(|set| input.contains_key(*set)) {
        return Err(crate::cause!(Refused::Unknown));
    }
    let id = id_of(&[account, channel]);
    match tool {
        None => {
            store.remove(Family::Deliveries, &id)?;
        }
        Some(tool) if !tool.trim().is_empty() => {
            let value = Delivery { channel: channel.to_string(), tool: tool.to_string(), input };
            store.put(Family::Deliveries, &Row { id, account: account.to_string(), expires_at: 0, value })?;
        }
        Some(_) => return Err(crate::cause!(Refused::Unknown)),
    }
    Ok(())
}

// ---- Signing in ----

/// Ask for a sign-in code for a `sent` way: the typed name must be the way's own, but every well-formed name is
/// answered the same (`Ok`), and a name that is not this account's sends nothing. A code still working that was sent
/// within `resend_after_seconds` is not replaced, so the one already sent keeps working. If delivery is uncertain, that
/// code and its stable attempt key remain until the full normal expiry; repeating the request does not claim it was sent
/// or start another attempt. Only a fresh explicit request after expiry may make another code.
pub(crate) fn send_code(store: &Store<'_>, ways: &WaySettings, account: &str, way: &WayRow, form: &Typed, sender: Option<&dyn Deliver>)
    -> Result<String> {
    let (Proof::Sent, Some(kind), Some(channel)) = (way.proof, way.named.as_deref(), way.channel.as_deref()) else {
        return Err(crate::cause!(Refused::Unknown));
    };
    let name = normal_name(ways, kind, typed_name(ways, form, kind)).ok_or(crate::cause!(Refused::NotAName))?;
    let now = now_ms();
    count(store, ways, account, &way.way, "send", way.sends, now)?;
    let Some(way_row) = held_way(store, account, &way.way)? else { return Ok(name) };
    if way_row.value.name.as_deref() != Some(name.as_str()) {
        return Ok(name);
    }
    let id = waiting_id(account, &way.way, Purpose::SignIn);
    let previous = store.stored::<Waiting>(Family::WayCodes, &id)?.filter(|row| row.account == account);
    if let Some(live) = &previous {
        if live.expires_at > now {
            match live.value.delivery {
                None | Some(DeliveryOutcome::Pending | DeliveryOutcome::Unknown) => return Err(crate::cause!(Refused::DeliveryUnknown)),
                Some(DeliveryOutcome::Sent) if live.value.tries < ways.code.tries
                    && now.saturating_sub(live.value.made_at) < ways.code.resend_after_seconds.saturating_mul(1000) => return Ok(name),
                Some(DeliveryOutcome::NotStarted | DeliveryOutcome::Sent) => {}
            }
        }
    }
    let code = new_code(ways);
    let attempt_request_key = random_hex(16);
    let row = Row {
        id: id.clone(),
        account: account.to_string(),
        expires_at: now.saturating_add(ways.code.seconds.saturating_mul(1000)),
        value: Waiting { way: way.way.clone(), purpose: Purpose::SignIn, name: Some(name.clone()), code_hash: Some(code_hash(&id, &code)),
            secret: None, tries: 0, made_at: now, attempt_request_key: Some(attempt_request_key.clone()), delivery: Some(DeliveryOutcome::Pending) },
    };
    issue_attempt(store, previous.as_ref(), &row, ways, channel, &name, Purpose::SignIn, &code, sender)?;
    Ok(name)
}

/// Check a waiting code: a right one is used up; a wrong one counts a try, and the code dies at `code.tries`.
fn take_code(store: &Store<'_>, ways: &WaySettings, account: &str, way: &str, purpose: Purpose, name: Option<&str>, typed: &str)
    -> Result<Row<Waiting>> {
    let id = waiting_id(account, way, purpose);
    let found = store.get::<Waiting>(Family::WayCodes, &id)?.filter(|row| row.account == account);
    let Some(found) = found else {
        return Err(if purpose == Purpose::Add { crate::cause!(Refused::SetupEnded) } else { crate::cause!(Refused::Wrong) });
    };
    if found.value.tries >= ways.code.tries || (name.is_some() && found.value.name.as_deref() != name) {
        return Err(crate::cause!(Refused::Wrong));
    }
    if found.value.delivery == Some(DeliveryOutcome::NotStarted) {
        return Err(crate::cause!(Refused::Wrong));
    }
    let code = digits_of(typed);
    let right = code.len() == ways.code.digits
        && found.value.code_hash.as_deref().is_some_and(|kept| same(kept, &code_hash(&id, &code)));
    if right {
        return match store.take::<Waiting>(Family::WayCodes, &id)? {
            Some(taken) if taken == found => Ok(taken),
            _ => Err(crate::cause!(Refused::Wrong)),
        };
    }
    let mut tried = found.clone();
    tried.value.tries += 1;
    store.replace_if(Family::WayCodes, &found, &tried)?;
    Err(crate::cause!(Refused::Wrong))
}

enum Proven {
    Plain,
    Listed(usize),
    Key(Vec<String>),
}

/// One proof of `way`, checked against what the account holds. `named` asks the typed name to be the way's own (a way
/// checked as another way's `also` is not named again: the first way named the account).
fn prove(store: &Store<'_>, ways: &WaySettings, account: &str, way: &WayRow, form: &Typed, named: bool) -> Result<Proven> {
    let now = now_ms();
    let held = held_way(store, account, &way.way)?;
    let typed_name = match (named, way.named.as_deref()) {
        (true, Some(kind)) => Some(normal_name(ways, kind, typed_name(ways, form, kind)).ok_or(crate::cause!(Refused::NotAName))?),
        _ => None,
    };
    let name_right = |held: &Row<Held>| typed_name.is_none() || held.value.name == typed_name;
    match way.proof {
        Proof::Chosen => {
            let secret = typed(form, SECRET_FIELD);
            let usable = held.as_ref().filter(|held| name_right(held)).and_then(|held| match &held.value.material {
                Material::Chosen { record } => Some(record),
                _ => None,
            });
            let (right, rehash) = chosen_right(ways, usable, secret)?;
            if !right {
                return Err(crate::cause!(Refused::Wrong));
            }
            if let (true, Some(before)) = (rehash, &held) {
                // A key made at an older cost is made again at the current one; losing that race changes nothing.
                let mut after = before.clone();
                after.value.material = Material::Chosen { record: make_password_record(secret, &ways.chosen_policy()?).map_err(|error| Refused::Storage(error.cause()))? };
                store.replace_if(Family::Ways, before, &after)?;
            }
            Ok(Proven::Plain)
        }
        Proof::Sent => {
            let Some(held) = held.filter(|held| name_right(held)) else { return Err(crate::cause!(Refused::Wrong)) };
            take_code(store, ways, account, &way.way, Purpose::SignIn, held.value.name.as_deref(), typed(form, CODE_FIELD))?;
            Ok(Proven::Plain)
        }
        Proof::Timed => {
            let Some(held) = held else { return Err(crate::cause!(Refused::Wrong)) };
            let Material::Timed { secret, last_step } = &held.value.material else { return Err(crate::cause!(Refused::Wrong)) };
            let step = timed_step(ways, secret, typed(form, CODE_FIELD), now, Some(*last_step)).ok_or(crate::cause!(Refused::Wrong))?;
            let mut after = held.clone();
            after.value.material = Material::Timed { secret: secret.clone(), last_step: step };
            if !store.replace_if(Family::Ways, &held, &after)? {
                return Err(crate::cause!(Refused::Wrong));
            }
            Ok(Proven::Plain)
        }
        Proof::Listed => {
            let Some(held) = held else { return Err(crate::cause!(Refused::Wrong)) };
            let Material::Listed { hashes } = &held.value.material else { return Err(crate::cause!(Refused::Wrong)) };
            let code = normal_listed(typed(form, CODE_FIELD));
            if code.chars().count() != ways.listed.groups * ways.listed.group_length {
                return Err(crate::cause!(Refused::Wrong));
            }
            let hash = listed_hash(account, &code);
            let Some(at) = hashes.iter().position(|kept| same(kept, &hash)) else { return Err(crate::cause!(Refused::Wrong)) };
            let mut left = hashes.clone();
            left.remove(at);
            let mut after = held.clone();
            after.value.material = Material::Listed { hashes: left.clone() };
            if !store.replace_if(Family::Ways, &held, &after)? {
                return Err(crate::cause!(Refused::Wrong));
            }
            Ok(Proven::Listed(left.len()))
        }
        Proof::Key => {
            let principal: Option<Principal> = keys::check(store, typed(form, KEY_FIELD).trim())?;
            match principal {
                Some(principal) if principal.account == account => Ok(Proven::Key(principal.scopes)),
                _ => Err(crate::cause!(Refused::Wrong)),
            }
        }
    }
}

/// One sign-in try with `way`: counted first, then the way's `also` proofs (which use nothing up), then its own.
pub(crate) fn sign_in(store: &Store<'_>, ways: &WaySettings, account: &str, way: &WayRow, form: &Typed) -> Result<Opened> {
    count(store, ways, account, &way.way, "try", way.tries, now_ms())?;
    for also in &way.also {
        let also = ways.row(also).ok_or(crate::cause!(Refused::Unknown))?;
        prove(store, ways, account, also, form, false)?;
    }
    match (prove(store, ways, account, way, form, true)?, way.opens) {
        (Proven::Key(scopes), Opens::App) => Ok(Opened::App { scopes }),
        (Proven::Listed(left), Opens::Session) => Ok(Opened::Session { way: way.way.clone(), left: Some(left) }),
        (Proven::Plain, Opens::Session) => Ok(Opened::Session { way: way.way.clone(), left: None }),
        _ => Err(crate::cause!(Refused::Unknown)),
    }
}

// ---- Adding, changing and removing ----

/// Whether a session that started at `started_at` by `method` may add, change or remove ways now.
pub(crate) fn may_change(ways: &WaySettings, method: &str, started_at: u64, now: u64) -> Result<()> {
    if ways.row(method).is_some_and(|row| !row.changes_ways) {
        return Err(crate::cause!(Refused::NotThisSession));
    }
    if now.saturating_sub(started_at) > ways.fresh_seconds.saturating_mul(1000) {
        return Err(crate::cause!(Refused::NotFresh));
    }
    Ok(())
}

fn keep(store: &Store<'_>, account: &str, way: &WayRow, name: Option<String>, material: Material, before: Option<&Row<Held>>) -> Result<()> {
    let now = now_ms();
    let value = Held {
        way: way.way.clone(),
        name,
        material,
        added_at: before.map_or(now, |before| before.value.added_at),
        changed_at: now,
    };
    store.put(Family::Ways, &Row { id: held_id(account, &way.way), account: account.to_string(), expires_at: 0, value })?;
    Ok(())
}

/// Who adds a way, and from where: the account, its address (for a new personal key), the way the session started by,
/// and the account routes' host (what an authenticator app names the account by).
pub(crate) struct Adding<'a> {
    pub account: &'a str,
    pub address: &'a str,
    pub method: &'a str,
    pub issuer: &'a str,
}

/// Add `way`, or change it when it is held, for a session that may change ways (`may_change`, the caller's check). A
/// sent or timed way answers first (`confirm`); the others are held at once.
pub(crate) fn add(store: &Store<'_>, ways: &WaySettings, who: &Adding<'_>, way: &WayRow, form: &Typed, sender: Option<&dyn Deliver>)
    -> Result<Added> {
    let account = who.account;
    for also in &way.also {
        let also_row = ways.row(also).ok_or(crate::cause!(Refused::Unknown))?;
        if !holds(store, account, also_row)? {
            return Err(Refused::NeedsFirst(also.clone(), crate::cause!()));
        }
    }
    let before = held_way(store, account, &way.way)?;
    let now = now_ms();
    match way.proof {
        Proof::Chosen => {
            let secret = typed(form, NEW_SECRET_FIELD);
            chosen_length(ways, secret)?;
            let name = match way.named.as_deref() {
                Some(kind) => Some(normal_name(ways, kind, typed_name(ways, form, kind)).ok_or(crate::cause!(Refused::NotAName))?),
                None => None,
            };
            // A session started by one of the way's recover_with ways sets it anew without the current proof.
            let recovering = way.recover_with.iter().any(|recover| recover == who.method);
            if let (Some(held), true, false) = (&before, way.change_needs_current, recovering) {
                let Material::Chosen { record } = &held.value.material else { return Err(crate::cause!(Refused::Storage)) };
                if !chosen_right(ways, Some(record), typed(form, CURRENT_SECRET_FIELD))?.0 {
                    return Err(crate::cause!(Refused::CurrentWrong));
                }
            }
            let record = make_password_record(secret, &ways.chosen_policy()?).map_err(|error| Refused::Storage(error.cause()))?;
            keep(store, account, way, name.clone(), Material::Chosen { record }, before.as_ref())?;
            Ok(Added::Held(name))
        }
        Proof::Sent => {
            let (Some(kind), Some(channel)) = (way.named.as_deref(), way.channel.as_deref()) else { return Err(crate::cause!(Refused::Unknown)) };
            let name = normal_name(ways, kind, typed_name(ways, form, kind)).ok_or(crate::cause!(Refused::NotAName))?;
            count(store, ways, account, &way.way, "add", way.sends, now)?;
            let id = waiting_id(account, &way.way, Purpose::Add);
            let previous = store.stored::<Waiting>(Family::WayCodes, &id)?.filter(|row| row.account == account);
            if let Some(waiting) = &previous {
                if waiting.expires_at > now && matches!(waiting.value.delivery, None | Some(DeliveryOutcome::Pending | DeliveryOutcome::Unknown)) {
                    return Err(crate::cause!(Refused::DeliveryUnknown));
                }
                if waiting.expires_at > now && waiting.value.tries < ways.code.tries && waiting.value.delivery == Some(DeliveryOutcome::Sent)
                    && now.saturating_sub(waiting.value.made_at) < ways.code.resend_after_seconds.saturating_mul(1000) {
                    return Ok(Added::CodeSent { name });
                }
            }
            let code = new_code(ways);
            let attempt_request_key = random_hex(16);
            let row = Row {
                id: id.clone(),
                account: account.to_string(),
                expires_at: now.saturating_add(ways.code.seconds.saturating_mul(1000)),
                value: Waiting { way: way.way.clone(), purpose: Purpose::Add, name: Some(name.clone()), code_hash: Some(code_hash(&id, &code)),
                    secret: None, tries: 0, made_at: now, attempt_request_key: Some(attempt_request_key.clone()), delivery: Some(DeliveryOutcome::Pending) },
            };
            issue_attempt(store, previous.as_ref(), &row, ways, channel, &name, Purpose::Add, &code, sender)?;
            Ok(Added::CodeSent { name })
        }
        Proof::Timed => {
            let id = waiting_id(account, &way.way, Purpose::Add);
            let secret = match store.get::<Waiting>(Family::WayCodes, &id)?.and_then(|row| row.value.secret) {
                Some(waiting) => waiting,
                None => {
                    let secret = base32(&random_bytes(ways.timed.secret_bytes));
                    let row = Row {
                        id,
                        account: account.to_string(),
                        expires_at: now.saturating_add(ways.setup_seconds.saturating_mul(1000)),
                        value: Waiting { way: way.way.clone(), purpose: Purpose::Add, name: None, code_hash: None, secret: Some(secret.clone()),
                            tries: 0, made_at: now, attempt_request_key: None, delivery: None },
                    };
                    store.put(Family::WayCodes, &row)?;
                    secret
                }
            };
            Ok(Added::Setup { address: timed_address(ways, who.issuer, &secret), key: secret })
        }
        Proof::Listed => {
            let (shown, hashes) = new_listed(ways, account);
            keep(store, account, way, None, Material::Listed { hashes }, before.as_ref())?;
            Ok(Added::Codes(shown))
        }
        Proof::Key => {
            let name = typed(form, KEY_NAME_FIELD);
            let (key, _) = keys::issue(store, account, who.address, name, &contract().scopes, 0).map_err(|error| {
                let cause = error.cause();
                match error {
                    super::Error::InvalidRequest(_, _) => Refused::NotAName(cause),
                    _ => Refused::Storage(cause),
                }
            })?;
            Ok(Added::Key(Zeroizing::new(key)))
        }
    }
}

/// The name an unfinished add of a sent way sent its code to, while it waits.
pub(crate) fn waiting_name(store: &Store<'_>, account: &str, way: &WayRow) -> Result<Option<String>> {
    Ok(store.get::<Waiting>(Family::WayCodes, &waiting_id(account, &way.way, Purpose::Add))?
        .filter(|row| row.account == account).and_then(|row| row.value.name))
}

/// Finish an add that waits for its first right answer (a sent code to the new name, or a timed code from the new
/// secret). The way is held from then on, replacing what it held before.
pub(crate) fn confirm(store: &Store<'_>, ways: &WaySettings, account: &str, way: &WayRow, form: &Typed) -> Result<Option<String>> {
    let before = held_way(store, account, &way.way)?;
    match way.proof {
        Proof::Sent => {
            let taken = take_code(store, ways, account, &way.way, Purpose::Add, None, typed(form, CODE_FIELD))?;
            let name = taken.value.name.ok_or(crate::cause!(Refused::SetupEnded))?;
            keep(store, account, way, Some(name.clone()), Material::Sent, before.as_ref())?;
            Ok(Some(name))
        }
        Proof::Timed => {
            let id = waiting_id(account, &way.way, Purpose::Add);
            let waiting = store.get::<Waiting>(Family::WayCodes, &id)?.filter(|row| row.account == account).ok_or(crate::cause!(Refused::SetupEnded))?;
            let secret = waiting.value.secret.clone().ok_or(crate::cause!(Refused::SetupEnded))?;
            count(store, ways, account, &way.way, "setup", way.tries, now_ms())?;
            let step = timed_step(ways, &secret, typed(form, CODE_FIELD), now_ms(), None).ok_or(crate::cause!(Refused::Wrong))?;
            if store.take::<Waiting>(Family::WayCodes, &id)?.is_none() {
                return Err(crate::cause!(Refused::SetupEnded));
            }
            keep(store, account, way, None, Material::Timed { secret, last_step: step }, before.as_ref())?;
            Ok(None)
        }
        _ => Err(crate::cause!(Refused::Unknown)),
    }
}

/// Remove `way` (for a key way: turn off the key `key_id`). Refused while a held way needs it (`also`), and when it is
/// the last way that keeps the account reachable and the account has no passkey.
pub(crate) fn remove(store: &Store<'_>, ways: &WaySettings, account: &str, way: &WayRow, key_id: Option<&str>, passkeys: usize)
    -> Result<bool> {
    if way.proof == Proof::Key {
        return Ok(keys::turn_off(store, account, key_id.ok_or(crate::cause!(Refused::Unknown))?)?);
    }
    if held_way(store, account, &way.way)?.is_none() {
        return Ok(false);
    }
    let others = held(store, account)?;
    for other in &others {
        if let Some(needing) = ways.row(&other.value.way).filter(|needing| needing.also.contains(&way.way)) {
            return Err(Refused::NeededBy(needing.way.clone(), crate::cause!()));
        }
    }
    let reachable = passkeys > 0
        || others.iter().any(|other| other.value.way != way.way && ways.row(&other.value.way).is_some_and(|row| row.alone));
    if !reachable {
        return Err(crate::cause!(Refused::LastWayIn));
    }
    store.remove(Family::WayCodes, &waiting_id(account, &way.way, Purpose::SignIn))?;
    Ok(store.remove(Family::Ways, &held_id(account, &way.way))?)
}

/// What a listing of the account's ways says of one held way: never its secret, only its name, its dates and, for a
/// listed way, how many codes are left.
pub(crate) fn described(held: &Held) -> Value {
    let left = match &held.material {
        Material::Listed { hashes } => Some(hashes.len()),
        _ => None,
    };
    json!({"way": held.way, "name": held.name, "added_at": held.added_at, "changed_at": held.changed_at, "left": left})
}

/// The ways the tests give an account: the synthetic starting rows src/account/sign_in/new-accounts.json (a computer's config
/// `new_accounts` shape), every way the old sign-in had at its limits.
#[cfg(test)]
pub(crate) fn for_tests() -> WaySettings {
    let rows: super::StartingRows =
        serde_json::from_slice(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/account/sign_in/new-accounts.json")))
            .expect("the starting rows fixture reads");
    assert!(rows.valid());
    rows.sign_in_ways
}

#[cfg(test)]
#[path = "ways_tests.rs"]
mod tests;

/// Sends a sign-up's code through `sender` (a Deliver seam) with the tool and input its DATA names, without an account's
/// delivery row: a new account has none yet. The same receipt rule as `deliver` applies.
pub(crate) fn send_sign_up_code(sender: &dyn Deliver, tool: &str, template: &Map<String, Value>, to: &str, subject: &str, text: &str,
    request_key: &str) -> Result<()> {
    let mut input = template.clone();
    input.insert(DELIVER_TO.into(), json!(to));
    input.insert(DELIVER_KIND.into(), json!(DELIVER_KIND_SIGN_IN_CODE));
    input.insert(DELIVER_SUBJECT.into(), json!(subject));
    input.insert(DELIVER_TEXT.into(), json!(text));
    input.insert(DELIVER_RETRY_KEY.into(), json!(request_key));
    let answer = sender.run(request_key, tool, &Value::Object(input)).map_err(|failure| match failure {
        DeliverFailure::NotStarted(cause) => Refused::NotSent(cause),
        DeliverFailure::OutcomeUnknown(cause) => Refused::DeliveryUnknown(cause),
    })?;
    receipt(&answer)
}

/// The password record a sign-up keeps, made under the starting ways' own policy (old trillion's signUp password).
pub(crate) fn chosen_record(ways: &WaySettings, secret: &str) -> Result<Value> {
    make_password_record(secret, &ways.chosen_policy()?).map_err(|error| Refused::Storage(error.cause()))
}

/// The names a sign-up was given and how it was made, kept as the account's one signup-names row (old trillion's held
/// `trillion.signup-names/v1`, which fills the profile's name fields).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct SignupNames {
    pub given_name: String,
    pub family_name: String,
    pub method: String,
    pub at_ms: u64,
}

/// Keeps a sign-up's names as the account's signup-names row.
pub(crate) fn keep_signup_names(store: &Store<'_>, account: &str, names: SignupNames) -> Result<()> {
    store.put(Family::SignupNames, &Row { id: account.to_string(), account: account.to_string(), expires_at: 0, value: names })?;
    Ok(())
}

/// Writes what a sign-up makes of its new account once its email is confirmed (old trillion's signUp): the password way
/// held as `record`, the email code way held by the address, and the email's delivery tool when the DATA names one.
/// Written only into a new account, after its code matched; nothing is written for an unconfirmed address.
pub(crate) fn seed_sign_up(store: &Store<'_>, ways: &WaySettings, account: &str, record: Value, email: &str,
    delivery: Option<(&str, Map<String, Value>)>) -> Result<()> {
    let password = ways.rows.iter().find(|row| row.way == "password").ok_or(crate::cause!(Refused::Unknown))?;
    let by_email = ways.rows.iter().find(|row| row.way == ways.code_way).ok_or(crate::cause!(Refused::Unknown))?;
    let name = normal_name(ways, "email", email).ok_or(crate::cause!(Refused::NotAName))?;
    keep(store, account, password, Some(name.clone()), Material::Chosen { record }, None)?;
    keep(store, account, by_email, Some(name), Material::Sent, None)?;
    if let (Some((tool, input)), Some(channel)) = (delivery, by_email.channel.as_deref()) {
        set_delivery(store, ways, account, channel, Some(tool), input)?;
    }
    Ok(())
}
