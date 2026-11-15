//! Computers rows: which computers hold a copy of an account or of a pursuit, and which
//! of those may answer for it now. The owner or the team edits them as rows (one
//! row edit, no code). A row is the account's own data: it lives in the account's
//! account rows (`rows/families.json` family `computers`), so it is read and
//! written through the same store as the account rows, and it is signed with the
//! account's own signing key.
//!
//! The account's signing key (`AccountKey`, Ed25519) is made with the account, or
//! at the first start of an account made before signing keys. Its secret is a held
//! value in the account's vault (`signing_key_value`), so it is sealed under the
//! secrets key like every secret; its public key is a row of the account's
//! own (`key_prefix` + the account's user id). The account's address is derived
//! from that public key (`address_of`). Credentials and the forwarder name an account
//! by its address, never by its internal owner id, which stays whatever it was made
//! as: a forwarder that reads the address from a credential checks a key a computer
//! tells against it with nothing stored, and the computer maps the address to the
//! account it holds.
//!
//! A row's fields are `{account, pursuit, revision, copy_keepers, may_answer, signature}`:
//! - `account` is the address of the account the row is for (64 lowercase hex);
//! - `pursuit` is the pursuit's id for a pursuit's own row, absent for the account's row;
//! - `copy_keepers` are the computers that hold a copy, each named by its computer id (64
//!   lowercase hex: a computer's public key, or the device id the account's routes admit
//!   for the hosting app's connection);
//! - `may_answer` are the computers that keep a copy that may answer a request, a subset of `copy_keepers`;
//! - `voters` are the computers the owner names to vote on the writer row (`writer_row.rs`), zero or more, not
//!   necessarily computers that keep a copy; with none, the account has one computer and no writer row is needed;
//! - `revision` orders the rows of one subject: the highest signed revision wins;
//! - `signature` is an Ed25519 signature, hex, over the signed bytes below.
//!
//! Signed bytes, in order: `signed_domain`, the account, the pursuit (empty for the
//! account's row), the revision as 8 big-endian bytes, the sorted computers that keep a copy, the
//! sorted may-answer list, the sorted voters. Each text and each list has a 4-byte big-endian length in
//! front, so no two rows share signed bytes.
//!
//! A computer tells, when its session to a forwarder opens, each account it holds:
//! the account's row and the account's public key (`KeptAccount`). The forwarder
//! believes a row only when the key is the one the address names (`address_of`) and
//! verifies the row (`KeptAccount::believed`).
//!
//! A computer describes only itself, by its report (`ComputerReport`): what storage it
//! has, what it reaches, what it costs, whether it runs contained tools, whether
//! it is on all the time (a report, never required) and whether it takes new
//! accounts. Nothing here says what kind of machine a computer is.
//!
//! Stored values, owned by this file (family `computers`):
//! - `ComputersRow`, id = `account_prefix` + address, or `pursuit_prefix` + pursuit id;
//! - `KeyRow`, id = `key_prefix` + the account's user id: the account's public key.
//!
//! Every number and word is DATA beside this code (`computers/settings.json`).

use crate::refusal_cause::CodedError;
use super::rows::store::{Family, Row, Store};
use super::rows::tokens::owner_text_ok;
use crate::storage::record_store::settings::Budget;
use content_crypto::advanced::blake3;
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair as _, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fmt, sync::OnceLock};

pub mod account_stores;
pub mod writer_row;
pub mod copies;
pub mod copy_rule;
pub(crate) mod rows_copy;
pub(crate) mod placement_repair;
pub(crate) mod limits_row;
#[cfg(test)]
mod membership_tests;
pub mod messages;
pub mod sealed;
/// A test's write of one record into an open copies write (`Copies::write`, `write_in`, `write_vault`), with no term check
/// of its own.
#[cfg(test)]
macro_rules! write_record {
    ($store:expr, $owner:expr, $resource:expr, $mutation:expr) => {
        $store.mutate_local_with_check($owner, $resource, $mutation, || Ok(()))
    };
}
#[cfg(test)]
mod copies_tests;
#[cfg(test)]
mod move_tests;
#[cfg(test)]
mod failover_tests;
#[cfg(test)]
mod hosted_computer_tests;
use zeroize::Zeroizing;

/// What the system principal (the computer acting for its account at the settle path) may write: the operations and the record
/// kinds `system_principal` in computers/settings.json names. Nothing else.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemPrincipal {
    pub resources: Vec<String>,
    pub operations: Vec<String>,
    pub kinds: Vec<String>,
}

/// `scope_classes` in `computers/settings.json`: the names a resource's scope class may take (plan 4a, B-2).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScopeClasses {
    #[serde(rename = "_what")]
    _what: String,
    pub default: String,
    pub names: Vec<String>,
    /// Which class a records resource takes, by the prefix of its store key (`write_in`). A key no prefix names takes
    /// `default`. Plan 4a, B-2: a `crdt-merge` resource commits on any computer and merges by stamps.
    pub resources: Vec<ResourceClass>,
}

/// One `scope_classes.resources` row.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResourceClass {
    pub prefix: String,
    pub class: String,
}

/// A scope class: one of `scope_classes.names`. Built only by `ScopeClass::parse` or `ScopeClass::default_class`, so an
/// unknown class name is never used as a writer row key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopeClass(String);

impl ScopeClass {
    /// The class named `name` when `computers/settings.json` names it.
    pub(crate) fn parse(name: &str) -> Option<ScopeClass> {
        settings().scope_classes.names.iter().any(|known| known == name).then(|| ScopeClass(name.to_string()))
    }

    /// The class a resource takes when its row names none.
    pub(crate) fn default_class() -> ScopeClass {
        ScopeClass(settings().scope_classes.default.clone())
    }

    /// The class name, as DATA spells it.
    pub(crate) fn name(&self) -> &str {
        &self.0
    }

    /// The class of the records store key `key`: the first `scope_classes.resources` row whose prefix it starts with,
    /// else the default class.
    pub(crate) fn of_key(key: &str) -> ScopeClass {
        let scope = &settings().scope_classes;
        scope.resources.iter().find(|row| key.starts_with(&row.prefix)).and_then(|row| ScopeClass::parse(&row.class)).unwrap_or_else(ScopeClass::default_class)
    }

    /// Whether a write of this class commits on any computer and merges later (`crdt-merge`) instead of waiting for the
    /// writer turn and its acknowledgement.
    pub(crate) fn is_crdt_merge(&self) -> bool {
        self.0 == "crdt-merge"
    }
}

/// The settings DATA beside this code.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    #[serde(rename = "_why")]
    _why: String,
    signed_domain: String,
    account_id_context: String,
    pub(crate) computer_id_context: String,
    proof_uses: BTreeMap<String, String>,
    pub system_principal: SystemPrincipal,
    pub computer_proof_window_ms: i64,
    pub account_prefix: String,
    pub pursuit_prefix: String,
    pub key_prefix: String,
    pub writer_row_prefix: String,
    pub scope_classes: ScopeClasses,
    pub term_ms: i64,
    pub renew_every_ms: i64,
    pub joining_retry_max_ms: i64,
    pub idle_release_ms: i64,
    pub clock_margin_ms: i64,
    pub ack_wait_ms: u64,
    pub message_wait_ms: u64,
    pub feed_page_items: usize,
    pub replicated_resources: Vec<String>,
    pub message_operation: String,
    pub http_operation: String,
    pub answered_by_header: String,
    pub message_path: String,
    pub tell_again_path: String,
    pub announce_term_path: String,
    pub message_body_bytes: usize,
    pub carried_bytes: usize,
    pub part_hold_ms: i64,
    pub resend_when_lost: u32,
    pub part_wait_ms: u64,
    pub feed_history_items: usize,
    pub copy_prefix: String,
    pub copied_row: String,
    pub sign_in_page_items: usize,
    /// The first wait after a refused sign-in pull (`Copies::sign_in_follow`); each refusal in a row doubles it, up to the max.
    pub sign_in_pull_retry_base_ms: i64,
    pub sign_in_pull_retry_max_ms: i64,
    /// Refusals in a row that make the pulls of a copy alarm (`computers-join event=sign-in-pull-alarm`, logged once).
    pub sign_in_pull_alarm_after: u32,
    pub admit_ms: i64,
    /// The settle bound of a revocation: once a turned-off key's write is acknowledged by a majority, every copy refuses the key
    /// within this long (a lagging copy admits it until then, and never longer than the session's own expiry).
    pub revocation_settle_ms: i64,
    pub vouch_ms: i64,
    pub signing_key_value: String,
    /// How long a lost writer claim holds the next one back, and the jitter added to it (`copies.rs` `hold_claims`).
    pub claim_backoff_ms: u64,
    pub claim_backoff_jitter_ms: u64,
    /// How long a write that asked for the writer turn waits for the timer to take it (`copies.rs` `await_claim`), and how
    /// often it looks in the meantime.
    pub claim_wait_ms: u64,
    pub claim_poll_ms: u64,
    pub limits: Limits,
    pub pursuit_id_bytes: usize,
    pub max_told_rows: usize,
    pub kept_accounts_max_bytes: usize,
    pub operation_edits_max: usize,
    pub operation_backoff_ms: u64,
    pub this_computer: ComputerReport,
    pub this_computer_sign_in: super::rows::ComputerSignIn,
    pub copy_rule: copy_rule::CopyRuleSettings,
    pub host_kinds: copy_rule::HostKindSettings,
    pub account_stores: account_stores::AccountStoresSettings,
    pub report_sealed_versions: bool,
    pub pending_writes: PendingWrites,
}

/// Work and memory bounds for pending command settle, in the same settings owner.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingWrites {
    pub current_writer_path: String,
    pub entries: usize,
    pub bytes: usize,
    pub page_entries: usize,
    pub incoming_transfers: usize,
    pub incoming_bytes: usize,
    /// Past this age a queued command the writer has not answered completes as refused (`settle_timed_out`), so none blocks the queue.
    pub settle_max_age_ms: i64,
}

/// The one settings value, read from `computers/settings.json` at first use.
pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        let settings: Settings = serde_json::from_slice(include_bytes!("computers/settings.json")).expect("computers/settings.json is valid");
        assert!(settings.this_computer.valid(), "computers/settings.json names a valid report of this computer");
        assert!(["session", "message", "claim", "lookup", "term", "key-check"].iter().all(|name| settings.proof_uses.contains_key(*name)), "computers/settings.json names every proof use");
        assert!(settings.pending_writes.entries > 0 && settings.pending_writes.page_entries > 0
            && settings.pending_writes.incoming_transfers > 0 && settings.pending_writes.bytes > 0
            && settings.pending_writes.incoming_bytes >= settings.message_body_bytes
            && settings.pending_writes.bytes <= settings.carried_bytes, "computers/settings.json bounds pending command work and retained bytes");
        assert!(
            [&settings.limits.computers, &settings.limits.accounts].iter().all(|name| settings.limits.shipped.get(*name).is_some_and(|rows| most_generous(rows).is_some())),
            "computers/settings.json ships a default row for every limit it reads"
        );
        assert!(
            settings.clock_margin_ms >= 0 && settings.renew_every_ms > 0 && settings.renew_every_ms + settings.clock_margin_ms < settings.term_ms && settings.joining_retry_max_ms >= settings.renew_every_ms && settings.sign_in_pull_retry_base_ms > 0 && settings.sign_in_pull_retry_max_ms >= settings.sign_in_pull_retry_base_ms && settings.sign_in_pull_alarm_after > 0,
            "computers/settings.json renews a term before it ends, with the clock margin to spare"
        );
        assert!(settings.scope_classes.resources.iter().all(|row| settings.scope_classes.names.contains(&row.class)), "computers/settings.json names only known scope classes for resources");
        assert!(settings.scope_classes.names.contains(&settings.scope_classes.default), "computers/settings.json names its default scope class among the scope classes");
        assert!(settings.idle_release_ms > settings.term_ms, "computers/settings.json keeps an active account's writer role longer than one term");
        settings
    })
}

/// The limits the engine reads by name from an `access` (`account_policy.access`, the payment fold's projection in
/// old trillion src/payment.mjs:368-408): `access.limits` maps a name to rows, each row a plan's allowance (the offer's
/// `allowances` row less its `access`: `count`, `per`) or a contract's limit (the contract snapshot's `limits` row less
/// its `key`: `quantity`, ...). The shipped rows (`shipped`) are old trillion's numbers and always count; a plan or
/// contract row raises them; the most generous row wins (src/contract-entitlements.mjs `quantityFor`). No row is never
/// unbounded. `most_admitted_computers` is the hard bound on how many computers one computers row names, whatever its plan
/// (Local First Architecture §4.6): a forwarder believes no row naming more, so a plan above it is held to it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Limits {
    /// The limit name of how many computers one computers row of an account may name (computers that keep a copy, and voters).
    pub computers: String,
    /// The limit name of how many accounts one computer holds.
    pub accounts: String,
    /// The shipped default rows, by limit name, in the shape `access.limits` holds them.
    pub shipped: BTreeMap<String, Vec<Value>>,
    pub most_admitted_computers: usize,
    /// The bounds of the account's limits row (`limits_row.rs`).
    pub row: limits_row::RowSettings,
}

/// The number one limit row grants, as old trillion read it (src/contract-entitlements.mjs `quantityLimits`): its
/// positive `usage_limit`, else `quantity`, else `count`. Any other row grants nothing.
pub(crate) fn row_quantity(row: &Value) -> Option<u64> {
    ["usage_limit", "quantity", "count"].iter().find_map(|field| row.get(*field).and_then(Value::as_u64).filter(|n| *n > 0))
}

/// The most generous number among `rows`, when any row grants one.
fn most_generous(rows: &[Value]) -> Option<u64> {
    rows.iter().filter_map(row_quantity).max()
}

/// The account's (or computer's) limit named `name`, read from `access` (`account_policy.access`; anything that is not an
/// object with `limits` holds no rows): the most generous of the shipped rows and the rows `access.limits[name]`
/// holds. Never unbounded: with no row the shipped default stands.
pub(crate) fn access_limit(access: &Value, name: &str) -> usize {
    let granted = access.get("limits").and_then(|limits| limits.get(name)).and_then(Value::as_array);
    let shipped = settings().limits.shipped.get(name).and_then(|rows| most_generous(rows));
    let most = shipped.into_iter().chain(granted.and_then(|rows| most_generous(rows))).max().unwrap_or(0);
    usize::try_from(most).unwrap_or(usize::MAX)
}

/// How many computers one computers row of an account whose access is `access` may name: its `computers` limit, held to the
/// hard bound on computers per row.
pub(crate) fn computers_limit(access: &Value) -> usize {
    access_limit(access, &settings().limits.computers).min(settings().limits.most_admitted_computers)
}

/// How many accounts a computer whose access is `access` (its config's `access`) holds: its `accounts` limit.
pub fn accounts_limit(access: &Value) -> usize {
    access_limit(access, &settings().limits.accounts)
}

/// Ed25519 public keys are 32 bytes.
const PUBLIC_KEY_BYTES: usize = 32;
/// Ed25519 signatures are 64 bytes.
const SIGNATURE_BYTES: usize = 64;

// ---------------------------------------------------------------------------------------------------------------
// The account's signing key and the address it names.

/// The address of the account with `public_key`: BLAKE3 derive_key(`account_id_context`, key), as 64 lowercase hex.
/// `None` for a key of the wrong length.
pub fn address_of(public_key: &[u8]) -> Option<String> {
    (public_key.len() == PUBLIC_KEY_BYTES)
        .then(|| hex_text(&blake3::derive_key(&settings().account_id_context, public_key)))
}

/// An account's signing key (Ed25519). No getter for the secret but `secret_text`, which only the vault keeps; Debug
/// redacted.
pub struct AccountKey {
    pair: Ed25519KeyPair,
    secret: Zeroizing<[u8; 32]>,
}

impl fmt::Debug for AccountKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "AccountKey({})", self.public_hex())
    }
}

