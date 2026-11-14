//! The account routes' own sign-in: how a person, an AI app and a script prove who they
//! are to trillion-local, written in Rust and stored in trillion-local's own storage.
//!
//! It owns, and only owns: OAuth 2.1 for AI apps (RFC 8414 metadata, RFC 7591
//! registration, authorization code with S256 PKCE, refresh rotation, RFC 7009
//! revocation), passkeys (WebAuthn registration and assertion), the other ways to
//! sign in (`ways.rs`), browser sessions, and personal keys. It knows no product feature (no invite, space,
//! offer, plan or screen) and no host: the public origin is supplied, the
//! storage is any `Storage` supply over the `sign_in` schema in
//! `sign_in/families.json`.
//!
//! Where its values come from (docs/placement-decision/stage-3-lists.md):
//! - the account's own numbers (how long a token, a code, a session, a challenge lasts) are a row in the account's own
//!   lists (`lists.rs`), read at each use, so a change takes effect at the next request; a missing row is refused
//!   (`Error::SettingsMissing`), never filled in; its ways to sign in besides passkeys and their limits are a second
//!   row there (`ways.rs` `WaySettings`), read the same way;
//! - the computer's own values (body limit, relying party labels, expired rows per write) are the computer's
//!   (`ComputerSignIn`, chosen once at start from the computer config);
//! - the account routes' contract (operation names, scopes and what each reaches, the cookie name, the key prefix, the file
//!   names) is code (`contract`): every client, every computer and the forwarder must agree on it before any row is read.
//!   Each literal is listed in capabilities.json, in the row that lets people and AIs in.
//! - its words are a third row there (`words_row.rs`), read at each page and each worded answer; a missing row
//!   answers the code `sign_in_words_missing` alone.
//!
//! Secrets are never stored or logged: tokens and codes are kept by the SHA-256
//! hex of their text, sessions and personal keys by the BLAKE3 hex of theirs.
//!
//! Files:
//! - `store.rs`    typed rows over the `sign_in` families
//! - `lists.rs`    the account's own sign-in settings row
//! - `words_row.rs` the account's own sign-in words row
//! - `tokens.rs`   secret making, hashing, PKCE, constant-time comparison
//! - `oauth.rs`    metadata, client registration, authorize, token, revoke, bearer check
//! - `passkeys.rs` WebAuthn options, registration and sign-in
//! - `sessions.rs` browser sessions and their cookie
//! - `keys.rs`     personal keys: issue, list, turn off, check
//! - `pages.rs`    the HTML pages and their small passkey script
//! - `ways.rs`     the other ways to sign in (password, codes by email or text, an authenticator, backup codes,
//!   a personal key), one code path over the account's ways row
//! - `way_pages.rs` their pages and the account's Sign-in & security page
//! - `routes.rs`   the HTTP routes over all of the above
//! - `known.rs`    which passkeys are known, and which changes to ways in need a known passkey to confirm
//! - `calls.rs`    how many calls one sign-in makes in a window, counted as each call is admitted, before any work runs
//!
//! The sign-in's own numbers that are no account's setting (the calls each sign-in may make, how long a link that
//! opens a signed-in web page works, each passkey provenance's wait) are `settings.json` beside this file (`settings`).

pub(crate) mod approve;
pub(crate) mod assets;
pub(crate) mod calls;
pub(crate) mod email_index;
pub(crate) mod keys;
pub(crate) mod known;
pub(crate) mod lists;
pub(crate) mod oauth;
pub(crate) mod pages;
pub(crate) mod shell;
pub(crate) mod passkeys;
pub(crate) mod routes;
pub(crate) mod set_password;
pub(crate) mod sessions;
pub(crate) mod store;
pub(crate) mod tokens;
pub(crate) mod way_pages;
pub(crate) mod ways;
pub(crate) mod words_row;

#[cfg(test)]
#[path = "sign_in/release_fixtures_tests.rs"]
mod release_fixtures_tests;

use serde::{Deserialize, Serialize};
use crate::account::computers::UnknownKeys;
use std::sync::OnceLock;

/// An account's user id: the key its sign-in rows are kept under (`ways::current`, the email index's operator). Never an
/// address, so a row is never read or written under the name of the account's key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UserId<'a>(pub(crate) &'a str);

/// An account's address: the name its signing key gives it, the name a sign-up claims an email for and a forwarder sends by.
/// Never a user id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Address<'a>(pub(crate) &'a str);

/// The account routes' contract: the names every client, every computer and the forwarder agree on. Not a setting of an account
/// or a computer, so not a row (docs/placement-decision/stage-3-lists.md, DECISION NEEDED 1).
#[derive(Debug)]
pub(crate) struct Contract {
    /// The account's sign-in database, in its state folder.
    pub database_file: String,
    /// The session cookie's name.
    pub session_cookie: String,
    /// Every personal key starts with it.
    pub personal_key_prefix: String,
    /// What an AI app may be granted.
    pub scopes: Vec<String>,
    /// Held only by personal keys (never offered over OAuth): reaches the sign-in's own management.
    pub account_scope: String,
    /// Which route address and methods each scope covers (`*` is any characters).
    pub reach: std::collections::BTreeMap<String, Vec<(String, String)>>,
    /// The account's own full key (`sign_in/reach.json` `full_key`): what a sign-in holding every one of its scopes
    /// also reaches, so the AI holding the account's own key is never less than the person's own page.
    pub full_key: FullKey,
    /// The sign-in's own door operations.
    pub door: DoorOperations,
    /// Written beside the database at each start, naming the account and origin the routes serve, so the command line
    /// can make a passkey link or a key on this computer.
    pub door_note_file: String,
}

/// `sign_in/reach.json`: each scope's reach, and the account's own full key.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReachData {
    #[serde(rename = "_what")]
    _what: String,
    scopes: std::collections::BTreeMap<String, Vec<(String, String)>>,
    full_key: FullKey,
}

/// The account's own full key: a sign-in holding every scope in `holds` also reaches `reach`, except the operations
/// that prove the person is present (`needs_person`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FullKey {
    pub holds: Vec<String>,
    pub reach: Vec<(String, String)>,
    pub needs_person: Vec<NeedsPerson>,
}

/// One operation only the person present may make, and why.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NeedsPerson {
    pub address: String,
    pub method: String,
    pub why: String,
}

/// The sign-in's own door operations, by name. `principal` answers who the presented credential is, to the public
/// forwarder that carries a request to this computer, and is the one door operation every current sign-in may make.
#[derive(Debug)]
pub(crate) struct DoorOperations {
    pub resource: String,
    pub principal: String,
    pub passkey_link: String,
    pub waiting: String,
    pub withdraw: String,
    pub keys: String,
    pub issue_key: String,
    pub turn_off_key: String,
    pub apps: String,
    pub disconnect_app: String,
    pub computers: String,
    pub set_computers: String,
    pub settings: String,
    pub set_settings: String,
    /// The account's limits row (src/account/computers/limits_row.rs) with the number each limit comes to now, and one
    /// plan's or contract's rows written or ended.
    pub limits: String,
    pub set_limits: String,
    pub ways: String,
    pub set_ways: String,
    /// The account's words row (`words_row.rs`).
    pub words: String,
    pub set_words: String,
    pub remove_way: String,
    pub deliveries: String,
    pub set_delivery: String,
    /// The account's copy rule (src/account/computers/copy_rule.rs): its rows, live counts, `short_by` and runs.
    pub copies: String,
    pub set_copies: String,
    pub set_copies_rules: String,
    pub set_offered_computers: String,
    pub set_host_kind: String,
    /// The computers row shown as the list `computers`, and one row of it written (a computers operation).
    pub computers_list: String,
    pub set_computers_list_row: String,
    /// The account's passkeys as `known.rs` sees them, its recovery and the notices it was told; one passkey removed
    /// (never the last way in); one vouched for by a known passkey; a recovery started or cancelled; and the passkey
    /// ceremony that confirms one guarded change (old trillion src/passkey-list.mjs, src/passkey-authority.mjs).
    pub passkeys: String,
    pub remove_passkey: String,
    pub vouch_passkey: String,
    pub recover_passkeys: String,
    pub confirm_change: String,
    /// The account's signed-in browsers, and one of them ended (old src/account-routes.mjs `account/sessions/end`).
    pub sessions: String,
    pub end_session: String,
    /// A one-use link that opens a signed-in web page (old src/web-sign-in.mjs, `sessions.rs` `web_link`).
    pub web_link: String,
    /// The account's own AI-app clients with a fixed client id (old src/fixed-oauth-clients.mjs, `oauth.rs` `fixed`).
    pub clients: String,
    pub add_client: String,
    pub remove_client: String,
    /// Delete the account completely (src/account/erase.rs, old trillion src/account-routes.mjs:859 `account/delete`):
    /// begun once with a recent sign-in, then each call takes the deletion's next bounded steps; and where the deletion
    /// stands (old src/account-erasure-policy.mjs:78 `accountErasureState`), with its wait ended now on `redrive`.
    pub delete_account: String,
    pub deletion: String,
}