impl AccountKey {
    /// A fresh key from the operating system's random source.
    pub fn generate() -> std::result::Result<Self, CodedError<&'static str>> {
        let mut secret = Zeroizing::new([0u8; 32]);
        SystemRandom::new().fill(secret.as_mut()).map_err(|_| CodedError::new("the operating system's random source did not answer"))?;
        Self::from_secret(secret)
    }

    fn from_secret(secret: Zeroizing<[u8; 32]>) -> std::result::Result<Self, CodedError<&'static str>> {
        let pair = Ed25519KeyPair::from_seed_unchecked(secret.as_ref()).map_err(|_| CodedError::new("the signing key is refused"))?;
        Ok(Self { pair, secret })
    }

    /// The key from its kept text (64 lowercase hex, `secret_text`).
    pub fn from_secret_text(text: &str) -> std::result::Result<Self, CodedError<&'static str>> {
        let bytes = Zeroizing::new(hex_bytes(text.trim()).filter(|bytes| bytes.len() == 32).ok_or(CodedError::new("the signing key is not 64 hex"))?);
        let mut secret = Zeroizing::new([0u8; 32]);
        secret.copy_from_slice(&bytes);
        Self::from_secret(secret)
    }

    /// The text the vault keeps: the secret as 64 lowercase hex.
    pub fn secret_text(&self) -> Zeroizing<String> {
        Zeroizing::new(hex_text(self.secret.as_ref()))
    }

    /// The public key, 32 bytes.
    pub fn public_key(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    /// The public key as 64 lowercase hex.
    pub fn public_hex(&self) -> String {
        hex_text(self.public_key())
    }

    /// The address this key names (`address_of`).
    pub fn address(&self) -> String {
        address_of(self.public_key()).expect("an Ed25519 public key is 32 bytes")
    }

    /// Sign `bytes` with the account's key, hex. A row of another owner (`forwarder/origins.rs`) starts its bytes
    /// with its own signed domain, so no signature made for one purpose verifies for another.
    pub(crate) fn sign(&self, bytes: &[u8]) -> String {
        hex_text(self.pair.sign(bytes).as_ref())
    }
}

/// The account's signing key as its vault keeps it: read. The vault seals it under the secrets key (src/secrets.rs), so only
/// a computer that keeps a copy of that root opens it. A vault that holds no key yet refuses (`signing-key-not-kept-yet`):
/// only account creation makes a key (`make_account_key`). A copy that cannot see the key yet waits for it to arrive through
/// sync, and never makes one of its own, because a second key would fork the account's identity.
pub const SIGNING_KEY_NOT_KEPT: &str = "signing-key-not-kept-yet";

pub fn kept_account_key<S: crate::storage::Storage + Send>(vault: &crate::secrets::Secrets<S>) -> std::result::Result<AccountKey, CodedError<&'static str>> {
    let name = &settings().signing_key_value;
    let held = vault.holds(name).map_err(|error| CodedError::with_cause("the vault did not answer for the signing key", error.cause()))?;
    if !held {
        return Err(CodedError::new(SIGNING_KEY_NOT_KEPT));
    }
    let text = vault.plain(name).map_err(|error| CodedError::with_cause("the vault did not open the signing key", error.cause()))?;
    AccountKey::from_secret_text(&text)
}

/// The account's public key as its own row says it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KeyRow {
    pub public_key: String,
}

/// Keep `key`'s public key as the account's own row (`key_prefix` + the account's user id `account`). A row that names
/// another key is not replaced: the account has one signing key, and a different one signs nothing for it.
pub(crate) fn keep_public_key(store: &Store<'_>, account: &str, key: &AccountKey) -> Result<()> {
    let row = Row {
        id: format!("{}{account}", settings().key_prefix),
        account: account.to_string(),
        expires_at: 0,
        value: KeyRow { public_key: key.public_hex() },
    };
    match store.get::<KeyRow>(Family::Computers, &row.id).map_err(|error| Refused::Storage(error.cause()))? {
        Some(kept) if kept.value == row.value => Ok(()),
        Some(_) => Err(crate::cause!(Refused::NoKey)),
        None => store.insert(Family::Computers, &row).map_err(|error| Refused::Storage(error.cause())),
    }
}

/// The public key of the account whose user id is `account`, as its own row keeps it, or `None`.
pub(crate) fn public_key(store: &Store<'_>, account: &str) -> Result<Option<Vec<u8>>> {
    let row = store.get::<KeyRow>(Family::Computers, &format!("{}{account}", settings().key_prefix)).map_err(|error| Refused::Storage(error.cause()))?;
    Ok(row.and_then(|row| hex_bytes(&row.value.public_key)).filter(|bytes| bytes.len() == PUBLIC_KEY_BYTES))
}

// ---------------------------------------------------------------------------------------------------------------
// The computer's own signing key and the proof it gives a forwarder.

/// A computer's own signing key, derived from its computer key (src/secrets/root.rs). Its public key, as 64 lowercase
/// hex, is the computer's id in every computers row.
pub struct ComputerSigner(AccountKey);

impl fmt::Debug for ComputerSigner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ComputerSigner({})", self.computer_id())
    }
}

impl ComputerSigner {
    /// The computer's signing key from its computer key.
    pub fn of(computer: &crate::secrets::secrets_key::ComputerKey) -> std::result::Result<Self, CodedError<&'static str>> {
        AccountKey::from_secret(computer.derive(&settings().computer_id_context)).map(Self)
    }

    /// The computer's id: its public key, 64 lowercase hex.
    pub fn computer_id(&self) -> String {
        self.0.public_hex()
    }

    /// The credential a computer sends when it opens a session to a forwarder for `account` at `now_ms`:
    /// `trp_<computer id>_<account>_<now_ms>_<signature>`, the signature over `computer_proof_domain`, the account and the
    /// time. It names no secret; it holds for `computer_proof_window_ms` around `now_ms`.
    pub fn session_credential(&self, account: &str, now_ms: i64) -> String {
        self.credential("session", account, now_ms)
    }

    /// The proof a computer sends with a message it posts to the forwarder for `account` at `now_ms` (another computer's
    /// message, a told row, an origins row, its report): the same text as `session_credential`, signed over
    /// the `message` use's domain instead. The forwarder hands a message's proof on to the computer it is for, which
    /// checks it again; signed for messages, that proof never opens a session (`read_computer_credential` refuses it),
    /// so a computer that receives it cannot open a session as its sender and take its session's calls.
    pub fn message_credential(&self, account: &str, now_ms: i64) -> String {
        self.credential("message", account, now_ms)
    }

    /// The signature this computer makes for `use_name` (a `proof_uses` row) over `parts` at `now_ms`, as hex; None for a
    /// use the settings do not name. The claim route binds its body this way; a session or message proof is this with one part.
    pub fn sign_use(&self, use_name: &str, parts: &[&str], now_ms: i64) -> Option<String> {
        Some(self.0.sign(&proof_bytes(use_name, parts, now_ms)?))
    }

    fn credential(&self, use_name: &str, account: &str, now_ms: i64) -> String {
        let signature = self.sign_use(use_name, &[account], now_ms).expect("the session and message uses are named in computers/settings.json");
        format!("{COMPUTER_PROOF_PREFIX}{}_{account}_{now_ms}_{signature}", self.computer_id())
    }
}

/// The start of a computer's session credential.
pub const COMPUTER_PROOF_PREFIX: &str = "trp_";

/// The bytes a computer's signature covers for `use_name`: the use's domain, then each part, then the time, each text
/// length-prefixed. None for a use `proof_uses` does not name. A use's domain keeps its signatures apart from every other use's.
fn proof_bytes(use_name: &str, parts: &[&str], now_ms: i64) -> Option<Vec<u8>> {
    let domain = settings().proof_uses.get(use_name)?;
    let mut bytes = Vec::new();
    push_text(&mut bytes, domain);
    for part in parts {
        push_text(&mut bytes, part);
    }
    bytes.extend_from_slice(&now_ms.to_be_bytes());
    Some(bytes)
}

/// Whether `signature` (hex) is `computer`'s signature for `use_name` over `parts` at `at`, with `at` within the proof
/// window of `now_ms`. Any other use, part or time is refused.
pub fn verify_use(use_name: &str, computer: &str, parts: &[&str], at: i64, now_ms: i64, signature: &str) -> bool {
    if now_ms <= 0 || at <= 0 || (now_ms - at).abs() > settings().computer_proof_window_ms {
        return false;
    }
    let (Some(public), Some(bytes), Some(signature)) = (hex_bytes(computer), proof_bytes(use_name, parts, at), hex_bytes(signature).filter(|bytes| bytes.len() == SIGNATURE_BYTES)) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, &public).verify(&bytes, &signature).is_ok()
}

/// The parts a command's proof binds: who the command is for, the record write it makes, its request identity, its source
/// generation and a digest of its input. Changing any one of them changes the bytes the computer signed.
pub fn command_parts(owner: &str, resource: &str, operation: &str, request_key: &str, generation: i64, input: &serde_json::Value) -> Vec<String> {
    let input_digest = blake3::hash(&serde_json::to_vec(input).unwrap_or_default()).to_hex().to_string();
    vec![owner.into(), resource.into(), operation.into(), request_key.into(), generation.to_string(), input_digest]
}

/// The start of a command's system credential: the computer acting for its account at the settle path.
pub const COMMAND_PROOF_PREFIX: &str = "trc_";

/// What a system principal may do: a write to one of the `system_principal` DATA resources (the stores the principal may write, such as the held values), of an operation that list
/// names, whose every record is of a kind that list names. A write with no records, or to any other resource, is refused.
/// Whether the `system_principal` DATA lets a system principal make `operation` at all (its record kinds are checked by `system_permits`).
pub fn system_operation(operation: &str) -> bool {
    settings().system_principal.operations.iter().any(|named| named == operation)
}

pub fn system_permits(resource: &str, operation: &str, input: &serde_json::Value) -> bool {
    let list = &settings().system_principal;
    if !list.resources.iter().any(|named| named == resource) || !list.operations.iter().any(|named| named == operation) {
        return false;
    }
    if crate::secrets::queued_held_operation(operation) {
        return sealed_put_input(input);
    }
    let Some(records) = input.get("records").and_then(serde_json::Value::as_array) else { return false };
    !records.is_empty() && records.iter().all(|record| {
        record.get("type").and_then(serde_json::Value::as_str).is_some_and(|kind| list.kinds.iter().any(|named| named == kind))
    })
}

/// The input of a queued put (`Secrets::put_as` at a computer that is not the writer): its sealed bytes, base64, and no other field.
/// The bytes are bounded by `secrets_key::MOST_SEALED_BYTES`, so a command never carries more than a computer accepts.
fn sealed_put_input(input: &serde_json::Value) -> bool {
    use base64::Engine as _;
    let Some(fields) = input.as_object() else { return false };
    fields.len() == 1
        && fields.get("sealed").and_then(serde_json::Value::as_str)
            .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
            .is_some_and(|bytes| bytes.len() <= crate::secrets::secrets_key::MOST_SEALED_BYTES)
}

/// The system credential a computer makes for one command: `trc_<computer>_<at>_<signature>`, the signature over the command's
/// parts (`command_parts`) at `now_ms`. Only a computer the account's computers row names can make one that verifies.
pub fn command_credential(signer: &ComputerSigner, parts: &[&str], now_ms: i64) -> Option<String> {
    let signature = signer.sign_use("command", parts, now_ms)?;
    Some(format!("{COMMAND_PROOF_PREFIX}{}_{now_ms}_{signature}", signer.computer_id()))
}

/// The computer, time and signature a system credential carries, if the text is one (its signature is checked by `verify_use`).
pub fn read_command_credential(text: &str) -> Option<(String, i64, String)> {
    let rest = text.strip_prefix(COMMAND_PROOF_PREFIX)?;
    let mut parts = rest.split('_');
    let (computer, at, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !owner_text_ok(computer) || at.is_empty() || at.len() > 16 || !at.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((computer.to_string(), at.parse().ok()?, signature.to_string()))
}

/// What a forwarder reads from a computer's session credential once its signature checks: the computer id, the account it
/// opens a session for, and the time it signed. `None` for any other text, a bad signature, or a time further than
/// `computer_proof_window_ms` from `now_ms`.
pub fn read_computer_credential(text: &str, now_ms: i64) -> Option<(String, String, i64)> {
    read_proof("session", text, now_ms)
}

/// `read_computer_credential` for the proof of one message a computer posts (`ComputerSigner::message_credential`). A
/// session credential is refused here, as a message proof is refused there.
pub fn read_computer_message_credential(text: &str, now_ms: i64) -> Option<(String, String, i64)> {
    read_proof("message", text, now_ms)
}

fn read_proof(use_name: &str, text: &str, now_ms: i64) -> Option<(String, String, i64)> {
    let rest = text.strip_prefix(COMPUTER_PROOF_PREFIX)?;
    let mut parts = rest.split('_');
    let (computer, account, at, signature) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !owner_text_ok(computer) || !owner_text_ok(account) {
        return None;
    }
    if at.is_empty() || at.len() > 16 || !at.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let at: i64 = at.parse().ok()?;
    if now_ms <= 0 || at <= 0 || (now_ms - at).abs() > settings().computer_proof_window_ms {
        return None;
    }
    let signature = hex_bytes(signature).filter(|bytes| bytes.len() == SIGNATURE_BYTES)?;
    let public = hex_bytes(computer)?;
    UnparsedPublicKey::new(&ED25519, &public).verify(&proof_bytes(use_name, &[account], at)?, &signature).ok()?;
    Some((computer.to_string(), account.to_string(), at))
}

// ---------------------------------------------------------------------------------------------------------------
// The report a computer gives of itself.

/// What a computer reports about itself. It is the only thing the engine knows about a computer.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct ComputerReport {
    /// How large the computer lets a store of its own grow: the same budget shape the record store store reads.
    pub storage: Budget,
    /// The address the computer can be reached at. `not published` until the computer names one.
    #[serde(default = "not_published")]
    pub reach: String,
    /// What the computer costs to keep running, in cents a month.
    pub cost_per_month_cents: u64,
    /// Whether the computer can run tools with network containment.
    pub contained_tools: bool,
    /// Whether the computer is on all the time. A report only: no rule requires it.
    #[serde(default)]
    pub always_on: Option<bool>,
    /// The local ports this computer serves on itself, each a name a tool row may list in `invoke.local_doors` and the
    /// loopback port it listens on (1 to 65535). The computer reports them about itself; none is shipped. A computer
    /// reports none by default, and a run that names one it does not report is refused.
    #[serde(default)]
    pub local_ports: BTreeMap<String, u16>,
    /// The absolute folders on this computer where programs a tool names are found besides the system's own program
    /// folders (`program_search` in src/tool_runs/tools/tool-runs.json), tried in this order. A computer that reports none has none.
    #[serde(default)]
    pub program_folders: Vec<String>,
    /// Whether the computer takes new accounts, so a sign-up may land on it. Absent: it does not.
    #[serde(default)]
    pub takes_new_accounts: bool,
    /// The seal formats this computer can open (`sealed.rs` `opened_versions`). Absent until the computer writes it.
    #[serde(default)]
    pub sealed_versions: Option<Vec<u32>>,
    /// The computer's own store size row (src/storage/record_store/store_size.rs `SizeRow`: `limit_bytes` and its levels), when it
    /// gives one; a computer that gives none runs its stores under the shipped default row (old trillion's numbers). An
    /// account's plan or contract row wins over it (`store_size::resolve`).
    #[serde(default)]
    pub store_size: Option<serde_json::Value>,
    /// Keys this engine does not know: kept, logged once when the config is checked, never refused.
    #[serde(flatten)]
    pub unknown_keys: UnknownKeys,
}

/// The keys of a computer's config files this engine does not know (each file's struct's `unknown_keys`).
pub type UnknownKeys = BTreeMap<String, serde_json::Value>;

/// The reach a computer reports until it names one.
fn not_published() -> String {
    "not published".to_owned()
}

impl ComputerReport {
    /// The report in `bytes`, when it is a valid report. Bad values refuse the whole report; unknown keys do not.
    pub fn parse(bytes: &[u8]) -> Option<ComputerReport> {
        let report: ComputerReport = serde_json::from_slice(bytes).ok()?;
        report.valid().then_some(report)
    }

    pub(crate) fn valid(&self) -> bool {
        let budget_ok = match self.storage {
            Budget::Bytes(bytes) => bytes > 0,
            Budget::KeepFreeBytes(_) => true,
        };
        budget_ok
            && self.store_size.as_ref().is_none_or(|row| crate::storage::record_store::store_size::SizeRow::parse(row).is_some())
            && !self.reach.is_empty()
            && self.reach.len() <= 512
            && !self.reach.chars().any(char::is_control)
            && self.local_ports.len() <= MOST_LOCAL_PORTS
            && self.local_ports.iter().all(|(name, port)| *port != 0 && single_port_name(name))
            && self.program_folders.len() <= MOST_PROGRAM_FOLDERS
            && self.program_folders.iter().all(|folder| {
                folder.len() <= 512
                    && folder.starts_with('/')
                    && !folder.contains('\0')
                    && !folder.split('/').any(|part| part == ".." || part == ".")
            })
    }

    /// The computer's own store size row, when it gives a valid one.
    pub fn store_size_row(&self) -> Option<crate::storage::record_store::store_size::SizeRow> {
        self.store_size.as_ref().and_then(crate::storage::record_store::store_size::SizeRow::parse)
    }

    /// The local port `name`, when this computer reports one.
    pub fn local_port(&self, name: &str) -> Option<u16> {
        self.local_ports.get(name).copied().filter(|port| *port != 0)
    }
}

/// The hosting app's own report, as its launcher's product settings declare it (section `hosting_app_report`,
/// src/account_files/identity.json): `None` when they declare none, or when it is not a valid report.
pub fn hosting_app_report() -> Option<ComputerReport> {
    report_over_defaults(crate::account_files::identity::section("hosting_app_report").ok()??)
}

/// The report the launcher declared, with each field it leaves out taken from this engine's shipped report
/// (`settings().this_computer`). A declared field always wins; a report with a bad value still refuses whole.
fn report_over_defaults(declared: &serde_json::Value) -> Option<ComputerReport> {
    let mut report = serde_json::to_value(&settings().this_computer).ok()?;
    let (serde_json::Value::Object(base), serde_json::Value::Object(declared)) = (&mut report, declared) else { return None };
    base.extend(declared.iter().map(|(key, value)| (key.clone(), value.clone())));
    ComputerReport::parse(report.to_string().as_bytes())
}

/// The most local ports a computer may report.
const MOST_LOCAL_PORTS: usize = 16;

/// Whether `name` may name a local port: 1 to 64 lowercase letters, digits and `-`.
fn single_port_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The most program folders a computer may report.
const MOST_PROGRAM_FOLDERS: usize = 16;

static CHOSEN_REPORT: OnceLock<ComputerReport> = OnceLock::new();

/// Take `report` as this computer's own report for the rest of the process (the computer config's `report`). Only the first
/// choice counts; a second one, or an invalid report, is refused.
pub fn choose_this_computer(report: ComputerReport) -> std::result::Result<(), CodedError<&'static str>> {
    if !report.valid() {
        return Err(CodedError::new("the computer report is refused"));
    }
    CHOSEN_REPORT.set(report).map_err(|_| CodedError::new("this computer's report is already chosen"))
}

/// The report this engine gives of the computer it runs as: the one chosen at start, or the settings' default.
pub fn this_computer() -> &'static ComputerReport {
    CHOSEN_REPORT.get().unwrap_or(&settings().this_computer)
}

// ---------------------------------------------------------------------------------------------------------------
// The signed row.

/// Why a computers change is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// The input is not a valid computers change.
    Invalid(crate::refusal_cause::Cause),
    /// The row moved on (another edit or a sign-up) since the revision the caller read.
    Stale(crate::refusal_cause::Cause),
    /// No computer can take the new account.
    NoComputer(crate::refusal_cause::Cause),
    /// The account's signing key is not open here, so no row can be signed.
    NoKey(crate::refusal_cause::Cause),
    /// The row would name more computers than the account's `computers` limit allows (`computers_limit`: its plan's and
    /// contracts' rows in `account_policy.access.limits`, or the shipped default).
    OverLimit(crate::refusal_cause::Cause),
    /// The row would let two or more computers answer with no voters: with no writer row each of them writes as the one
    /// computer, so two computers would write the same account (`computers_no_writer_row`). Name the voters first.
    NoWriterRow(crate::refusal_cause::Cause),
    /// The sign-in storage did not answer.
    Storage(crate::refusal_cause::Cause),
    /// The computer's host kind does not allow it to answer for the account (`host_kinds`): a computer of a kind that holds
    /// ciphertext only is never named as answering.
    HostKind(crate::refusal_cause::Cause),
    /// The computer named is not heard from: it has not reported to this computer, so it is not admitted (plan I-1).
    Unheard(crate::refusal_cause::Cause),
    /// A new voter is named while fewer than a majority of the voters are caught up (plan I-1, claim completeness).
    NoMajority(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Stale(cause) => cause.clone(),
            Self::NoComputer(cause) => cause.clone(),
            Self::NoKey(cause) => cause.clone(),
            Self::OverLimit(cause) => cause.clone(),
            Self::NoWriterRow(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
            Self::HostKind(cause) => cause.clone(),
            Self::Unheard(cause) => cause.clone(),
            Self::NoMajority(cause) => cause.clone(),
        }
    }
}
impl PartialEq for Refused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Invalid(_), Self::Invalid(_)) => true,
            (Self::Stale(_), Self::Stale(_)) => true,
            (Self::NoComputer(_), Self::NoComputer(_)) => true,
            (Self::NoKey(_), Self::NoKey(_)) => true,
            (Self::OverLimit(_), Self::OverLimit(_)) => true,
            (Self::NoWriterRow(_), Self::NoWriterRow(_)) => true,
            (Self::HostKind(_), Self::HostKind(_)) => true,
            (Self::Unheard(_), Self::Unheard(_)) => true,
            (Self::NoMajority(_), Self::NoMajority(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


pub(crate) type Result<T> = std::result::Result<T, Refused>;

/// Whose row: the account (its address) or one pursuit of it (its id, as the pursuit record names it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Subject {
    Account(String),
    Pursuit { address: String, pursuit: String },
}

impl Subject {
    /// The subject a request names: the account's own row, or the pursuit's when `pursuit` is given.
    pub(crate) fn of(address: &str, pursuit: Option<&str>) -> Result<Subject> {
        match pursuit {
            None => Ok(Subject::Account(address.to_string())),
            Some(id) if pursuit_ok(id) => Ok(Subject::Pursuit { address: address.to_string(), pursuit: id.to_string() }),
            Some(_) => Err(crate::cause!(Refused::Invalid)),
        }
    }

    /// The row id of this subject.
    pub(crate) fn row_id(&self) -> String {
        match self {
            Subject::Account(address) => format!("{}{address}", settings().account_prefix),
            Subject::Pursuit { pursuit, .. } => format!("{}{pursuit}", settings().pursuit_prefix),
        }
    }

    fn address(&self) -> &str {
        match self {
            Subject::Account(address) | Subject::Pursuit { address, .. } => address,
        }
    }

    fn pursuit(&self) -> Option<&str> {
        match self {
            Subject::Account(_) => None,
            Subject::Pursuit { pursuit, .. } => Some(pursuit),
        }
    }
}

fn pursuit_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= settings().pursuit_id_bytes && !id.chars().any(char::is_control)
}

/// One computers row, as the account signed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComputersRow {
    pub account: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pursuit: Option<String>,
    pub revision: u64,
    #[serde(rename = "holders")] pub copy_keepers: Vec<String>,
    #[serde(rename = "answering")] pub may_answer: Vec<String>,
    pub voters: Vec<String>,
    pub signature: String,
}

impl ComputersRow {
    /// The account's own row for `account` at `revision`, signed with the account's `key`. The lists are sorted here;
    /// a repeated computer is refused.
    pub fn sign(account: &str, revision: u64, copy_keepers: &[String], may_answer: &[String], key: &AccountKey)
        -> std::result::Result<Self, CodedError<&'static str>> {
        Self::sign_for(account, None, revision, copy_keepers, may_answer, &[], key)
    }

    /// The account's own row with `voters` named as well (see `writer_row.rs`).
    pub fn sign_with_voters(account: &str, revision: u64, copy_keepers: &[String], may_answer: &[String], voters: &[String], key: &AccountKey)
        -> std::result::Result<Self, CodedError<&'static str>> {
        Self::sign_for(account, None, revision, copy_keepers, may_answer, voters, key)
    }

    fn sign_for(account: &str, pursuit: Option<&str>, revision: u64, copy_keepers: &[String], may_answer: &[String], voters: &[String], key: &AccountKey)
        -> std::result::Result<Self, CodedError<&'static str>> {
        let mut row = ComputersRow {
            account: account.to_string(),
            pursuit: pursuit.map(str::to_string),
            revision,
            copy_keepers: canonical(copy_keepers)?,
            may_answer: canonical(may_answer)?,
            voters: canonical(voters)?,
            signature: String::new(),
        };
        if !row.shape_ok(settings().limits.most_admitted_computers) {
            return Err(CodedError::new("computers row refused"));
        }
        row.signature = key.sign(&row.signed_bytes());
        Ok(row)
    }

    /// Whether `public_key` signed exactly this row. An unsigned row, a row another key signed, a changed field or a
    /// row in the wrong shape is refused.
    /// A row is checked against the hard bound on computers per row only (`most_admitted_computers`): a forwarder has no account's plan
    /// to read, and a row a plan let an account write stays readable once that plan ends.
    pub fn verify(&self, public_key: &[u8]) -> bool {
        if !self.shape_ok(settings().limits.most_admitted_computers) || public_key.len() != PUBLIC_KEY_BYTES {
            return false;
        }
        let Some(signature) = hex_bytes(&self.signature).filter(|bytes| bytes.len() == SIGNATURE_BYTES) else {
            return false;
        };
        UnparsedPublicKey::new(&ED25519, public_key).verify(&self.signed_bytes(), &signature).is_ok()
    }

    /// Whether this row's shape is one a signature may cover: an address, a pursuit id when given, a revision of 1 or
    /// more, one to `most` computers that keep a copy (each 64 lowercase hex), at most `most` voters, sorted and unique lists, and
    /// may-answer computers among computers that keep a copy. `most` is the account's `computers` limit where the row is edited (`edit`), and the
    /// hard bound on computers per row where a row is only read.
    fn shape_ok(&self, most: usize) -> bool {
        owner_text_ok(&self.account)
            && self.pursuit.as_deref().is_none_or(pursuit_ok)
            && self.revision >= 1
            && self.revision < 1 << 53
            && (1..=most).contains(&self.copy_keepers.len())
            && self.may_answer.len() <= self.copy_keepers.len()
            && self.copy_keepers.iter().all(|computer| owner_text_ok(computer))
            && sorted_unique(&self.copy_keepers)
            && sorted_unique(&self.may_answer)
            && self.may_answer.iter().all(|computer| self.copy_keepers.binary_search(computer).is_ok())
            && self.voters.len() <= most
            && self.voters.iter().all(|computer| owner_text_ok(computer))
            && sorted_unique(&self.voters)
    }

    fn signed_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        push_text(&mut bytes, &settings().signed_domain);
        push_text(&mut bytes, &self.account);
        push_text(&mut bytes, self.pursuit.as_deref().unwrap_or(""));
        bytes.extend_from_slice(&self.revision.to_be_bytes());
        push_list(&mut bytes, &self.copy_keepers);
        push_list(&mut bytes, &self.may_answer);
        push_list(&mut bytes, &self.voters);
        bytes
    }
}

/// One account a computer holds, as it tells it to a forwarder: the account's own row and the account's public key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeptAccount {
    pub row: ComputersRow,
    pub account_key: String,
}

impl KeptAccount {
    /// Whether a forwarder may believe this row for the account at `address`: it is the account's own row (no pursuit),
    /// the told key is the key `address` names (`address_of`), and that key signed the row. Nothing stored is
    /// asked.
    pub fn believed(&self, address: &str) -> bool {
        let Some(public) = hex_bytes(&self.account_key) else { return false };
        self.row.account == address
            && self.row.pursuit.is_none()
            && address_of(&public).as_deref() == Some(address)
            && self.row.verify(&public)
    }

    /// This row as a log line names it for `computer`: the account, its revision, the computers it names as may-answer, and
    /// whether `computer` is one of them (what the forwarder routes by). Ids and revisions only.
    pub fn log_words(&self, computer: &str) -> String {
        format!(" row={}:{} may_answer=[{}] answers={}", self.row.account, self.row.revision, self.row.may_answer.join(","),
            if self.row.may_answer.iter().any(|named| named == computer) { "yes" } else { "no" })
    }
}

/// The bytes a computer sends when its session opens: the accounts it tells, at most `max_told_rows`.
pub fn kept_accounts_bytes(rows: &[KeptAccount]) -> Option<Vec<u8>> {
    kept_accounts_bytes_catching_up(rows, &[])
}

/// The bytes a computer sends when its session opens, naming in `catching_up` the accounts (by address) it holds but does
/// not answer yet: it has not caught up with the account's writer (it joins, holds no root, does not vote yet, or its
/// account rows do not match the writer's yet). The forwarder sends such an account's calls to another live computer the
/// row lets answer, the writer first, and never to this one until it tells it answers (`messages::TellAgain`).
pub fn kept_accounts_bytes_catching_up(rows: &[KeptAccount], catching_up: &[String]) -> Option<Vec<u8>> {
    if rows.len() > settings().max_told_rows || catching_up.len() > settings().max_told_rows {
        return None;
    }
    serde_json::to_vec(&KeptAccounts { rows: rows.to_vec(), catching_up: catching_up.to_vec() }).ok()
}

/// The accounts a computer told. Malformed bytes, or more rows than `max_told_rows`, give `None`. Nothing is
/// believed here; the forwarder checks each one (`KeptAccount::believed`).
pub fn read_kept_accounts(bytes: &[u8]) -> Option<Vec<KeptAccount>> {
    read_kept_accounts_catching_up(bytes).map(|(rows, _)| rows)
}

/// The accounts a computer told, and the addresses of those it does not answer yet
/// (`kept_accounts_bytes_catching_up`).
pub fn read_kept_accounts_catching_up(bytes: &[u8]) -> Option<(Vec<KeptAccount>, Vec<String>)> {
    let kept_accounts: KeptAccounts = serde_json::from_slice(bytes).ok()?;
    let limit = settings().max_told_rows;
    (kept_accounts.rows.len() <= limit && kept_accounts.catching_up.len() <= limit)
        .then_some((kept_accounts.rows, kept_accounts.catching_up))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeptAccounts {
    rows: Vec<KeptAccount>,
    /// The told accounts this computer does not answer yet (none: it answers every one).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    catching_up: Vec<String>,
}

// ---------------------------------------------------------------------------------------------------------------
// The rows in the account's own store.

/// One edit: the revision the caller read, and the new lists. `pursuit` names a pursuit's row; none is the account's.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Change {
    #[serde(default)]
    pub pursuit: Option<String>,
    /// Zero when the row does not exist yet; else the revision the caller read.
    pub expected_revision: u64,
    #[serde(rename = "holders")] pub copy_keepers: Vec<String>,
    #[serde(rename = "answering")] pub may_answer: Vec<String>,
    /// The computers that vote on the writer row. Empty is a one-computer account.
    #[serde(default)]
    pub voters: Vec<String>,
}

/// The read input: which row (none is the account's own).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    #[serde(default)]
    pub pursuit: Option<String>,
}

/// The computers row of `subject` now, when the public key of the account (user id `account`, its own key row) verifies
/// it; `None` when no row is kept, or when the kept row no longer verifies.
pub(crate) fn read(store: &Store<'_>, account: &str, subject: &Subject) -> Result<Option<Row<ComputersRow>>> {
    let Some(public) = public_key(store, account)? else { return Ok(None) };
    let row = store.get::<ComputersRow>(Family::Computers, &subject.row_id()).map_err(|error| Refused::Storage(error.cause()))?;
    Ok(row.filter(|row| {
        row.value.account == subject.address() && row.value.pursuit.as_deref() == subject.pursuit() && row.value.verify(&public)
    }))
}

/// The account's own computers row with its public key, as the account's account rows `raw` keep them (its key row and its
/// row, user id `account`), verified with that key: what a computer tells and starts copies from before it can open
/// the account's vault (a computer that joins an account, or that only holds a copy of it). `None` when either row is
/// missing or the row does not verify.
pub(crate) fn kept_row(raw: &dyn crate::storage::Storage, account: &str) -> Option<KeptAccount> {
    let store = Store::new(raw);
    let public = public_key(&store, account).ok().flatten()?;
    let address = address_of(&public)?;
    let row = read(&store, account, &Subject::Account(address)).ok().flatten()?;
    let account_key: String = public.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(KeptAccount { row: row.value, account_key })
}