/// The account routes' contract, made once.
pub(crate) fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        let text = |list: &[&str]| list.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        // Each scope's reach, and the account's own full key's, are DATA (`sign_in/reach.json`).
        let data: ReachData = serde_json::from_slice(include_bytes!("sign_in/reach.json")).expect("sign_in/reach.json is valid");
        let reach = data.scopes;
        Contract {
            database_file: "sign-in.sqlite".into(),
            session_cookie: "__Host-trillion_session".into(),
            personal_key_prefix: "nm_".into(),
            scopes: text(&["records", "tools"]),
            account_scope: "sign-in".into(),
            reach,
            full_key: data.full_key,
            door: DoorOperations {
                resource: "@sign-in".into(),
                principal: "sign-in:principal".into(),
                passkey_link: "sign-in:passkey-link".into(),
                waiting: "sign-in:waiting".into(),
                withdraw: "sign-in:withdraw".into(),
                keys: "sign-in:keys".into(),
                issue_key: "sign-in:issue-key".into(),
                turn_off_key: "sign-in:turn-off-key".into(),
                apps: "sign-in:apps".into(),
                disconnect_app: "sign-in:disconnect-app".into(),
                computers: "sign-in:places".into(),
                set_computers: "sign-in:set-places".into(),
                settings: "sign-in:settings".into(),
                set_settings: "sign-in:set-settings".into(),
                limits: "sign-in:limits".into(),
                set_limits: "sign-in:set-limits".into(),
                ways: "sign-in:ways".into(),
                set_ways: "sign-in:set-ways".into(),
                words: "sign-in:words".into(),
                set_words: "sign-in:set-words".into(),
                remove_way: "sign-in:remove-way".into(),
                deliveries: "sign-in:deliveries".into(),
                set_delivery: "sign-in:set-delivery".into(),
                copies: "sign-in:copies".into(),
                set_copies: "sign-in:set-copies".into(),
                set_copies_rules: "sign-in:set-copies-rules".into(),
                set_offered_computers: "sign-in:set-offered-computers".into(),
                set_host_kind: "sign-in:set-host-kind".into(),
                computers_list: "sign-in:computers-list".into(),
                set_computers_list_row: "sign-in:set-computers-list-row".into(),
                passkeys: "sign-in:passkeys".into(),
                remove_passkey: "sign-in:remove-passkey".into(),
                vouch_passkey: "sign-in:vouch-passkey".into(),
                recover_passkeys: "sign-in:recover-passkeys".into(),
                confirm_change: "sign-in:confirm-change".into(),
                sessions: "sign-in:sessions".into(),
                end_session: "sign-in:end-session".into(),
                web_link: "sign-in:web-link".into(),
                clients: "sign-in:clients".into(),
                add_client: "sign-in:add-client".into(),
                remove_client: "sign-in:remove-client".into(),
                delete_account: "sign-in:delete-account".into(),
                deletion: "sign-in:deletion".into(),
            },
            door_note_file: "sign-in-door.json".into(),
        }
    })
}

/// The sign-in's own operations, by name: the same names `contract()` lists.
pub(crate) fn operations() -> &'static DoorOperations {
    &contract().door
}

/// The sign-in's own numbers that are no account's setting, from `settings.json` beside this file.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub calls: calls::CallSettings,
    /// How long a link that opens a signed-in web page works (old trillion src/web-sign-in.mjs:17 `WEB_SIGN_IN_SECONDS`).
    pub web_link_seconds: u64,
    pub authority: known::AuthoritySettings,
    /// Which addresses an app may register for its sign-in to return to (`oauth.rs` `acceptable_redirect`).
    pub redirects: oauth::RedirectSettings,
    /// The bounded public registration identifier, shared by the root forwarder and every account.
    pub public_registration: oauth::PublicSettings,
}