/// Replace the row of `subject` with `change`, signed with the account's `key`, when its revision is still the one the
/// caller read. The row is replaced in one compare-and-set on its stored value, so a second editor or a sign-up that
/// landed first refuses the change. The new row's revision is one more than the stored one.
///
/// `access` is the account's own `account_policy.access` (Null when the computer reads none): how many computers the row may
/// name is its `computers` limit (`computers_limit`), the shipped default raised by its plan or contract.
pub(crate) fn edit(store: &Store<'_>, account: &str, subject: &Subject, change: &Change, key: &AccountKey, access: &Value)
    -> Result<Row<ComputersRow>> {
    if key.address() != subject.address() {
        return Err(crate::cause!(Refused::NoKey));
    }
    if change.expected_revision >= 1 << 53 || change.copy_keepers.is_empty() {
        return Err(crate::cause!(Refused::Invalid));
    }
    let id = subject.row_id();
    let before = store.get::<ComputersRow>(Family::Computers, &id).map_err(|error| Refused::Storage(error.cause()))?;
    let current = before.as_ref().map_or(0, |row| row.value.revision);
    if current != change.expected_revision {
        return Err(crate::cause!(Refused::Stale));
    }
    let most = computers_limit(access);
    if change.copy_keepers.len() > most || change.voters.len() > most {
        return Err(crate::cause!(Refused::OverLimit));
    }
    if before.as_ref().is_some_and(|row| !one_voter_step(&row.value.voters, &change.voters)
        || !first_voter_alone(&row.value.voters, &row.value.may_answer, &change.voters)) {
        return Err(crate::cause!(Refused::Invalid));
    }
    if two_writers(&change.may_answer, &change.voters) {
        return Err(crate::cause!(Refused::NoWriterRow));
    }
    // Naming a computer as answering for the first time passes the same check as `apply` (`answer_allowed`).
    let prior_answering: Vec<String> = before.as_ref().map(|row| row.value.may_answer.clone()).unwrap_or_default();
    for computer in change.may_answer.iter().filter(|computer| !prior_answering.contains(*computer)) {
        answer_allowed(store, account, computer, before.as_ref().is_some_and(|row| names_computer(&row.value, computer)))?;
    }
    let value = ComputersRow::sign_for(subject.address(), subject.pursuit(), current + 1, &change.copy_keepers, &change.may_answer, &change.voters, key)
        .map_err(|error| Refused::Invalid(error.cause()))?;
    let after = Row { id: id.clone(), account: account.to_string(), expires_at: 0, value };
    match before {
        None => store.insert(Family::Computers, &after).map_err(|error| Refused::Stale(error.cause()))?,
        Some(prior) => {
            if !store.replace_if(Family::Computers, &prior, &after).map_err(|error| Refused::Storage(error.cause()))? {
                return Err(crate::cause!(Refused::Stale));
            }
        }
    }
    Ok(after)
}

/// Whether a row naming `after` as its voters may follow a row naming `before`: at most one computer is added or removed
/// (or `before` names none: an account that had one computer starts voting). Any majority of two voter sets that differ
/// by one computer shares a computer with any majority of the other, so a term number can never be won by two computers of
/// the two sets (`writer_row.rs`, `copies.rs`). Two changes in one edit could give two disjoint majorities, so they are
/// refused; the owner makes them one edit after the other.
pub(crate) fn one_voter_step(before: &[String], after: &[String]) -> bool {
    if before.is_empty() {
        return true;
    }
    let added = after.iter().filter(|computer| !before.contains(computer)).count();
    let removed = before.iter().filter(|computer| !after.contains(computer)).count();
    added + removed <= 1
}

/// Whether naming `after` as the voters of a row whose voters are `before` names one voter alone when there were none: an
/// account with no voters runs no copies, so no computer can say yet whether another one has caught up (`Copies::
/// caught_up`). The first voter is the computer that writes now; each voter after it is added by its own edit once it has
/// caught up (stage-3-second-place.md). A row with no voters lets at most one computer answer (`two_writers`), and that
/// computer holds every write, so the first voter is that one (`may_answer`, the row's computers that may answer before the
/// edit): a computer that holds nothing yet, named first voter alone, could take the writer role over an empty copy.
/// A new account's first row (no row before) may name its voters at once: every computer starts from the same empty
/// account.
pub(crate) fn first_voter_alone(before: &[String], answering: &[String], after: &[String]) -> bool {
    !before.is_empty() || after.is_empty() || (after.len() == 1 && (answering.is_empty() || answering.contains(&after[0])))
}

/// Whether a row letting `may_answer` answer with `voters` as its voters has two writers: two or more computers may answer
/// and none votes, so no writer row decides which one writes.
/// The rule for the person's own device (the caller, or the computer telling the account about itself with the account's key):
/// with no kind row yet it is written as `own_kind`. A row that already names a kind keeps it.
pub(crate) fn own_device_kind(store: &Store<'_>, account: &str, computer: &str) -> Result<()> {
    ensure_kind(store, account, computer, &settings().host_kinds.own_kind)
}

/// Give `computer` `kind` for `account` when its row has none: the one rule for a computer the account's own writes name
/// first (`own_device_kind`: the caller, or the computer itself; the creating computer, `host_kinds.making_kind`, in create.rs).
/// A row that already names a kind keeps it.
pub(crate) fn ensure_kind(store: &Store<'_>, account: &str, computer: &str, kind: &str) -> Result<()> {
    if copy_rule::host_kind_row(store, account, computer).map_err(|error| Refused::Storage(error.cause()))?.is_some() {
        return Ok(());
    }
    copy_rule::set_host_kind(store, account, computer, 0, kind).map(|_| ()).map_err(|error| match error {
        copy_rule::Refused::Invalid(cause) => Refused::Invalid(cause),
        other => Refused::Storage(other.cause()),
    })
}

/// Test fixture: give each of `computers` the kind its own first boot gives it (`own_device_kind`, the computer telling the account
/// about itself), so a test may name it as answering. A test that names a computer before this is testing the `HostKind` gate.
#[cfg(test)]
pub(crate) fn classify_booted(store: &Store<'_>, account: &str, computers: &[&str]) {
    for computer in computers {
        own_device_kind(store, account, computer).unwrap();
    }
}

/// Whether `row` names `computer` as a copy keeper, a computer that may answer or a voter.
pub(crate) fn names_computer(row: &ComputersRow, computer: &str) -> bool {
    row.copy_keepers.iter().chain(&row.may_answer).chain(&row.voters).any(|named| named == computer)
}

#[cfg(test)]
thread_local! {
    /// The jitter a test's computers draw in place of `random_below`, on that test's own thread (`None`: random).
    pub(crate) static JITTER_FOR_TEST: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// A random number below `bound` (below 1 is 0). The one source of backoff jitter: a contended write (`apply_from`) and a
/// held writer turn (`Copies::hold_claims`) both spread their retries with it.
pub(crate) fn random_below(bound: u64) -> u64 {
    #[cfg(test)]
    if let Some(fixed) = JITTER_FOR_TEST.with(std::cell::Cell::get) {
        return fixed.min(bound.max(1) - 1);
    }
    let mut random = [0u8; 8];
    let _ = SystemRandom::new().fill(&mut random);
    u64::from_le_bytes(random) % bound.max(1)
}

/// Whether `computer` may answer for `account`: the one check the door (`apply`) and the computer command (`join.rs`
/// `send-secrets-key`) both make. The computer's host kind row decides; with no row it is `existing_kind` when the account's
/// computers row already names it (`named`), else `new_kind`. A kind that does not allow `answer` refuses with `HostKind`.
pub(crate) fn answer_allowed(store: &Store<'_>, account: &str, computer: &str, named: bool) -> Result<()> {
    let names = &settings().host_kinds;
    let kind = match copy_rule::host_kind_row(store, account, computer).map_err(|error| Refused::Storage(error.cause()))? {
        Some(kind) => kind,
        None if named => names.existing_kind.clone(),
        None => names.new_kind.clone(),
    };
    if copy_rule::host_kind_allows(&kind, copy_rule::ANSWER) {
        Ok(())
    } else {
        Err(crate::cause!(Refused::HostKind))
    }
}

pub(crate) fn two_writers(may_answer: &[String], voters: &[String]) -> bool {
    voters.is_empty() && may_answer.len() > 1
}

/// What stops when any one computer of `row` is off, as warnings the owner reads beside an edit (answer-decision.md point
/// 3: the row informs, it never refuses). With voters named, a writer needs more than half of them, so fewer than
/// three voters stop writes when one is off; a sign-in change needs a second may-answer computer, so fewer than three
/// may-answer computers stop sign-in changes when one is off. A row with no voters is one computer and warns of nothing here.
pub(crate) fn single_failure_warnings(row: &ComputersRow) -> Vec<&'static str> {
    let mut warnings = Vec::new();
    if row.voters.is_empty() {
        return warnings;
    }
    if row.voters.len() < 3 {
        warnings.push("one_voter_off_stops_writes");
    }
    if row.may_answer.len() < 3 {
        warnings.push("one_answering_computer_off_stops_sign_in");
    }
    warnings
}

/// One computers operation a person or a tool calls (`sign-in:set-computers` with an `op`): a set change of the row, never a
/// whole row to compare. Each is applied to the row as it is read now (`apply`): on `Stale` it is read again and
/// applied again; a change of several voters is made as single voter steps (`one_voter_step`), one edit each; and the
/// row it leaves is always a valid signed row, or no edit is made at all. `edit`'s refusals stay the row's safety rules.
/// - `add-computer`: `computer` becomes a computer that keeps a copy, and a may-answer computer (`may_answer`) and a voter (`voter`) when asked;
/// - `remove-computer`: `computer` leaves the computers that keep a copy, the may-answer computers and the voters; when it was the only computer in
///   use, another computer that keeps a copy (a voter first) is in use in the same edit. Removing the only computer that keeps a copy is not a computers
///   operation: it is deleting the account (`Refused::Invalid`);
/// - `set-in-use`: `computer` becomes a computer that keeps a copy in use (`in_use`, the default) or stops being in use, another computer that keeps a copy
///   taking its computer when it was the only one;
/// - `move-writer`: `computer` becomes a computer that keeps a copy in use and a voter, so it may take the writer writer turn (`writer_row.rs`): the writer turn
///   itself moves by the term, once the writer releases it (an idle account releases it, `idle_release_ms`) and the
///   next write at `computer` claims it;
/// - `set`: the lists given, made valid: may-answer computers are computers that keep a copy too, and with none in use the first computer that keeps a copy is.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum Operation {
    AddComputer {
        #[serde(default)]
        pursuit: Option<String>,
        computer: String,
        #[serde(default)]
        may_answer: bool,
        #[serde(default)]
        voter: bool,
    },
    RemoveComputer {
        #[serde(default)]
        pursuit: Option<String>,
        computer: String,
    },
    SetInUse {
        #[serde(default)]
        pursuit: Option<String>,
        computer: String,
        #[serde(default = "in_use_default")]
        in_use: bool,
    },
    MoveWriter {
        #[serde(default)]
        pursuit: Option<String>,
        computer: String,
    },
    Set {
        #[serde(default)]
        pursuit: Option<String>,
        keeps_copy: Vec<String>,
        may_answer: Vec<String>,
        #[serde(default)]
        voters: Vec<String>,
    },
}

fn in_use_default() -> bool {
    true
}

/// The three lists of a row, sorted and unique.
type Lists = (Vec<String>, Vec<String>, Vec<String>);

impl Operation {
    /// The pursuit whose row this operation changes; none is the account's own.
    pub(crate) fn pursuit(&self) -> Option<&str> {
        match self {
            Operation::AddComputer { pursuit, .. } | Operation::RemoveComputer { pursuit, .. } | Operation::SetInUse { pursuit, .. }
            | Operation::MoveWriter { pursuit, .. } | Operation::Set { pursuit, .. } => pursuit.as_deref(),
        }
    }

    /// The voters the row names once this operation is applied to `row` (none yet: `None`).
    pub(crate) fn voters_after(&self, row: Option<&ComputersRow>) -> Result<Vec<String>> {
        Ok(self.target(row)?.2)
    }

    /// The computers that keep a copy once this operation is applied to `row` (none yet: `None`).
    pub(crate) fn keepers_after(&self, row: Option<&ComputersRow>) -> Result<Vec<String>> {
        Ok(self.target(row)?.0)
    }

    /// The lists this operation leaves when applied to `row` (none yet: `None`), made valid; `Invalid` when no valid
    /// row can follow (removing the only computer that keeps a copy, a computer id that is not one).
    fn target(&self, row: Option<&ComputersRow>) -> Result<Lists> {
        let mut keeps_copy: Vec<String> = row.map(|row| row.copy_keepers.clone()).unwrap_or_default();
        let mut may_answer: Vec<String> = row.map(|row| row.may_answer.clone()).unwrap_or_default();
        let mut voters: Vec<String> = row.map(|row| row.voters.clone()).unwrap_or_default();
        let add = |list: &mut Vec<String>, computer: &str| if !list.iter().any(|named| named == computer) { list.push(computer.to_string()) };
        let drop = |list: &mut Vec<String>, computer: &str| list.retain(|named| named != computer);
        let computer_ok = |computer: &str| owner_text_ok(computer);
        match self {
            Operation::AddComputer { computer, may_answer: in_use, voter, .. } => {
                if !computer_ok(computer) { return Err(crate::cause!(Refused::Invalid)); }
                add(&mut keeps_copy, computer);
                if *in_use { add(&mut may_answer, computer); }
                if *voter { add(&mut voters, computer); }
            }
            Operation::RemoveComputer { computer, .. } => {
                // A computer the row does not name is already removed: the row is left as it is.
                drop(&mut keeps_copy, computer);
                drop(&mut may_answer, computer);
                drop(&mut voters, computer);
                if keeps_copy.is_empty() {
                    // The only computer that keeps a copy: that is deleting the account, not a computers operation.
                    return Err(crate::cause!(Refused::Invalid));
                }
            }
            Operation::SetInUse { computer, in_use, .. } => {
                if !computer_ok(computer) { return Err(crate::cause!(Refused::Invalid)); }
                if *in_use {
                    add(&mut keeps_copy, computer);
                    add(&mut may_answer, computer);
                } else {
                    drop(&mut may_answer, computer);
                    if may_answer.is_empty() && !keeps_copy.iter().any(|named| named != computer) {
                        return Err(crate::cause!(Refused::Invalid));
                    }
                }
            }
            Operation::MoveWriter { computer, .. } => {
                if !computer_ok(computer) { return Err(crate::cause!(Refused::Invalid)); }
                add(&mut keeps_copy, computer);
                add(&mut may_answer, computer);
                add(&mut voters, computer);
            }
            Operation::Set { keeps_copy: given, may_answer: in_use, voters: voting, .. } => {
                if given.iter().chain(in_use).chain(voting).any(|computer| !computer_ok(computer)) {
                    return Err(crate::cause!(Refused::Invalid));
                }
                keeps_copy = given.clone();
                may_answer = in_use.clone();
                voters = voting.clone();
                for computer in in_use {
                    add(&mut keeps_copy, computer);
                }
            }
        }
        for list in [&mut keeps_copy, &mut may_answer, &mut voters] {
            list.sort();
            list.dedup();
        }
        if keeps_copy.is_empty() {
            return Err(crate::cause!(Refused::Invalid));
        }
        if may_answer.is_empty() {
            // Nothing in use: another computer that keeps a copy is, in the same edit, a voter first (a computer that may take the writer turn).
            let next = keeps_copy.iter().find(|computer| voters.contains(computer)).unwrap_or(&keeps_copy[0]).clone();
            may_answer.push(next);
        }
        Ok((keeps_copy, may_answer, voters))
    }
}

/// Apply `operation` to the row of the account (user id `account`) as it is now, signed with `key`, within the
/// account's `computers` limit read from `access` (see `edit`). The row is read, the operation applied to it, and the next
/// row written by one `edit`; a change of several voters goes one voter at a time, an edit each, toward the voters the
/// operation names; on `Stale` (another edit landed first) the row is read again and the operation applied again to
/// it. Answers the row once it holds what the operation asks. At most `operation_edits_max` edits are tried.
pub(crate) fn apply(store: &Store<'_>, account: &str, operation: &Operation, key: &AccountKey, access: &Value, clock: &dyn crate::storage::time_source::Clock)
    -> Result<Row<ComputersRow>> {
    apply_from(store, account, operation, key, access, None, clock)
}

/// Admit each computer this edit newly names (plan I-1): a computer that keeps a copy must be heard and its host kind must
/// allow `sync`; one that answers must be heard (its kind is checked by `answer_allowed`); a new voter must be heard, its
/// kind must allow `vote`, and a majority of the voters must be caught up to the writer (`copy_rule::caught_up`).
fn admit_named(store: &Store<'_>, account: &str, row: Option<&ComputersRow>, keeps_copy: &[String], may_answer: &[String], voters: &[String], caller: Option<&str>, clock: &dyn crate::storage::time_source::Clock)
    -> Result<()> {
    // The computer that runs this operation knows its own report, which the forwarder never sends back to it: it counts as heard.
    let heard: Vec<String> = copy_rule::heard_ids(clock).into_iter().chain(caller.map(str::to_owned)).collect();
    let prior = |list: fn(&ComputersRow) -> &Vec<String>| -> Vec<String> { row.map(|row| list(row).clone()).unwrap_or_default() };
    let (prior_keeps, prior_answers, prior_voters) = (prior(|row| &row.copy_keepers), prior(|row| &row.may_answer), prior(|row| &row.voters));
    let kind_of = |computer: &str| -> Result<String> {
        let names = &settings().host_kinds;
        Ok(copy_rule::host_kind_row(store, account, computer).map_err(|error| Refused::Storage(error.cause()))?.unwrap_or_else(|| names.new_kind.clone()))
    };
    for computer in keeps_copy.iter().filter(|computer| !prior_keeps.contains(computer)) {
        if !heard.contains(computer) {
            return Err(crate::cause!(Refused::Unheard));
        }
        if !copy_rule::host_kind_allows(&kind_of(computer)?, copy_rule::SYNC) {
            return Err(crate::cause!(Refused::HostKind));
        }
    }
    for computer in may_answer.iter().filter(|computer| !prior_answers.contains(computer)) {
        if !heard.contains(computer) {
            return Err(crate::cause!(Refused::Unheard));
        }
    }
    let new_voters: Vec<&String> = voters.iter().filter(|computer| !prior_voters.contains(computer)).collect();
    if new_voters.is_empty() {
        return Ok(());
    }
    let mut caught_up = 0u64;
    for voter in voters {
        if copy_rule::caught_up(store, account, voter).map_err(|error| Refused::Storage(error.cause()))? {
            caught_up += 1;
        }
    }
    for computer in new_voters {
        if !heard.contains(computer) {
            return Err(crate::cause!(Refused::Unheard));
        }
        if !copy_rule::host_kind_allows(&kind_of(computer)?, copy_rule::VOTE) {
            return Err(crate::cause!(Refused::HostKind));
        }
    }
    // The first voter has no voters to be caught up with: nothing is behind it, so only a change to voters that already
    // vote needs a majority of them caught up.
    if !prior_voters.is_empty() && caught_up * 2 <= voters.len() as u64 {
        return Err(crate::cause!(Refused::NoMajority));
    }
    Ok(())
}

/// `apply`, for an operation that came from `caller`: the computer whose own sign-in reached the account's routes (None when
/// the copy rule or a command made it). A computer named as answering that is the caller is the person's own device.
pub(crate) fn apply_from(store: &Store<'_>, account: &str, operation: &Operation, key: &AccountKey, access: &Value, caller: Option<&str>, clock: &dyn crate::storage::time_source::Clock)
    -> Result<Row<ComputersRow>> {
    let subject = Subject::of(&key.address(), operation.pursuit())?;
    let id = subject.row_id();
    let mut stale = 0u32;
    // The revision this operation's own last edit made: a row read after it at another revision means another edit
    // landed between two steps of this one, which counts as contention as a Stale edit does.
    let mut written: Option<u64> = None;
    let wait = |stale: u32| {
        let most = settings().operation_backoff_ms.saturating_mul(1 << stale.min(6));
        std::thread::sleep(std::time::Duration::from_millis(random_below(most)));
    };
    for _ in 0..settings().operation_edits_max {
        let mut before = store.get::<ComputersRow>(Family::Computers, &id).map_err(|error| Refused::Storage(error.cause()))?;
        if written.is_some_and(|revision| before.as_ref().map(|row| row.value.revision) != Some(revision)) {
            stale += 1;
            wait(stale);
            before = store.get::<ComputersRow>(Family::Computers, &id).map_err(|error| Refused::Storage(error.cause()))?;
        }
        let row = before.as_ref().map(|row| &row.value);
        let (keeps_copy, may_answer, voters) = operation.target(row)?;
        admit_named(store, account, row, &keeps_copy, &may_answer, &voters, caller, clock)?;
        if let Some(prior) = &before {
            if prior.value.copy_keepers == keeps_copy && prior.value.may_answer == may_answer && prior.value.voters == voters {
                return Ok(prior.clone());
            }
        }
        // A computer named as answering for the first time must pass `answer_allowed`. A computer already answering keeps its
        // answers: a kind row decides what the next name may be, and never changes a row that is kept.
        let prior_answering: Vec<String> = row.map(|row| row.may_answer.clone()).unwrap_or_default();
        for computer in may_answer.iter().filter(|computer| !prior_answering.contains(*computer)) {
            if caller == Some(computer.as_str()) {
                own_device_kind(store, account, computer)?;
            }
            answer_allowed(store, account, computer, row.is_some_and(|row| names_computer(row, computer)))?;
        }
        // One voter step toward the voters the operation names: an added one first, then a removed one.
        let now: Vec<String> = row.map(|row| row.voters.clone()).unwrap_or_default();
        let first_alone = now.is_empty() && voters.len() > 1;
        let step = if first_alone {
            // The first voter alone (`first_voter_alone`): the computer that answers the account now when the operation
            // names it, so the writer stays where it is; the others follow one edit each once they have caught up,
            // which the account's routes check (`computers_voter_behind`) before the next edit.
            // The computer in use comes first even when the operation does not name it a voter: a later edit removes it
            // once the named ones voted (`first_voter_alone`).
            let in_use = row.map(|row| row.may_answer.clone()).unwrap_or_default();
            let first = voters.iter().find(|computer| in_use.contains(computer)).or(in_use.first()).unwrap_or(&voters[0]).clone();
            vec![first]
        } else if now.is_empty() || one_voter_step(&now, &voters) {
            voters.clone()
        } else if let Some(added) = voters.iter().find(|computer| !now.contains(computer)) {
            let mut next = now.clone();
            next.push(added.clone());
            next.sort();
            next
        } else {
            let removed = now.iter().find(|computer| !voters.contains(computer)).cloned().unwrap_or_default();
            now.iter().filter(|computer| **computer != removed).cloned().collect()
        };
        let change = Change {
            pursuit: operation.pursuit().map(str::to_string),
            expected_revision: row.map_or(0, |row| row.revision),
            copy_keepers: keeps_copy,
            may_answer: may_answer,
            voters: step,
        };
        match edit(store, account, &subject, &change, key, access) {
            // The first voter's copies start with this row: the next voter is named by another edit, once it has
            // caught up with them (the account routes' `computers_voter_behind`).
            Ok(after) if first_alone => return Ok(after),
            Ok(after) => written = Some(after.value.revision),
            // Another edit landed first: wait a little, a random while that doubles with each such edit, so of two
            // operations that keep undoing each other's voter steps one finishes and the other is applied on top of it.
            Err(Refused::Stale(_)) => {
                written = None;
                stale += 1;
                wait(stale);
            }
            Err(other) => return Err(other),
        }
    }
    Err(crate::cause!(Refused::Stale))
}

/// The account's own row as this computer tells it: the kept row when it verifies, or, when the account has none
/// yet, a first row at revision 1 naming `computer` as computer that keeps a copy and may-answer computer, signed with `key`. A kept row that
/// does not name `computer` is told as it is: which computers answer is the owner's choice, not this computer's, with one
/// exception, the computer's own succession: `succeeds` are the earlier ids of this same computer (a hosting app's devices
/// this account enrolled in this same state, one for each key the app was issued, `LocalAccount::enrolled_devices`).
/// When the kept row names no voters and every computer it names is `computer` or one it succeeds, the computer moved to a new
/// id and nobody else answers: the row is signed again at the next revision naming `computer` alone. Without that, the
/// forwarder routes only to the old id, which no live session has, and answers the account `no_live_computer`. A row
/// naming any other computer, or voters, is left as the owner set it. `key` is the account's key as its vault keeps it
/// (user id `account`); the row is for the address `key` names. When the account's own key row names another key,
/// nothing is signed.
pub(crate) fn told(store: &Store<'_>, account: &str, computer: &str, succeeds: &[String], key: &AccountKey) -> Result<KeptAccount> {
    keep_public_key(store, account, key)?;
    sign_stage_one_rows(store, account, key)?;
    let subject = Subject::Account(key.address());
    // The computer tells the account about itself with the account's key: it is the person's own device. A computer already
    // named with no kind row (a place another computer added) gets its kind here too, so it can answer.
    own_device_kind(store, account, computer)?;
    let alone = |expected_revision| Change { pursuit: None, expected_revision, copy_keepers: vec![computer.to_string()], may_answer: vec![computer.to_string()], voters: Vec::new() };
    let row = match read(store, account, &subject)? {
        Some(row) if succeeded_here(&row.value, computer, succeeds) => match edit(store, account, &subject, &alone(row.value.revision), key, &Value::Null) {
            Ok(row) => row.value,
            // Another start moved or changed the row in between: tell what it holds now.
            Err(Refused::Stale(_)) => read(store, account, &subject)?.ok_or(crate::cause!(Refused::Stale))?.value,
            Err(other) => return Err(other),
        },
        Some(row) => row.value,
        None => match edit(store, account, &subject, &alone(0), key, &Value::Null) {
            Ok(row) => row.value,
            // Another start wrote the first row in between: tell that one.
            Err(Refused::Stale(_)) => read(store, account, &subject)?.ok_or(crate::cause!(Refused::Stale))?.value,
            Err(other) => return Err(other),
        },
    };
    Ok(KeptAccount { row, account_key: key.public_hex() })
}

/// Whether `row` names only earlier ids of `computer` (`succeeds`), and `computer` itself at most, and no voters, while it
/// does not yet name `computer` as may-answer: the computer's own succession `told` signs.
fn succeeded_here(row: &ComputersRow, computer: &str, succeeds: &[String]) -> bool {
    let own = |named: &String| named == computer || succeeds.contains(named);
    row.voters.is_empty() && !row.copy_keepers.is_empty() && !row.may_answer.iter().any(|named| named == computer)
        && row.copy_keepers.iter().all(own) && row.may_answer.iter().all(own)
}

/// A computers row as stage 1 signed it: no voters list, and the signed bytes end after the may-answer list. Such a row
/// no longer reads as a `ComputersRow`. Only `sign_stage_one_rows` reads this shape, once, to sign the row again.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StageOneRow {
    account: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pursuit: Option<String>,
    revision: u64,
    #[serde(rename = "holders")] copy_keepers: Vec<String>,
    #[serde(rename = "answering")] may_answer: Vec<String>,
    signature: String,
}

impl StageOneRow {
    fn verify(&self, public_key: &[u8]) -> bool {
        let Some(signature) = hex_bytes(&self.signature).filter(|bytes| bytes.len() == SIGNATURE_BYTES) else {
            return false;
        };
        let mut bytes = Vec::new();
        push_text(&mut bytes, &settings().signed_domain);
        push_text(&mut bytes, &self.account);
        push_text(&mut bytes, self.pursuit.as_deref().unwrap_or(""));
        bytes.extend_from_slice(&self.revision.to_be_bytes());
        push_list(&mut bytes, &self.copy_keepers);
        push_list(&mut bytes, &self.may_answer);
        UnparsedPublicKey::new(&ED25519, public_key).verify(&bytes, &signature).is_ok()
    }
}

/// Sign again, with a voters list, every computers row of the account (user id `account`) that stage 1 signed without
/// one. Runs at each start, before the row is told. A stage 1 row is signed again only when the account's own
/// `key` verifies it; the new row keeps its computers that keep a copy and may-answer computers, names no voters (so the account writes as it
/// did, with no writer row, until the owner names voters by one edit), and has the next revision. Answers how many rows
/// were signed again. A row that does not verify is left as it is and is not believed, as before.
pub(crate) fn sign_stage_one_rows(store: &Store<'_>, account: &str, key: &AccountKey) -> Result<usize> {
    let rows = store.list::<serde_json::Value>(Family::Computers, account, settings().max_told_rows).map_err(|error| Refused::Storage(error.cause()))?;
    let prefixes = [settings().account_prefix.as_str(), settings().pursuit_prefix.as_str()];
    let mut signed = 0;
    for row in rows {
        if !prefixes.iter().any(|prefix| row.id.starts_with(prefix)) {
            continue;
        }
        let Some(old) = store.get::<StageOneRow>(Family::Computers, &row.id).ok().flatten() else { continue };
        if old.value.account != key.address() || !old.value.verify(key.public_key()) {
            continue;
        }
        let value = ComputersRow::sign_for(&old.value.account, old.value.pursuit.as_deref(), old.value.revision + 1,
            &old.value.copy_keepers, &old.value.may_answer, &[], key)
            .map_err(|error| Refused::Invalid(error.cause()))?;
        let after = Row { id: old.id.clone(), account: old.account.clone(), expires_at: old.expires_at, value };
        // Another start may have signed it in between; then the row is already new.
        if store.replace_if(Family::Computers, &old, &after).map_err(|error| Refused::Storage(error.cause()))? {
            signed += 1;
        }
    }
    Ok(signed)
}

/// One computer a sign-up may land on: its id, its report, and whether it is live now (the caller's liveness check).
pub(crate) struct Candidate<'a> {
    pub computer: &'a str,
    pub report: &'a ComputerReport,
    pub live: bool,
}

/// The computer a new account lands on: the smallest id of a live computer whose report says it takes new accounts. `None`
/// when no candidate qualifies. Nothing else is looked at: a computer that does not report it takes new accounts is never
/// chosen.
pub(crate) fn landing_computer<'a>(candidates: &[Candidate<'a>]) -> Option<&'a str> {
    candidates.iter()
        .filter(|candidate| candidate.live && candidate.report.takes_new_accounts && owner_text_ok(candidate.computer))
        .map(|candidate| candidate.computer)
        .min()
}

/// Write the first computers row of a new account (user id `account`, signing key `key`), naming the computer it lands on as
/// both computer that keeps a copy and may-answer computer, at revision 1. Refuses when the account already has a row.
pub(crate) fn land_new_account(store: &Store<'_>, account: &str, candidates: &[Candidate<'_>], key: &AccountKey)
    -> Result<Row<ComputersRow>> {
    let computer = landing_computer(candidates).ok_or(crate::cause!(Refused::NoComputer))?;
    keep_public_key(store, account, key)?;
    let change = Change { pursuit: None, expected_revision: 0, copy_keepers: vec![computer.to_string()], may_answer: vec![computer.to_string()], voters: Vec::new() };
    edit(store, account, &Subject::Account(key.address()), &change, key, &Value::Null)
}

/// The computers every new account starts in, as the sign-up computer's config names them (`default_places`): the computers that keep a copy,
/// the may-answer computers among them and the voters, each a computer id. A config without it lands a new account on the
/// sign-up computer alone (`land_new_account`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DefaultComputers {
    #[serde(rename = "holders")]
    pub keeps_copy: Vec<String>,
    #[serde(rename = "answering")]
    pub may_answer: Vec<String>,
    #[serde(default)]
    pub voters: Vec<String>,
    /// The host kind of a computer the new account starts in, by its id (`host_kinds` in computers/settings.json). A computer
    /// not named here gets `default_places_kind`, so every computer a new account names has a kind before its row is written.
    #[serde(default)]
    pub kinds: std::collections::BTreeMap<String, String>,
}

impl DefaultComputers {
    /// Whether these lists may be signed as a new account's first row: the same shape rules as every computers row
    /// (`ComputersRow::shape_ok`: one to the shipped `computers` limit of computers that keep a copy, each a computer id, no computer twice, may-answer
    /// among computers that keep a copy, at most that many voters), checked on a row signed by a throwaway key, so nothing that a real
    /// sign-up would refuse is ever accepted here.
    pub fn valid(&self) -> bool {
        let Ok(key) = AccountKey::generate() else { return false };
        let most = computers_limit(&Value::Null);
        self.keeps_copy.len() <= most && self.voters.len() <= most && !two_writers(&self.may_answer, &self.voters)
            && ComputersRow::sign_with_voters(&key.address(), 1, &self.keeps_copy, &self.may_answer, &self.voters, &key)
                .is_ok_and(|row| row.shape_ok(most))
    }

    /// Whether `computer` is one of the may-answer computers: the sign-up computer must be, since it holds the new account's
    /// folder and root.
    pub fn names_may_answer(&self, computer: &str) -> bool {
        self.may_answer.iter().any(|named| named == computer)
    }
}