/// The sign-in's settings, read once.
pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        let settings: Settings = serde_json::from_slice(include_bytes!("sign_in/settings.json")).expect("sign_in/settings.json is valid");
        assert!(settings.calls.valid(), "sign_in/settings.json names valid call tiers and a default rule");
        assert!(settings.authority.valid(), "sign_in/settings.json names every passkey provenance");
        assert!((1..=3600).contains(&settings.web_link_seconds), "sign_in/settings.json keeps a web link short-lived");
        assert!(settings.redirects.valid(), "sign_in/settings.json keeps javascript, data and file refused as redirect schemes");
        settings
    })
}

/// The computer's own sign-in values: needed before an account is known (the body limit of a request), or about the
/// computer rather than an account. A computer takes them from its config (`choose_computer`); the hosting app, which has no
/// computer config yet, from `computers/settings.json` `this_computer_sign_in`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerSignIn {
    /// Leading labels of the origin's host the passkey relying party leaves out (`passkeys.rs` `relying_party`): a
    /// passkey made on the parent domain or any of its hosts signs in on every one of them (never fewer than two
    /// labels; an IP address is kept whole).
    pub relying_party_drop_labels: usize,
    /// The largest request body the sign-in routes read.
    pub max_body_bytes: usize,
    /// Most expired rows of one family one write of a new row of that family deletes.
    pub expired_rows_per_write: usize,
    /// Keys this engine does not know: kept, logged once when the config is checked, never refused.
    #[serde(flatten)]
    pub unknown_keys: UnknownKeys,
}

/// This computer's sign-in values when its config leaves them out: the shipped ones (`computers/settings.json`).
pub(crate) fn shipped_computer() -> ComputerSignIn {
    crate::account::computers::settings().this_computer_sign_in.clone()
}

impl ComputerSignIn {
    fn valid(&self) -> bool {
        self.relying_party_drop_labels <= 8 && (1024..=1 << 20).contains(&self.max_body_bytes) && self.expired_rows_per_write <= 10_000
    }
}

static CHOSEN_COMPUTER: OnceLock<ComputerSignIn> = OnceLock::new();

/// Take `values` as this computer's sign-in values for the rest of the process (the computer config's `sign_in`). Only the
/// first choice counts; a second, different one or invalid values are refused.
pub fn choose_computer(values: ComputerSignIn) -> std::result::Result<(), crate::refusal_cause::CodedError<&'static str>> {
    if !values.valid() {
        return Err(crate::refusal_cause::CodedError::new("the computer's sign-in values are refused"));
    }
    if CHOSEN_COMPUTER.get_or_init(|| values.clone()) != &values {
        return Err(crate::refusal_cause::CodedError::new("this process already has other sign-in values"));
    }
    Ok(())
}

/// This computer's sign-in values: the ones chosen at start, or the hosting app's (`computers/settings.json`).
pub(crate) fn computer() -> &'static ComputerSignIn {
    CHOSEN_COMPUTER.get().unwrap_or(&crate::account::computers::settings().this_computer_sign_in)
}

/// The account's idle-day limits (row field `idle_days`), in the shape the account opener takes. Read once when the
/// account opens; no production path reads them after that (they belong to the old account policy).
pub(crate) fn lifetimes(settings: &lists::AccountSettings) -> crate::account::AccountResult<crate::account::SignInRules> {
    crate::account::SignInRules::from_source_json(&settings.idle_days)
}

/// The rows an account starts with: its sign-in settings row (`lists.rs`), its ways row (`ways.rs`), and its copies row
/// and copy rules row (src/account/computers/copy_rule.rs). A computer's are
/// its config's `new_accounts`; the hosting app's are its product settings' `new_accounts` (src/native_boot.rs
/// `Selection::sign_in_rules`). They are written into an account when it is made, and into an account that opens
/// without them (one made before the row existed, or one restored without it), never again.
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq)]
pub struct StartingRows {
    #[serde(default = "shipped_sign_in")]
    pub sign_in: lists::AccountSettings,
    #[serde(default = "shipped_sign_in_ways")]
    pub sign_in_ways: ways::WaySettings,
    /// The account's sign-in words (`words_row.rs`): every word its sign-in pages, ways and operations say, and the
    /// words of the sign-up page that makes it.
    #[serde(default = "shipped_sign_in_words")]
    pub sign_in_words: pages::Words,
    /// The account's copies row: the least computers that keep a copy, vote, may answer and are always on
    /// (src/account/computers/copy_rule.rs).
    #[serde(default = "shipped_copies")]
    pub copies: crate::account::computers::copy_rule::CopySettings,
    /// The account's copy rules row: the `short_by` formula, the trigger rule that reads it and the workflow it starts.
    #[serde(default = "shipped_copies_rules")]
    pub copies_rules: crate::account::computers::copy_rule::CopyRules,
    /// The byte store each account this computer makes gets as its first files origin (src/account_files/bind.rs
    /// `NewAccountFiles`), written once when the account is made. Absent: a new account's files take no bytes until
    /// the account adds a store of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<crate::account_files::bind::NewAccountFiles>,
    /// The mail tool a sign-up's emailed code runs (`sign_up_delivery`): the tool, the place account whose vault holds its
    /// key, and the input the tool takes besides the address, subject and text. Absent: no code is offered on this computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_up_delivery: Option<SignUpDelivery>,
    /// Keys this engine does not know: kept, logged once when the config is checked, never refused.
    #[serde(flatten)]
    pub unknown_keys: UnknownKeys,
}