/// Write the first computers row of a new account (user id `account`, signing key `key`) naming the sign-up computer's
/// `defaults`, at revision 1, signed by the new account. Refuses when the account already has a row.
pub(crate) fn land_new_account_in(store: &Store<'_>, account: &str, defaults: &DefaultComputers, key: &AccountKey)
    -> Result<Row<ComputersRow>> {
    keep_public_key(store, account, key)?;
    // Each computer the first row names gets its kind row before the row is written, so the edit's check passes for it
    // (`answer_allowed`): the kind the config gives it, else `default_places_kind`. A row that already names a kind keeps it.
    let default_kind = &settings().host_kinds.default_places_kind;
    for computer in defaults.keeps_copy.iter().chain(&defaults.may_answer).chain(&defaults.voters) {
        ensure_kind(store, account, computer, defaults.kinds.get(computer).unwrap_or(default_kind))?;
    }
    let change = Change {
        pursuit: None,
        expected_revision: 0,
        copy_keepers: defaults.keeps_copy.clone(),
        may_answer: defaults.may_answer.clone(),
        voters: defaults.voters.clone(),
    };
    edit(store, account, &Subject::Account(key.address()), &change, key, &Value::Null)
}

fn canonical(list: &[String]) -> std::result::Result<Vec<String>, CodedError<&'static str>> {
    let mut sorted = list.to_vec();
    sorted.sort();
    if !sorted_unique(&sorted) {
        return Err(CodedError::new("computers row names a computer twice"));
    }
    Ok(sorted)
}

fn sorted_unique(list: &[String]) -> bool {
    list.windows(2).all(|pair| pair[0] < pair[1])
}

fn push_text(bytes: &mut Vec<u8>, text: &str) {
    bytes.extend_from_slice(&(text.len() as u32).to_be_bytes());
    bytes.extend_from_slice(text.as_bytes());
}

fn push_list(bytes: &mut Vec<u8>, list: &[String]) {
    bytes.extend_from_slice(&(list.len() as u32).to_be_bytes());
    for text in list {
        push_text(bytes, text);
    }
}

fn hex_text(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    const COMPUTER_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMPUTER_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const COMPUTER_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn key(secret: u8) -> AccountKey {
        AccountKey::from_secret(Zeroizing::new([secret; 32])).expect("secret")
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    /// Each of `computers` has booted and told the account about itself (`classify_booted`), as a real computer does before the
    /// owner names it as answering.
    fn booted(store: &Store<'_>, computers: &[String]) {
        let computers: Vec<&str> = computers.iter().map(String::as_str).collect();
        classify_booted(store, "person", &computers);
    }

    fn signed(revision: u64, copy_keepers: &[&str], may_answer: &[&str], pair: &AccountKey) -> ComputersRow {
        ComputersRow::sign(&key(1).address(), revision, &names(copy_keepers), &names(may_answer), pair).expect("signed")
    }

    fn memory() -> Memory {
        Memory::open("sign_in").expect("the sign_in schema opens")
    }

    #[test]
    fn a_row_says_what_stops_when_any_one_computer_is_off() {
        const COMPUTER_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let pair = key(1);
        let row = |copy_keepers: &[&str], may_answer: &[&str], voters: &[&str]| {
            ComputersRow::sign_with_voters(&pair.address(), 2, &names(copy_keepers), &names(may_answer), &names(voters), &pair).expect("signed")
        };
        // One computer, no voters: nothing to warn of.
        assert!(single_failure_warnings(&row(&[COMPUTER_A], &[COMPUTER_A], &[])).is_empty());
        // Two voting computers: one off stops writes and sign-in changes.
        assert_eq!(single_failure_warnings(&row(&[COMPUTER_A, COMPUTER_B], &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A, COMPUTER_B])),
            vec!["one_voter_off_stops_writes", "one_answering_computer_off_stops_sign_in"]);
        // Two may-answer computers and a third voter that only holds a copy: one may-answer computer off stops sign-in changes.
        assert_eq!(single_failure_warnings(&row(&[COMPUTER_A, COMPUTER_B, COMPUTER_C], &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A, COMPUTER_B, COMPUTER_C])),
            vec!["one_answering_computer_off_stops_sign_in"]);
        // Three computers that all hold, answer and vote: any one off leaves both majorities.
        assert!(single_failure_warnings(&row(&[COMPUTER_A, COMPUTER_B, COMPUTER_C], &[COMPUTER_A, COMPUTER_B, COMPUTER_C], &[COMPUTER_A, COMPUTER_B, COMPUTER_C])).is_empty());
        // Three voters and a fourth computer that answers without a vote.
        assert!(single_failure_warnings(&row(&[COMPUTER_A, COMPUTER_B, COMPUTER_C, COMPUTER_D], &[COMPUTER_A, COMPUTER_B, COMPUTER_C, COMPUTER_D], &[COMPUTER_B, COMPUTER_C, COMPUTER_D])).is_empty());
    }

    fn change(pursuit: Option<&str>, expected: u64, copy_keepers: &[&str], may_answer: &[&str]) -> Change {
        Change { pursuit: pursuit.map(str::to_string), expected_revision: expected, copy_keepers: names(copy_keepers), may_answer: names(may_answer), voters: Vec::new() }
    }

    #[test]
    fn the_address_is_derived_from_the_public_key_and_names_only_that_key() {
        let account = key(1);
        assert_eq!(account.address().len(), 64);
        assert!(owner_text_ok(&account.address()));
        assert_ne!(account.address(), key(2).address());
        assert_eq!(address_of(account.public_key()), Some(account.address()));
        assert_eq!(address_of(&account.public_key()[..31]), None);
        let again = AccountKey::from_secret_text(&account.secret_text()).unwrap();
        assert_eq!(again.public_hex(), account.public_hex(), "the kept text opens the same key");
        assert!(AccountKey::from_secret_text("not hex").is_err());
        assert!(!format!("{account:?}").contains(account.secret_text().as_str()), "Debug shows no secret");
    }

    #[test]
    fn a_row_signed_by_the_account_key_verifies_and_another_key_or_change_does_not() {
        let account = key(1);
        let row = signed(3, &[COMPUTER_B, COMPUTER_A], &[COMPUTER_A], &account);
        assert_eq!(row.copy_keepers, names(&[COMPUTER_A, COMPUTER_B]), "the lists are sorted");
        assert!(row.verify(account.public_key()));
        assert!(!row.verify(key(2).public_key()));
        let mut newer = row.clone();
        newer.revision = 4;
        assert!(!newer.verify(account.public_key()), "the revision is signed");
        let mut wider = row.clone();
        wider.may_answer = names(&[COMPUTER_A, COMPUTER_B]);
        assert!(!wider.verify(account.public_key()), "the may-answer list is signed");
        let mut pursuit = row.clone();
        pursuit.pursuit = Some("p".into());
        assert!(!pursuit.verify(account.public_key()), "a pursuit is signed apart from the account");
        let mut unsigned = row.clone();
        unsigned.signature = "00".repeat(64);
        assert!(!unsigned.verify(account.public_key()));
    }

    #[test]
    fn a_row_in_a_bad_shape_is_refused() {
        let account = key(1);
        let address = account.address();
        assert!(ComputersRow::sign(&address, 1, &names(&[COMPUTER_A, COMPUTER_A]), &[], &account).is_err());
        assert!(ComputersRow::sign(&address, 1, &names(&[COMPUTER_A]), &names(&[COMPUTER_B]), &account).is_err());
        assert!(ComputersRow::sign(&address, 0, &names(&[COMPUTER_A]), &[], &account).is_err(), "revision starts at 1");
        assert!(ComputersRow::sign("not-an-address", 1, &names(&[COMPUTER_A]), &[], &account).is_err());
        assert!(ComputersRow::sign(&address, 1, &[], &[], &account).is_err(), "a row names at least one copy keeper");
        assert!(ComputersRow::sign(&address, 1, &names(&["bad id"]), &[], &account).is_err());
    }

    #[test]
    fn a_forwarder_believes_a_row_only_with_the_key_its_account_names() {
        let account = key(1);
        let address = account.address();
        let row = ComputersRow::sign(&address, 1, &names(&[COMPUTER_A]), &names(&[COMPUTER_A]), &account).unwrap();
        let honest = KeptAccount { row: row.clone(), account_key: account.public_hex() };
        assert!(honest.believed(&address));
        assert!(!honest.believed(&key(3).address()), "a row is believed only for its own account");
        // An impostor signs a row for the account with its own key and tells that key: the key does not name the
        // account, so the row is not believed.
        let impostor = key(2);
        let forged = ComputersRow::sign(&address, 9, &names(&[COMPUTER_B]), &names(&[COMPUTER_B]), &impostor).unwrap();
        assert!(!KeptAccount { row: forged.clone(), account_key: impostor.public_hex() }.believed(&address));
        assert!(!KeptAccount { row: forged, account_key: account.public_hex() }.believed(&address));
    }

    #[test]
    fn kept_account_lists_round_trip_and_stop_at_the_row_limit() {
        let account = key(1);
        let rows = vec![KeptAccount { row: signed(1, &[COMPUTER_A], &[COMPUTER_A], &account), account_key: account.public_hex() }];
        let bytes = kept_accounts_bytes(&rows).expect("told");
        assert_eq!(read_kept_accounts(&bytes), Some(rows.clone()));
        assert_eq!(read_kept_accounts(b"{\"rows\":[],\"extra\":1}"), None, "unknown fields are refused");
        assert_eq!(read_kept_accounts(b"not json"), None);
        let many: Vec<KeptAccount> = (0..=settings().max_told_rows).map(|_| rows[0].clone()).collect();
        assert!(kept_accounts_bytes(&many).is_none());
    }

    /// A message proof travels on to the computer the message is for (src/forwarder/gateway.rs `pass_message`): it must
    /// never open a session as its sender (`read_computer_credential`, the forwarder's session-open check), and a session
    /// credential must never pass as a message proof.
    #[test]
    fn a_message_proof_never_opens_a_session_and_a_session_credential_is_no_message_proof() {
        let computer = ComputerSigner(key(5));
        let account = key(1).address();
        let message = computer.message_credential(&account, 1_000_000);
        let session = computer.session_credential(&account, 1_000_000);
        assert_ne!(message, session);
        let proven = Some((computer.computer_id(), account.clone(), 1_000_000));
        assert_eq!(read_computer_message_credential(&message, 1_000_500), proven);
        assert_eq!(read_computer_credential(&session, 1_000_500), proven);
        assert_eq!(read_computer_credential(&message, 1_000_500), None, "a message proof opens no session");
        assert_eq!(read_computer_message_credential(&session, 1_000_500), None, "a session credential is no message proof");
        let window = settings().computer_proof_window_ms;
        assert_eq!(read_computer_message_credential(&message, 1_000_000 + window + 1), None, "an old message proof is refused");
        // A claim is signed over its own domain and parts: no session or message signature is a claim, and no claim is a session.
        let parts = [account.as_str(), "alice@example.com", "bbbb"];
        let claim = computer.sign_use("claim", &parts, 1_000_000).expect("the claim use is named");
        let session_signature = computer.sign_use("session", &[account.as_str()], 1_000_000).expect("the session use is named");
        assert!(verify_use("claim", &computer.computer_id(), &parts, 1_000_000, 1_000_500, &claim), "a claim verifies as a claim");
        assert!(!verify_use("session", &computer.computer_id(), &[account.as_str()], 1_000_000, 1_000_500, &claim), "a claim is no session proof");
        assert!(!verify_use("claim", &computer.computer_id(), &parts, 1_000_000, 1_000_500, &session_signature), "a session signature is no claim");
        assert!(!verify_use("claim", &computer.computer_id(), &["x", "alice@example.com", "bbbb"], 1_000_000, 1_000_500, &claim), "a claim binds its parts");
    }

    #[test]
    fn a_computer_proof_holds_for_its_account_and_window_only() {
        let computer = ComputerSigner(key(5));
        let account = key(1).address();
        let credential = computer.session_credential(&account, 1_000_000);
        assert_eq!(read_computer_credential(&credential, 1_000_500), Some((computer.computer_id(), account.clone(), 1_000_000)));
        let window = settings().computer_proof_window_ms;
        assert_eq!(read_computer_credential(&credential, 1_000_000 + window + 1), None, "an old proof is refused");
        let other = key(2).address();
        let swapped = credential.replace(&account, &other);
        assert_eq!(read_computer_credential(&swapped, 1_000_500), None, "the account is signed");
        let mut tampered = credential.clone();
        tampered.pop();
        tampered.push('0');
        if tampered != credential {
            assert_eq!(read_computer_credential(&tampered, 1_000_500), None);
        }
        assert_eq!(read_computer_credential("trc_x", 1_000_500), None);
    }

    #[test]
    fn a_row_edit_with_a_stale_revision_is_refused() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        let address = account.address();
        keep_public_key(&store, "person", &account).unwrap();
        booted(&store, &names(&[COMPUTER_A, COMPUTER_B, COMPUTER_C]));
        let subject = Subject::Account(address.clone());
        let first = edit(&store, "person", &subject, &change(None, 0, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A]), &account, &Value::Null).expect("created");
        assert_eq!(first.value.revision, 1);
        assert_eq!(edit(&store, "person", &subject, &change(None, 0, &[COMPUTER_A], &[COMPUTER_A]), &account, &Value::Null), Err(crate::cause!(Refused::Stale)));
        let second = edit(&store, "person", &subject, &change(None, 1, &[COMPUTER_A, COMPUTER_C], &[COMPUTER_C]), &account, &Value::Null).expect("current");
        assert_eq!(second.value.revision, 2);
        assert_eq!(edit(&store, "person", &subject, &change(None, 1, &[COMPUTER_B], &[COMPUTER_B]), &account, &Value::Null), Err(crate::cause!(Refused::Stale)));
        let kept = read(&store, "person", &subject).unwrap().expect("the row is kept");
        assert_eq!(kept.value.copy_keepers, names(&[COMPUTER_A, COMPUTER_C]));
        assert!(kept.value.verify(account.public_key()));
    }

    /// `n` distinct computer names (64 lowercase hex).
    fn many_computers(n: usize) -> Vec<String> {
        (1..=n).map(|i| format!("{i:064x}")).collect()
    }

    #[test]
    fn a_synthetic_contract_row_raising_max_computers_changes_what_an_edit_keeps_with_no_code_change() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        keep_public_key(&store, "person", &account).unwrap();
        booted(&store, &many_computers(21));
        let subject = Subject::Account(account.address());
        let edit_of = |revision: u64, copy_keepers: &[String]| Change {
            pursuit: None, expected_revision: revision, copy_keepers: copy_keepers.to_vec(), may_answer: copy_keepers[..1].to_vec(), voters: Vec::new(),
        };
        let sixteen = many_computers(16);
        let seventeen = many_computers(17);
        // No limit row: the shipped default (old trillion's 16), never unbounded.
        assert_eq!(computers_limit(&Value::Null), 16);
        assert_eq!(computers_limit(&serde_json::json!({"capabilities": [], "limits": {}})), 16);
        edit(&store, "person", &subject, &edit_of(0, &sixteen), &account, &Value::Null).expect("sixteen fit the shipped row");
        assert_eq!(edit(&store, "person", &subject, &edit_of(1, &seventeen), &account, &Value::Null), Err(crate::cause!(Refused::OverLimit)));
        let voters = Change { voters: seventeen.clone(), ..edit_of(1, &sixteen) };
        assert_eq!(edit(&store, "person", &subject, &voters, &account, &Value::Null), Err(crate::cause!(Refused::OverLimit)));
        // A plan row smaller than the shipped one does not lower it: the most generous row wins.
        let smaller = serde_json::json!({"limits": {"access:places": [{"count": 2, "per": "month"}]}});
        assert_eq!(computers_limit(&smaller), 16);
        // A synthetic contract row (the contract snapshot's `limits` row, less its key) raises it to 20.
        let contract = serde_json::json!({"capabilities": ["access:places"], "limits": {"access:places": [{"count": 2, "per": "month"}, {"quantity": 20}]}});
        assert_eq!(computers_limit(&contract), 20);
        let kept = edit(&store, "person", &subject, &edit_of(1, &seventeen), &account, &contract).expect("seventeen fit the contract");
        assert_eq!(kept.value.copy_keepers, seventeen);
        assert!(kept.value.verify(account.public_key()), "a row the contract allowed still verifies");
        assert_eq!(edit(&store, "person", &subject, &edit_of(2, &many_computers(21)), &account, &contract), Err(crate::cause!(Refused::OverLimit)));
        // A pursuit's row reads the same account limit.
        let pursuit = Subject::of(&account.address(), Some("p")).unwrap();
        let pursuit_edit = Change { pursuit: Some("p".into()), ..edit_of(0, &seventeen) };
        assert_eq!(edit(&store, "person", &pursuit, &pursuit_edit, &account, &Value::Null), Err(crate::cause!(Refused::OverLimit)));
        // No contract asks past the hard bound on computers per row.
        let huge = serde_json::json!({"limits": {"access:places": [{"quantity": u64::MAX}]}});
        assert_eq!(computers_limit(&huge), settings().limits.most_admitted_computers);
    }

    #[test]
    fn a_computer_holds_its_shipped_accounts_or_what_its_plan_or_contract_raises_it_to() {
        assert_eq!(accounts_limit(&Value::Null), 256, "old trillion's accounts_max is the shipped row");
        let plan = serde_json::json!({"limits": {"access:place-accounts": [{"count": 300}], "access:places": [{"quantity": 99}]}});
        assert_eq!(accounts_limit(&plan), 300);
        let bad = serde_json::json!({"limits": {"access:place-accounts": [{"quantity": 0}, {"quantity": "x"}, 7]}});
        assert_eq!(accounts_limit(&bad), 256, "a row that grants nothing leaves the shipped row");
    }

    #[test]
    fn a_row_edit_moves_at_most_one_voter() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        keep_public_key(&store, "person", &account).unwrap();
        booted(&store, &names(&[COMPUTER_A, COMPUTER_B, COMPUTER_C]));
        let subject = Subject::Account(account.address());
        let with = |expected: u64, voters: &[&str]| Change { voters: names(voters), ..change(None, expected, &[COMPUTER_A, COMPUTER_B, COMPUTER_C], &[COMPUTER_A]) };
        edit(&store, "person", &subject, &with(0, &[]), &account, &Value::Null).unwrap();
        // From no voters the first voter is named alone: no copies run yet, so nobody can say another one caught up.
        assert_eq!(edit(&store, "person", &subject, &with(1, &[COMPUTER_A, COMPUTER_B]), &account, &Value::Null), Err(crate::cause!(Refused::Invalid)),
            "two first voters at once");
        // The first voter is the computer that answers now: one that holds nothing yet cannot vote first.
        assert_eq!(edit(&store, "person", &subject, &with(1, &[COMPUTER_B]), &account, &Value::Null), Err(crate::cause!(Refused::Invalid)),
            "a first voter that does not answer the account");
        edit(&store, "person", &subject, &with(1, &[COMPUTER_A]), &account, &Value::Null).expect("an account with one computer starts voting");
        edit(&store, "person", &subject, &with(2, &[COMPUTER_A, COMPUTER_B]), &account, &Value::Null).expect("one voter added");
        assert_eq!(edit(&store, "person", &subject, &with(3, &[COMPUTER_C]), &account, &Value::Null), Err(crate::cause!(Refused::Invalid)), "two voters moved at once");
        edit(&store, "person", &subject, &with(3, &[COMPUTER_A, COMPUTER_B, COMPUTER_C]), &account, &Value::Null).expect("one voter added");
        edit(&store, "person", &subject, &with(4, &[COMPUTER_A, COMPUTER_B]), &account, &Value::Null).expect("one voter removed");
        // Two computers that may answer and no voters are two writers, at the first row as at any edit.
        edit(&store, "person", &subject, &with(5, &[COMPUTER_A]), &account, &Value::Null).expect("one voter removed");
        let two = change(None, 6, &[COMPUTER_A, COMPUTER_B], &[COMPUTER_A, COMPUTER_B]);
        assert_eq!(edit(&store, "person", &subject, &two, &account, &Value::Null), Err(crate::cause!(Refused::NoWriterRow)));
        let fresh = Subject::of(&account.address(), Some("pursuit-two")).unwrap();
        let first_two = Change { pursuit: Some("pursuit-two".into()), expected_revision: 0, ..two.clone() };
        assert_eq!(edit(&store, "person", &fresh, &first_two, &account, &Value::Null), Err(crate::cause!(Refused::NoWriterRow)));
        assert!(one_voter_step(&names(&[COMPUTER_A]), &[]));
    }

    #[test]
    fn a_pursuit_row_is_separate_from_the_account_row() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        let address = account.address();
        keep_public_key(&store, "person", &account).unwrap();
        booted(&store, &names(&[COMPUTER_A, COMPUTER_B, COMPUTER_C]));
        let own = Subject::Account(address.clone());
        let pursuit = Subject::of(&address, Some("pursuit-7")).unwrap();
        edit(&store, "person", &own, &change(None, 0, &[COMPUTER_A], &[COMPUTER_A]), &account, &Value::Null).unwrap();
        edit(&store, "person", &pursuit, &change(Some("pursuit-7"), 0, &[COMPUTER_B, COMPUTER_C], &[COMPUTER_C]), &account, &Value::Null).unwrap();
        assert_eq!(read(&store, "person", &own).unwrap().unwrap().value.copy_keepers, names(&[COMPUTER_A]));
        let pursuit_row = read(&store, "person", &pursuit).unwrap().unwrap();
        assert_eq!(pursuit_row.value.copy_keepers, names(&[COMPUTER_B, COMPUTER_C]));
        assert_eq!(pursuit_row.value.pursuit.as_deref(), Some("pursuit-7"));
        assert_ne!(own.row_id(), pursuit.row_id());
        assert_eq!(read(&store, "person", &Subject::of(&address, Some("other")).unwrap()).unwrap(), None);
    }

    #[test]
    fn a_row_whose_content_changed_or_was_signed_by_another_key_is_not_read_as_kept() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        let address = account.address();
        keep_public_key(&store, "person", &account).unwrap();
        booted(&store, &names(&[COMPUTER_A, COMPUTER_B, COMPUTER_C]));
        let subject = Subject::Account(address.clone());
        edit(&store, "person", &subject, &change(None, 0, &[COMPUTER_A], &[COMPUTER_A]), &account, &Value::Null).unwrap();
        let mut tampered = store.get::<ComputersRow>(Family::Computers, &subject.row_id()).unwrap().unwrap();
        tampered.value.copy_keepers = names(&[COMPUTER_C]);
        tampered.value.may_answer = names(&[COMPUTER_C]);
        store.put(Family::Computers, &tampered).unwrap();
        assert_eq!(read(&store, "person", &subject).unwrap(), None);
        let mut other = tampered.clone();
        other.value = ComputersRow::sign(&address, 5, &names(&[COMPUTER_C]), &names(&[COMPUTER_C]), &key(2)).unwrap();
        store.put(Family::Computers, &other).unwrap();
        assert_eq!(read(&store, "person", &subject).unwrap(), None, "a row another key signed is not the account's");
    }

    #[test]
    fn a_computer_tells_the_kept_row_or_writes_the_first_one_naming_itself() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        let address = account.address();
        let first = told(&store, "person", COMPUTER_A, &[], &account).unwrap();
        assert!(first.believed(&address));
        assert_eq!(first.row.copy_keepers, names(&[COMPUTER_A]));
        assert_eq!(first.row.may_answer, names(&[COMPUTER_A]));
        let again = told(&store, "person", COMPUTER_B, &[], &account).unwrap();
        assert_eq!(again.row, first.row, "a kept row is told as the address set it, even by another computer");
        assert_eq!(told(&store, "person", COMPUTER_A, &[], &key(3)), Err(crate::cause!(Refused::NoKey)),
            "a key other than the one the account's row names signs nothing for it");
    }

    /// A hosting app's computer id is the device its account enrolled for its current key, so a new key moves the computer to
    /// a new id. The row that named only its earlier ids follows it, once; a row naming any other computer, or voters,
    /// stays the owner's choice.
    #[test]
    fn a_computer_that_moved_to_a_new_id_takes_over_a_row_only_its_earlier_ids_held() {
        let memory = memory();
        let store = Store::new(&memory);
        booted(&store, &names(&[COMPUTER_A, COMPUTER_B, COMPUTER_C]));
        let account = key(1);
        let subject = Subject::Account(account.address());
        let first = told(&store, "person", COMPUTER_A, &[], &account).unwrap();
        assert_eq!(first.row.may_answer, names(&[COMPUTER_A]));
        // Unknown to the row and not its successor: the kept row is told as it is.
        assert_eq!(told(&store, "person", COMPUTER_B, &[], &account).unwrap().row, first.row);
        // The same computer under its new id: the row now names it alone, at the next revision, believed for the address.
        let moved = told(&store, "person", COMPUTER_B, &names(&[COMPUTER_A]), &account).unwrap();
        assert!(moved.believed(&account.address()));
        assert_eq!((moved.row.revision, moved.row.copy_keepers.clone(), moved.row.may_answer.clone()), (2, names(&[COMPUTER_B]), names(&[COMPUTER_B])));
        assert_eq!(read(&store, "person", &subject).unwrap().unwrap().value, moved.row, "the moved row is kept");
        // A row that already names the computer (as a live repair left it at revision 2) is left at its revision.
        assert_eq!(told(&store, "person", COMPUTER_B, &names(&[COMPUTER_A]), &account).unwrap().row, moved.row, "moved once");
        // A row naming only a device another state enrolled (COMPUTER_C, not among this computer's earlier ids) stays.
        let other_state = Store::new(&memory);
        let other_account = key(4);
        let other_subject = Subject::Account(other_account.address());
        keep_public_key(&other_state, "someone", &other_account).unwrap();
        classify_booted(&other_state, "someone", &[COMPUTER_C]);
        edit(&other_state, "someone", &other_subject, &change(None, 0, &[COMPUTER_C], &[COMPUTER_C]), &other_account, &Value::Null).unwrap();
        let theirs = read(&other_state, "someone", &other_subject).unwrap().unwrap().value;
        assert_eq!(told(&other_state, "someone", COMPUTER_B, &names(&[COMPUTER_A]), &other_account).unwrap().row, theirs);
        // A row that also names another computer is the owner's: nothing moves.
        edit(&store, "person", &subject, &change(None, 2, &[COMPUTER_B, COMPUTER_C], &[COMPUTER_B]), &account, &Value::Null).unwrap();
        let shared = read(&store, "person", &subject).unwrap().unwrap().value;
        assert_eq!(told(&store, "person", COMPUTER_A, &names(&[COMPUTER_B]), &account).unwrap().row, shared);
        // A row with voters is the owner's too.
        let voting = Change { voters: names(&[COMPUTER_B]), ..change(None, 3, &[COMPUTER_B], &[COMPUTER_B]) };
        edit(&store, "person", &subject, &voting, &account, &Value::Null).unwrap();
        let voted = read(&store, "person", &subject).unwrap().unwrap().value;
        assert_eq!(told(&store, "person", COMPUTER_A, &names(&[COMPUTER_B]), &account).unwrap().row, voted);
    }

    #[test]
    fn the_report_parses_and_refuses_bad_values() {
        let good = br#"{"storage":{"bytes":1048576},"reach":"https://computer.example","cost_per_month_cents":500,
            "contained_tools":true,"takes_new_accounts":true}"#;
        let report = ComputerReport::parse(good).expect("a valid report parses");
        assert_eq!(report.storage, Budget::Bytes(1048576));
        assert_eq!(report.always_on, None, "being on all the time is not required");
        let unknown = br#"{"storage":{"bytes":1},"reach":"r","cost_per_month_cents":0,"contained_tools":false,
            "takes_new_accounts":false,"machine":"x"}"#;
        let kept = ComputerReport::parse(unknown).expect("a key the report does not declare does not refuse it");
        assert_eq!(kept.unknown_keys.get("machine"), Some(&serde_json::json!("x")), "the unknown key is kept, not dropped");
        let empty_budget = br#"{"storage":{"bytes":0},"reach":"r","cost_per_month_cents":0,"contained_tools":false,"takes_new_accounts":false}"#;
        assert!(ComputerReport::parse(empty_budget).is_none());
        assert!(ComputerReport::parse(b"not json").is_none());
    }

    #[test]
    fn a_declared_hosting_app_report_takes_each_missing_field_from_the_shipped_report() {
        let declared = serde_json::json!({"takes_new_accounts": true, "reach": "https://app.example"});
        let report = report_over_defaults(&declared).expect("a partial report fills in from the shipped one");
        assert!(report.takes_new_accounts);
        assert_eq!(report.reach, "https://app.example");
        assert_eq!(report.storage, settings().this_computer.storage);
        assert_eq!(report.cost_per_month_cents, settings().this_computer.cost_per_month_cents);
        assert!(report_over_defaults(&serde_json::json!({"storage": {"bytes": 0}})).is_none(), "a bad declared value still refuses the report");
    }

    #[test]
    fn a_computer_reports_its_local_ports_or_none() {
        let base = r#""storage":{"bytes":1},"reach":"r","cost_per_month_cents":0,"contained_tools":false,"takes_new_accounts":false"#;
        let pool = ComputerReport::parse(format!("{{{base},\"local_ports\":{{\"a-port\":28092}}}}").as_bytes()).unwrap();
        assert_eq!(pool.local_port("a-port"), Some(28092));
        assert_eq!(pool.local_port("another"), None);
        let none = ComputerReport::parse(format!("{{{base}}}").as_bytes()).unwrap();
        assert_eq!(none.local_port("a-port"), None, "a computer with no ports reports none");
        for bad in [r#"{"a":0}"#, r#"{"a":65536}"#, r#"{"a":"10.0.0.1:28092"}"#, r#"{"":1}"#, r#"{"A":1}"#, r#"{"a":-1}"#, r#"[1]"#] {
            let bad = format!("{{{base},\"local_ports\":{bad}}}");
            assert!(ComputerReport::parse(bad.as_bytes()).is_none(), "{bad} is not a port list");
        }
    }

    #[test]
    fn the_default_report_names_no_port_and_the_hosting_app_report_is_its_launchers() {
        assert!(settings().this_computer.local_ports.is_empty(), "a computer with no report has no local ports");
        assert!(settings().this_computer.program_folders.is_empty(), "a computer with no report has no program folders");
        // This repository's made-up launcher (tests/fixtures/product-settings.json) declares a hosting app report.
        let app = hosting_app_report().expect("the launcher declares the hosting app's report");
        assert!(!app.local_ports.is_empty(), "the hosting app reports its local ports");
        assert!(!app.program_folders.is_empty(), "the hosting app reports its program folders");
    }

    #[test]
    fn a_sign_up_lands_only_on_a_live_computer_that_takes_new_accounts() {
        let taking = ComputerReport::parse(br#"{"storage":{"bytes":1},"reach":"r","cost_per_month_cents":0,"contained_tools":false,"takes_new_accounts":true}"#).unwrap();
        let closed = ComputerReport { takes_new_accounts: false, ..taking.clone() };
        let candidates = [
            Candidate { computer: COMPUTER_A, report: &closed, live: true },
            Candidate { computer: COMPUTER_B, report: &taking, live: false },
            Candidate { computer: COMPUTER_C, report: &taking, live: true },
        ];
        assert_eq!(landing_computer(&candidates), Some(COMPUTER_C));
        let none = [Candidate { computer: COMPUTER_A, report: &closed, live: true }];
        assert_eq!(landing_computer(&none), None);
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        classify_booted(&store, "person-new", &[COMPUTER_A, COMPUTER_B, COMPUTER_C]);
        assert_eq!(land_new_account(&store, "person-new", &none, &account), Err(crate::cause!(Refused::NoComputer)));
        let row = land_new_account(&store, "person-new", &candidates, &account).expect("the first row is written");
        assert_eq!(row.value.copy_keepers, names(&[COMPUTER_C]));
        assert_eq!(row.value.revision, 1);
        assert_eq!(land_new_account(&store, "person-new", &candidates, &account), Err(crate::cause!(Refused::Stale)));
    }

    /// A stage 1 row as stage 1 wrote it: no voters, signed over bytes that end after the may-answer list.
    fn stage_one(account: &AccountKey, revision: u64, copy_keepers: &[&str], signer: &AccountKey) -> StageOneRow {
        let mut row = StageOneRow { account: account.address(), pursuit: None, revision, copy_keepers: names(copy_keepers), may_answer: names(copy_keepers), signature: String::new() };
        let mut bytes = Vec::new();
        push_text(&mut bytes, &settings().signed_domain);
        push_text(&mut bytes, &row.account);
        push_text(&mut bytes, "");
        bytes.extend_from_slice(&revision.to_be_bytes());
        push_list(&mut bytes, &row.copy_keepers);
        push_list(&mut bytes, &row.may_answer);
        row.signature = hex_text(signer.pair.sign(&bytes).as_ref());
        row
    }

    #[test]
    fn a_stage_one_row_is_signed_again_with_voters_at_start() {
        let memory = memory();
        let store = Store::new(&memory);
        let account = key(1);
        let id = Subject::Account(account.address()).row_id();
        let old = Row { id: id.clone(), account: "person-old".into(), expires_at: 0, value: stage_one(&account, 4, &[COMPUTER_A], &account) };
        store.insert(Family::Computers, &old).unwrap();
        assert!(store.get::<ComputersRow>(Family::Computers, &id).is_err(), "a stage 1 row does not read as a row with voters");

        let told = told(&store, "person-old", COMPUTER_A, &[], &account).expect("the start signs the row again and tells it");
        assert_eq!(told.row.revision, 5);
        assert_eq!(told.row.copy_keepers, names(&[COMPUTER_A]));
        assert_eq!(told.row.may_answer, names(&[COMPUTER_A]));
        assert!(told.row.voters.is_empty(), "no voters: the account writes as it did until the owner names them");
        assert!(told.row.verify(account.public_key()));
        assert_eq!(sign_stage_one_rows(&store, "person-old", &account), Ok(0), "a second start changes nothing");

        // A stage 1 row another key signed is not signed again, and is still not believed.
        let other = key(2);
        let memory = self::memory();
        let store = Store::new(&memory);
        let forged = Row { id: id.clone(), account: "person-old".into(), expires_at: 0, value: stage_one(&account, 4, &[COMPUTER_B], &other) };
        store.insert(Family::Computers, &forged).unwrap();
        keep_public_key(&store, "person-old", &account).unwrap();
        assert_eq!(sign_stage_one_rows(&store, "person-old", &account), Ok(0));
        assert!(store.get::<StageOneRow>(Family::Computers, &id).unwrap().is_some(), "the forged row is left as it was");
    }


    /// A small generator that draws the same cases on every run, so a failing case is found again.
    struct Draw(u64);
    impl Draw {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn pick(&mut self, pool: &[String]) -> Vec<String> {
            pool.iter().filter(|_| self.below(2) == 0).cloned().collect()
        }
    }

    fn pool() -> Vec<String> {
        ["a", "b", "c", "d", "e"].iter().map(|c| c.repeat(64)).collect()
    }

    /// A random valid row of the account `pair`, at revision 1.
    fn random_row(draw: &mut Draw, pair: &AccountKey) -> Change {
        let pool = pool();
        let mut keeps_copy = draw.pick(&pool);
        if keeps_copy.is_empty() {
            keeps_copy.push(pool[draw.below(pool.len())].clone());
        }
        let mut may_answer: Vec<String> = keeps_copy.iter().filter(|_| draw.below(2) == 0).cloned().collect();
        if may_answer.is_empty() {
            may_answer.push(keeps_copy[0].clone());
        }
        let _ = pair;
        let voters = draw.pick(&pool);
        if voters.is_empty() {
            // Two may-answer computers and no voters are two writers (`Refused::NoWriterRow`): a first row has one.
            may_answer.truncate(1);
        }
        Change { pursuit: None, expected_revision: 0, copy_keepers: keeps_copy, may_answer: may_answer, voters }
    }

    fn random_operation(draw: &mut Draw) -> Operation {
        let pool = pool();
        let computer = pool[draw.below(pool.len())].clone();
        match draw.below(5) {
            0 => Operation::AddComputer { pursuit: None, computer, may_answer: draw.below(2) == 0, voter: draw.below(2) == 0 },
            1 => Operation::RemoveComputer { pursuit: None, computer },
            2 => Operation::SetInUse { pursuit: None, computer, in_use: draw.below(3) != 0 },
            3 => Operation::MoveWriter { pursuit: None, computer },
            _ => Operation::Set { pursuit: None, keeps_copy: draw.pick(&pool), may_answer: draw.pick(&pool), voters: draw.pick(&pool) },
        }
    }

    /// The row now: signed by the account's key, in a shape every computer believes, with a computer in use.
    fn assert_valid(store: &Store<'_>, pair: &AccountKey, what: &str) -> ComputersRow {
        let row = read(store, "person", &Subject::Account(pair.address())).unwrap().expect(what).value;
        assert!(row.verify(pair.public_key()), "{what}: signed by the account: {row:?}");
        assert!(!row.may_answer.is_empty() && !row.copy_keepers.is_empty(), "{what}: a computer holds and one is in use: {row:?}");
        row
    }

    #[test]
    fn every_pair_of_computers_operations_on_random_rows_in_both_orders_and_at_once_ends_in_a_valid_signed_row() {
        let pair = key(1);
        let mut draw = Draw(0x5eed);
        let clock = crate::storage::time_source::fixed(1_000);
        let heard_names = pool();
        let heard_refs: Vec<&str> = heard_names.iter().map(String::as_str).collect();
        let _heard = copy_rule::hear_for_test(&*clock, &heard_refs);
        let dir = tempfile::tempdir().unwrap();
        for case in 0..120 {
            let start = random_row(&mut draw, &pair);
            let (first, second) = (random_operation(&mut draw), random_operation(&mut draw));
            for (order, ops) in [("in order", [&first, &second]), ("reversed", [&second, &first])] {
                let memory = memory();
                let store = Store::new(&memory);
                keep_public_key(&store, "person", &pair).unwrap();
                copy_rule::catch_up_for_test(&memory, "person", &heard_refs);
                booted(&store, &pool());
                edit(&store, "person", &Subject::Account(pair.address()), &start, &pair, &Value::Null).unwrap();
                for op in ops {
                    match apply(&store, "person", op, &pair, &Value::Null, &*clock) {
                        Ok(row) => assert_eq!(row.value, assert_valid(&store, &pair, "applied")),
                        // A refusal changes nothing: removing the only computer that keeps a copy is deleting the account, and
                        // a second may-answer computer with no voters is a second writer.
                        Err(Refused::Invalid(_) | Refused::NoWriterRow(_)) => {}
                        Err(other) => panic!("case {case} {order} {op:?}: {other:?}"),
                    }
                    assert_valid(&store, &pair, &format!("case {case} {order} after {op:?}"));
                }
            }
            // At once: two threads apply the two operations to one store; each is applied again on Stale.
            let folder = dir.path().join(format!("case-{case}"));
            std::fs::create_dir_all(&folder).unwrap();
            let shared = crate::account::rows::open(&folder).unwrap();
            {
                let store = Store::new(&*shared);
                keep_public_key(&store, "person", &pair).unwrap();
                copy_rule::catch_up_for_test(&*shared, "person", &heard_refs);
                booted(&store, &pool());
                edit(&store, "person", &Subject::Account(pair.address()), &start, &pair, &Value::Null).unwrap();
            }
            std::thread::scope(|scope| {
                for op in [&first, &second] {
                    let (shared, pair, clock) = (shared.clone(), &pair, clock.clone());
                    scope.spawn(move || {
                        let store = Store::new(&*shared);
                        match apply(&store, "person", op, pair, &Value::Null, &*clock) {
                            Ok(_) | Err(Refused::Invalid(_) | Refused::NoWriterRow(_)) => {}
                            Err(other) => panic!("case {case} at once {op:?}: {other:?}"),
                        }
                    });
                }
            });
            assert_valid(&Store::new(&*shared), &pair, &format!("case {case} at once"));
        }
    }

    #[test]
    fn computers_operations_keep_the_rows_rules() {
        let pair = key(1);
        let memory = memory();
        let store = Store::new(&memory);
        keep_public_key(&store, "person", &pair).unwrap();
        booted(&store, &pool());
        let computer = |name: &str| name.repeat(64);
        let (a, b, c, d) = (computer("a"), computer("b"), computer("c"), computer("d"));
        copy_rule::catch_up_for_test(&memory, "person", &[a.as_str(), b.as_str(), c.as_str(), d.as_str()]);
        let clock = crate::storage::time_source::fixed(1_000);
        let many: Vec<String> = (0..17u8).map(|n| format!("{:064x}", u64::from(n) + 1)).collect();
        let heard: Vec<&str> = [a.as_str(), b.as_str(), c.as_str(), d.as_str()].into_iter().chain(many.iter().map(String::as_str)).collect();
        let _heard = copy_rule::hear_for_test(&*clock, &heard);
        edit(&store, "person", &Subject::Account(pair.address()),
            &Change { pursuit: None, expected_revision: 0, copy_keepers: vec![a.clone()], may_answer: vec![a.clone()], voters: vec![a.clone()] }, &pair, &Value::Null).unwrap();
        // A change of three voters is made one voter step per edit.
        let set = Operation::Set { pursuit: None, keeps_copy: vec![a.clone()], may_answer: vec![], voters: vec![b.clone(), c.clone(), d.clone()] };
        let row = apply(&store, "person", &set, &pair, &Value::Null, &*clock).unwrap().value;
        assert_eq!(row.voters, vec![b.clone(), c.clone(), d.clone()]);
        assert_eq!(row.revision, 5, "three voters added and one removed, one edit each");
        assert_eq!(row.may_answer, vec![a.clone()], "with none named in use, the first holder is");
        // Removing the computer in use moves "in use" to another computer that keeps a copy in the same edit, a voter first.
        apply(&store, "person", &Operation::AddComputer { pursuit: None, computer: c.clone(), may_answer: false, voter: false }, &pair, &Value::Null, &*clock).unwrap();
        let row = apply(&store, "person", &Operation::RemoveComputer { pursuit: None, computer: a.clone() }, &pair, &Value::Null, &*clock).unwrap().value;
        assert_eq!((row.copy_keepers.clone(), row.may_answer.clone()), (vec![c.clone()], vec![c.clone()]), "{row:?}");
        // Removing the only computer that keeps a copy is deleting the account, not a computers operation.
        assert_eq!(apply(&store, "person", &Operation::RemoveComputer { pursuit: None, computer: c.clone() }, &pair, &Value::Null, &*clock).err(), Some(crate::cause!(Refused::Invalid)));
        // Moving the writer makes the computer a computer that keeps a copy in use and a voter; the same operation again changes nothing.
        let moved = apply(&store, "person", &Operation::MoveWriter { pursuit: None, computer: d.clone() }, &pair, &Value::Null, &*clock).unwrap().value;
        assert!(moved.copy_keepers.contains(&d) && moved.may_answer.contains(&d) && moved.voters.contains(&d), "{moved:?}");
        let again = apply(&store, "person", &Operation::MoveWriter { pursuit: None, computer: d.clone() }, &pair, &Value::Null, &*clock).unwrap().value;
        assert_eq!(again.revision, moved.revision, "an operation that is already true makes no edit");
        // The account's computers limit still refuses a row naming more computers than it allows.
        booted(&store, &many);
        let over = Operation::Set { pursuit: None, keeps_copy: many, may_answer: vec![], voters: vec![] };
        assert_eq!(apply(&store, "person", &over, &pair, &Value::Null, &*clock).err(), Some(crate::cause!(Refused::OverLimit)));
        // The account routes' input reads as an operation by its `op`.
        let read: Operation = serde_json::from_value(serde_json::json!({"op": "set-in-use", "computer": b})).unwrap();
        assert_eq!(read, Operation::SetInUse { pursuit: None, computer: b, in_use: true });
    }

}