/// The shipped starting rows (`sign_in/new-accounts.json`). A config's missing row takes its shipped one, so a config
/// written before a row existed still starts an account. Each field names its own default, so the one-time read of this
/// file (which has every row) never reads a default.
pub(crate) fn shipped() -> &'static StartingRows {
    static SHIPPED: OnceLock<StartingRows> = OnceLock::new();
    SHIPPED.get_or_init(|| serde_json::from_slice(include_bytes!("sign_in/new-accounts.json")).expect("sign_in/new-accounts.json is valid"))
}

fn shipped_sign_in() -> lists::AccountSettings {
    shipped().sign_in.clone()
}

fn shipped_sign_in_ways() -> ways::WaySettings {
    shipped().sign_in_ways.clone()
}

fn shipped_sign_in_words() -> pages::Words {
    shipped().sign_in_words.clone()
}

fn shipped_copies() -> crate::account::computers::copy_rule::CopySettings {
    shipped().copies.clone()
}

fn shipped_copies_rules() -> crate::account::computers::copy_rule::CopyRules {
    shipped().copies_rules.clone()
}

/// A sign-up's code delivery as DATA (`new_accounts.sign_up_delivery`).
#[derive(Clone, Deserialize, Serialize, Debug, PartialEq)]
pub struct SignUpDelivery {
    pub tool: String,
    /// The address of the account whose place runs the tool (an account open on this computer); its vault holds the mail key.
    pub sending_account: String,
    pub input: serde_json::Map<String, serde_json::Value>,
}

impl StartingRows {
    /// Whether every row holds together.
    pub fn valid(&self) -> bool {
        self.sign_in.valid() && self.sign_in_ways.valid() && self.sign_in_words.covers(&self.sign_in_ways) && self.copies.valid() && self.copies_rules.valid()
            && self.files.as_ref().is_none_or(crate::account_files::bind::NewAccountFiles::valid)
    }

    /// Write each row `account` lacks at creation, once: a compare-and-set at revision 0, so two starts at once write one
    /// row and a row the owner has since changed is never replaced. The copies and copy rules rows are pinned here, and no
    /// later start writes them. Answers how many rows this call wrote.
    pub(crate) fn write_missing(&self, storage: &dyn crate::storage::Storage, account: &str) -> Result<usize> {
        let store = store::Store::new(storage);
        let mut written = self.write_lists_and_ways(&store, account)?;
        written += self.write_words(&store, account)?;
        written += crate::account::computers::copy_rule::write_missing(&store, account, &self.copies, &self.copies_rules)
            .map_err(|error| Error::Storage(error.cause()))?;
        Ok(written)
    }

    /// At each start: the words row the account lacks, and the repair of an older copy rules row. A missing lists or ways
    /// row is not written here: an account without it is refused, never filled in (`lists.rs`, `ways.rs`). A missing copies
    /// or rules row is not written here either: its values are read at use (`copy_rule::copies_source`, `rules_source`).
    pub(crate) fn write_missing_on_open(&self, storage: &dyn crate::storage::Storage, account: &str) -> Result<usize> {
        let store = store::Store::new(storage);
        let mut written = self.write_words(&store, account)?;
        written += crate::account::computers::copy_rule::repair_on_open(&store, account, &self.copies_rules)
            .map_err(|error| Error::Storage(error.cause()))?;
        Ok(written)
    }