crate::impl_caused!(Refused);

#[cfg(test)]
mod system_principal_tests {
    use super::*;
    use serde_json::json;

    fn signer(byte: u8) -> ComputerSigner {
        ComputerSigner::of(&crate::secrets::secrets_key::ComputerKey::from_bytes(vec![byte; 32]).unwrap()).unwrap()
    }

    /// One signed `key-check` ask, the fixture the sign-in tool's check of a computer's proof is tested against. Ed25519
    /// signs the same bytes the same way, so the fixture never changes unless the proof's bytes do.
    #[test]
    fn a_key_check_proof_matches_its_fixture_and_verifies_only_for_its_key() {
        let fixture: serde_json::Value = serde_json::from_slice(include_bytes!("computers/key-check-fixture.json")).unwrap();
        let computer = signer(7);
        let key_digest = blake3::hash(fixture["key"].as_str().unwrap().as_bytes()).to_hex().to_string();
        let at = fixture["at"].as_i64().unwrap();
        let signature = computer.sign_use("key-check", &[&key_digest], at).unwrap();
        assert_eq!(fixture["computer"], computer.computer_id());
        assert_eq!(fixture["part"], key_digest);
        assert_eq!(fixture["signature"], signature);
        assert!(verify_use("key-check", &computer.computer_id(), &[&key_digest], at, at, &signature));
        let other = blake3::hash(b"tr_another").to_hex().to_string();
        assert!(!verify_use("key-check", &computer.computer_id(), &[&other], at, at, &signature));
        assert!(!verify_use("session", &computer.computer_id(), &[&key_digest], at, at, &signature));
    }

    fn write(kind: &str) -> serde_json::Value {
        json!({"records": [{"id": "a", "type": kind, "value": {}}]})
    }

    #[test]
    fn a_command_proof_is_refused_for_a_different_write() {
        let computer = signer(7);
        let signed = command_parts("account", "@own-records", "records:write", "key-1", 1, &write("secret-value"));
        let refs: Vec<&str> = signed.iter().map(String::as_str).collect();
        let now = 1_000_000;
        let token = command_credential(&computer, &refs, now).unwrap();
        let (id, at, signature) = read_command_credential(&token).unwrap();
        assert_eq!(id, computer.computer_id());
        assert!(verify_use("command", &id, &refs, at, now, &signature), "the credential verifies over the command it signed");
        let other = command_parts("account", "@own-records", "records:write", "key-1", 1, &write("contacts"));
        let other_refs: Vec<&str> = other.iter().map(String::as_str).collect();
        assert!(!verify_use("command", &id, &other_refs, at, now, &signature), "the same credential does not verify a different write");
        let renumbered = command_parts("account", "@own-records", "records:write", "key-1", 2, &write("secret-value"));
        let renumbered_refs: Vec<&str> = renumbered.iter().map(String::as_str).collect();
        assert!(!verify_use("command", &id, &renumbered_refs, at, now, &signature), "nor the same write at another generation");
    }

    #[test]
    fn a_computer_the_row_does_not_name_is_refused() {
        let account = AccountKey::generate().unwrap();
        let named = signer(7).computer_id();
        let unnamed = signer(8).computer_id();
        let row = ComputersRow::sign_with_voters(&account.address(), 1, std::slice::from_ref(&named), std::slice::from_ref(&named), std::slice::from_ref(&named), &account).unwrap();
        assert!(names_computer(&row, &named), "the computer the row names is accepted");
        assert!(!names_computer(&row, &unnamed), "a computer the row does not name is refused");
    }

    #[test]
    fn a_listed_kind_is_a_system_write_and_an_unlisted_one_is_refused() {
        assert!(system_permits("@held-values", "records:write", &write("secret-value")), "a held-value write passes");
        assert!(!system_permits("@held-values", "records:write", &write("contacts")), "an unlisted kind is refused");
        assert!(!system_permits("@held-values", "records:write", &json!({"records": [{"type": "secret-value"}, {"type": "contacts"}]})), "one unlisted record refuses the write");
        assert!(!system_permits("@own-records", "records:read", &write("secret-value")), "an operation the DATA does not name is refused");
        assert!(!system_permits("@held-values", "records:write", &json!({"records": []})), "a write with no records is refused");
        use base64::Engine as _;
        let sealed = json!({"sealed": base64::engine::general_purpose::STANDARD.encode(b"sealed bytes")});
        assert!(system_permits("@held-values", "held-values:put-sealed", &sealed), "a queued put's sealed bytes pass");
        assert!(!system_permits("@held-values", "held-values:put-sealed", &json!({"sealed": "not base64!", })), "bytes that are not base64 are refused");
        assert!(!system_permits("@held-values", "held-values:put-sealed", &json!({"sealed": "AA==", "value": "plain"})), "a plain value field is refused");
        assert!(!system_permits("@held-values", "held-values:put-sealed", &json!({"sealed": base64::engine::general_purpose::STANDARD.encode(vec![0u8; crate::secrets::secrets_key::MOST_SEALED_BYTES + 1])})), "more than 64 KiB is refused");
        assert!(!system_permits("@own-records", "held-values:put-sealed", &sealed), "the queued put names only @held-values");
        assert!(system_permits("@held-values", "held-values:remove-sealed", &sealed), "a queued removal's sealed bytes pass");
        assert!(!system_permits("@held-values", "held-values:remove-sealed", &json!({"sealed": "AA==", "value": "plain"})), "a removal with a plain field is refused");
        assert!(!system_permits("@own-records", "records:write", &write("secret-value")), "a store the DATA does not list is refused, the account's own book included");
        assert!(!system_permits("other-account:own-records", "records:write", &write("secret-value")), "another account's store is refused");
    }
}