    /// The lists and ways rows the account lacks, each written once at revision 0 (creation only).
    fn write_lists_and_ways(&self, store: &store::Store<'_>, account: &str) -> Result<usize> {
        let mut written = 0;
        if lists::read(store, account)?.is_none() {
            match lists::set(store, account, 0, self.sign_in.clone()) {
                Ok(_) => written += 1,
                Err(lists::Refused::Stale(_)) => {}
                Err(error) => return Err(Error::Storage(error.cause())),
            }
        }
        if ways::read(store, account).map_err(|error| Error::Storage(error.cause()))?.is_none() {
            match ways::set(store, account, 0, self.sign_in_ways.clone()) {
                Ok(_) => written += 1,
                Err(ways::RowRefused::Stale(_)) => {}
                Err(error) => return Err(Error::Storage(error.cause())),
            }
        }
        Ok(written)
    }

    /// The words row the account lacks, written once at revision 0 (creation, and each start: a deliberate no-op for
    /// an account that has it; see the words stage record on the D22 row).
    fn write_words(&self, store: &store::Store<'_>, account: &str) -> Result<usize> {
        let mut written = 0;
        if words_row::read(store, account)?.is_none() {
            match words_row::set(store, account, 0, self.sign_in_words.clone(), None) {
                Ok(_) => written += 1,
                Err(words_row::Refused::Stale(_)) => {}
                Err(error) => return Err(Error::Storage(error.cause())),
            }
        }
        Ok(written)
    }

    /// The rows the tests give an account.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        let (copies, copies_rules) = crate::account::computers::copy_rule::for_tests();
        StartingRows {
            sign_in: lists::for_tests(),
            sign_in_ways: ways::for_tests(),
            sign_in_words: shipped_sign_in_words(),
            copies,
            copies_rules,
            files: None,
            sign_up_delivery: None,
            unknown_keys: UnknownKeys::new(),
        }
    }
}

/// Who a presented credential is, once checked. `sign_in` names how:
/// `grant:<grant id>`, `key:<key id>` or `session:<session id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Principal {
    pub account: String,
    pub sign_in: String,
    pub client_id: Option<String>,
    pub scopes: Vec<String>,
    pub expires_at_ms: u64,
}

/// Every refusal the sign-in gives. The forwarder turns each into its HTTP answer;
/// `oauth.rs` turns the OAuth ones into RFC 6749 error bodies.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Error {
    /// The request is malformed (RFC 6749 `invalid_request`).
    InvalidRequest(&'static str, crate::refusal_cause::Cause),
    /// Client registration metadata is unacceptable (RFC 7591 `invalid_client_metadata`).
    InvalidClientMetadata(&'static str, crate::refusal_cause::Cause),
    /// The redirect URI is unacceptable (RFC 7591 `invalid_redirect_uri`).
    InvalidRedirectUri(crate::refusal_cause::Cause),
    /// Unknown client or failed client authentication (RFC 6749 `invalid_client`).
    InvalidClient(crate::refusal_cause::Cause),
    /// A code or refresh token is unknown, used, expired or does not match (RFC 6749 `invalid_grant`).
    InvalidGrant(crate::refusal_cause::Cause),
    /// The grant type is not offered (RFC 6749 `unsupported_grant_type`).
    UnsupportedGrantType(crate::refusal_cause::Cause),
    /// No credential, or one that is unknown, expired or turned off.
    Unauthenticated(crate::refusal_cause::Cause),
    /// A passkey ceremony failed its checks.
    PasskeyRefused(crate::refusal_cause::Cause),
    /// Body larger than `max_body_bytes`.
    TooLarge(crate::refusal_cause::Cause),
    /// The account has no sign-in settings row (`lists.rs`): nothing that needs one of its numbers is done.
    SettingsMissing(crate::refusal_cause::Cause),
    /// The account has no sign-in words row (`words_row.rs`): nothing worded is drawn or said.
    WordsMissing(crate::refusal_cause::Cause),
    /// The selected source explicitly could not qualify a current read.
    /// No row is absent, and no physical storage failure is implied.
    SourceNotCurrent(crate::refusal_cause::Cause),
    /// The storage refused or is unavailable; never a reason to admit.
    Storage(crate::refusal_cause::Cause),
}

impl Error {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::InvalidRequest(_, cause) => cause.clone(),
            Self::InvalidClientMetadata(_, cause) => cause.clone(),
            Self::InvalidRedirectUri(cause) => cause.clone(),
            Self::InvalidClient(cause) => cause.clone(),
            Self::InvalidGrant(cause) => cause.clone(),
            Self::UnsupportedGrantType(cause) => cause.clone(),
            Self::Unauthenticated(cause) => cause.clone(),
            Self::PasskeyRefused(cause) => cause.clone(),
            Self::TooLarge(cause) => cause.clone(),
            Self::SettingsMissing(cause) => cause.clone(),
            Self::WordsMissing(cause) => cause.clone(),
            Self::Storage(cause) | Self::SourceNotCurrent(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Error);

impl PartialEq for Error {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::InvalidRequest(left, _), Self::InvalidRequest(right, _)) => left == right,
            (Self::InvalidClientMetadata(left, _), Self::InvalidClientMetadata(right, _)) => left == right,
            (Self::InvalidRedirectUri(_), Self::InvalidRedirectUri(_)) => true,
            (Self::InvalidClient(_), Self::InvalidClient(_)) => true,
            (Self::InvalidGrant(_), Self::InvalidGrant(_)) => true,
            (Self::UnsupportedGrantType(_), Self::UnsupportedGrantType(_)) => true,
            (Self::Unauthenticated(_), Self::Unauthenticated(_)) => true,
            (Self::PasskeyRefused(_), Self::PasskeyRefused(_)) => true,
            (Self::TooLarge(_), Self::TooLarge(_)) => true,
            (Self::SettingsMissing(_), Self::SettingsMissing(_)) => true,
            (Self::WordsMissing(_), Self::WordsMissing(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            (Self::SourceNotCurrent(_), Self::SourceNotCurrent(_)) => true,
            _ => false,
        }
    }
}


pub(crate) type Result<T> = std::result::Result<T, Error>;

impl From<crate::storage::Error> for Error {
    fn from(error: crate::storage::Error) -> Self {
        match error {
            crate::storage::Error::NotCurrent(cause) => Error::SourceNotCurrent(cause),
            _ => Error::Storage(error.cause()),
        }
    }
}

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One storage supply shared by every request: an SQLite handle (or the
/// in-memory supply) is not `Sync`, so each call takes it under one lock. Every
/// sign-in write is a single statement, so no scope spans two calls.
pub(crate) struct Locked<S>(std::sync::Mutex<S>);

impl<S> Locked<S> {
    pub(crate) fn new(storage: S) -> Self {
        Locked(std::sync::Mutex::new(storage))
    }
}

macro_rules! locked {
    ($self:ident) => {
        $self.0.lock().map_err(|error| crate::carry_cause!(crate::storage::Error::Unavailable, error))?
    };
}

impl<S: crate::storage::Storage + Send> crate::storage::Storage for Locked<S> {
    fn schema(&self) -> &'static crate::storage::Schema {
        match self.0.lock() {
            Ok(storage) => storage.schema(),
            Err(poisoned) => poisoned.into_inner().schema(),
        }
    }
    fn get(&self, family: &str, key: &[crate::storage::Value], read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Option<crate::storage::Row>> {
        locked!(self).get(family, key, read)
    }
    fn scan(&self, family: &str, range: &crate::storage::Range<'_>, read: &[crate::storage::Read<'_>]) -> crate::storage::Result<Vec<crate::storage::Row>> {
        locked!(self).scan(family, range, read)
    }
    fn put(&self, family: &str, row: &[(&str, crate::storage::Value)], when: crate::storage::When<'_>) -> crate::storage::Result<u64> {
        locked!(self).put(family, row, when)
    }
    fn count(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> {
        locked!(self).count(family, range)
    }
    fn erase(&self, family: &str, range: &crate::storage::Range<'_>) -> crate::storage::Result<u64> {
        locked!(self).erase(family, range)
    }
    fn present(&self, family: &str) -> crate::storage::Result<bool> {
        locked!(self).present(family)
    }
    fn custody(&self) -> crate::storage::Result<()> {
        locked!(self).custody()
    }
    fn location(&self) -> Option<&str> {
        None
    }
    fn scoped(&self) -> bool {
        self.0.lock().map(|storage| storage.scoped()).unwrap_or(false)
    }
    fn writing(&self) -> crate::storage::Result<bool> {
        locked!(self).writing()
    }
    fn changes(&self) -> u64 {
        self.0.lock().map(|storage| storage.changes()).unwrap_or(0)
    }
    fn mark(&self) -> crate::storage::Result<i64> {
        locked!(self).mark()
    }
    fn schema_mark(&self) -> crate::storage::Result<i64> {
        locked!(self).schema_mark()
    }
    fn allocated_bytes(&self) -> crate::storage::Result<u64> {
        locked!(self).allocated_bytes()
    }
    fn open_scope(&self, intent: crate::storage::Intent) -> crate::storage::Result<()> {
        locked!(self).open_scope(intent)
    }
    fn close_scope(&self, commit: bool) -> crate::storage::Result<()> {
        locked!(self).close_scope(commit)
    }
}

/// One sign-in storage, shared by the sign-in routes and the account routes that admit
/// every request with it, so both see the same keys, grants and sessions.
pub(crate) type Shared = std::sync::Arc<dyn crate::storage::Storage + Send + Sync>;

/// Open (or create) the account's own sign-in database
/// `contract().database_file` in `state_root` (the selected account's state folder).
pub(crate) fn open(state_root: &std::path::Path) -> std::result::Result<Shared, crate::storage::Error> {
    let bounds = crate::storage::sqlite::Bounds {
        value_bytes: 64 * 1024,
        work: 10_000_000,
        deadline: std::time::Duration::from_secs(5),
        spend: crate::storage::sqlite::Spend::EachOperation,
        cancel: None,
        busy: std::time::Duration::from_secs(5),
    };
    // Reused admission handles carry request-local numeric observation too.
    let supply = crate::storage::sqlite::open_owned_observed(&state_root.join(&contract().database_file), "sign_in", bounds,
        crate::sqlite_work::WorkMeter::new())?;
    Ok(std::sync::Arc::new(Locked::new(supply)))
}

/// What the note beside the database says: the account, its address (the name its credentials carry) and the
/// public origin the routes served at their last start. Read by the command line on this computer.
#[derive(Debug, PartialEq, Eq, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DoorNote {
    pub account: String,
    /// Empty in a note an earlier build wrote, before credentials named the address; what needs it refuses then.
    #[serde(default)]
    pub address: String,
    pub origin: String,
}

/// Write the note for `account` (address `address`) at `origin` in `state_root`. It names no secret; it is
/// replaced in one rename so a reader never sees half of it.
pub(crate) fn write_door_note(state_root: &std::path::Path, account: &str, address: &str, origin: &str) -> std::io::Result<()> {
    let note = crate::io_operation!((serde_json::to_vec(&DoorNote { account: account.to_string(), address: address.to_string(), origin: origin.to_string() })).map_err(std::io::Error::from))?;
    let path = state_root.join(&contract().door_note_file);
    let beside = state_root.join(format!("{}.new", contract().door_note_file));
    crate::io_operation!((std::fs::write(&beside, note)).map_err(std::io::Error::from))?;
    crate::io_operation!(std::fs::rename(&beside, &path))
}

/// The note beside the database in `state_root`.
pub(crate) fn read_door_note(state_root: &std::path::Path) -> std::io::Result<DoorNote> {
    let bytes = crate::io_operation!((std::fs::read(state_root.join(&contract().door_note_file))).map_err(std::io::Error::from))?;
    crate::io_operation!(serde_json::from_slice(&bytes).map_err(|_refusal_io_source| { let _refusal_io_cause = crate::refusal_cause::Caused::stored_cause(&_refusal_io_source).unwrap_or_else(|| crate::cause!()); crate::refusal_cause::locate_io(std::io::Error::new(std::io::ErrorKind::InvalidData, "sign-in door note refused"), _refusal_io_cause) }))
}

/// The sign-in routes over `storage` for `account` (address `address`) at `origin`, served under `base` ("/a/<address>"
/// at a computer, "" at the origin's root). `sender` runs the tool that sends a way's codes (`ways::Deliver`); with none,
/// no code is sent and the pages say so.
pub(crate) fn routes(storage: Shared, account: &str, address: &str, origin: &str, base: &str,
    sender: Option<std::sync::Arc<dyn ways::Deliver>>) -> axum::Router {
    routes::routes(routes::Supplies {
        storage,
        account: account.to_string(),
        address: address.to_string(),
        origin: origin.to_string(),
        base: base.to_string(),
        sender,
    })
}
