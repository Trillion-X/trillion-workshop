// src/forwarder/origins.rs
//
// Purpose: Answer a browser origin (a name under a names suffix, or a person's own domain) with the installation of the
// account that signed it, so the forwarder can carry the request to a live computer of that account.
//
// Non-Negotiable Invariants:
// - A row is believed only when the key it carries is the key its address names, and that key signed it.
// - A host outside the name suffixes is believed only with the owner's DNS proof read by the hosting owner's resolver.
// - Two live accounts never answer one host: the first live account to name it keeps it, and a contested host answers nobody.
// - The forwarder stores nothing: rows live in memory, kept only while a computer of the account is live.
//
// Key Concepts:
// - OriginsRow: an account's signed list of {host, installation}.
// - OriginBook: the rows the forwarder believes now, and the lookup Host -> (address, installation).
// - OriginProof: the resolver the hosting owner supplies; a test supplies its own.
//
// Security Considerations:
// - A computer cannot claim a host for an account whose key it does not hold: the row is the account's own signature.
// - A domain's proof names the account's address, so a domain owner chooses exactly one account.
// - The forwarder knows no product: an origin maps to an installation, and the computer answers the request.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Origins: which browser origin shows which installation of which account.
//!
//! The old app served one browser origin per installation (old trillion `src/public-app-host.mjs:1317-1345`
//! `answerPublicApp`: a request's host name read by `publicAppHost`, a `<name>.trillion.run` name looked up in the name
//! list, a person's own domain looked up in the domain list and checked by its `_trillion-verify` TXT record,
//! `src/public-app-domains.mjs:44-52`). Those lists were the old app's central store. Here the account signs its own
//! row of origins, a computer of the account hands it to the forwarder, and the forwarder keeps it only in memory, beside the
//! live sessions it already keeps (`connected_computers.rs`): nothing is written.
//!
//! An origins row `{account, account_key, revision, origins, signature}`:
//! - `account` is the account's address (64 lowercase hex), `account_key` its public key, hex: the forwarder believes the
//!   row only when `address_of(account_key)` is `account` and that key signed it, the same rule as a computers row;
//! - `origins` are `{host, installation}`: a host the account answers (lowercase, no port, no trailing dot) and the
//!   installation it shows (`installation_hex` lowercase hex characters), sorted by host, each host once;
//! - `revision` orders one account's rows: a lower revision than the one held is refused;
//! - `signature` is Ed25519 over: `signed_domain`, the account, the revision as 8 big-endian bytes, and each
//!   `host`, `installation` pair, each text with its 4-byte big-endian length in front.
//!
//! Which host a row may name (`OriginBook::take`):
//! - a name: one label matching `name_label_pattern` under a row of `name_suffixes` (`<name>.trillion.run`). The first
//!   live account to name it holds it; another account's row naming it is refused while the account that has it has a live computer;
//! - any other host (the person's own domain): believed only when the resolver the hosting owner supplies
//!   (`OriginProof`) reads a TXT record at `proof_label`.<host> holding `proof_value_prefix` + the account's address.
//!   With no resolver supplied no such host is believed. A domain another live account holds is refused too.
//!
//! The forwarder (`gateway.rs`) asks `find` for a request whose Host is not its own: one live account names the
//! host, and the request goes to that account's live computer at `/a/<address>/<installation_path>/<installation>`
//! followed by the request's own path and query. A Host no live account names stays the forwarder's own (its MCP
//! and account paths, as before). `take` lets go of a gone account's row before it takes another, so two rows never
//! name one host; should they (`Lookup::Contested`), nobody answers.
//!
//! Every number and word is DATA beside this code (`origins.json`).

use crate::refusal_cause::CodedError;
use crate::account::computers::{address_of, hex_bytes, AccountKey};
use crate::account::rows::tokens::owner_text_ok;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

/// The settings DATA beside this code.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    signed_domain: String,
    pub tell_origins_path: String,
    pub installation_path: String,
    installation_hex: usize,
    name_suffixes: Vec<String>,
    name_label_pattern: String,
    reserved_names: Vec<String>,
    code_pattern: String,
    proof_label: String,
    proof_value_prefix: String,
    most_origins: usize,
    most_accounts: usize,
    max_host_bytes: usize,
    /// How long a row stays held after a computer of its account was last seen live (`OriginBook`).
    name_hold_ms: i64,
    /// The forwarder's own path an on-demand TLS terminator asks `?domain=<host>` at (`OriginBook::may_certify`).
    pub certificate_ask_path: String,
    /// The account routes a request names by path alone, carried to the forwarder's root account (`gateway.rs` `account_path`).
    pub root_account_paths: Vec<String>,
    /// The production DNS resolver's own settings (`origin_dns.rs`).
    #[serde(rename = "resolver")]
    _resolver: serde_json::Value,
}

/// The one settings value, read from `origins.json` at first use.
pub(crate) fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("origins.json")).expect("origins.json is valid"))
}

fn name_label() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(&settings().name_label_pattern).expect("origins.json names a valid label pattern"))
}

/// One host an account answers and the installation it shows. `moved_to`, when set, is another host of the same row
/// this one was renamed to: a page read (GET or HEAD) of this host is sent on there with its path and query (old
/// trillion src/public-app-host.mjs:1324 `holder.moved_to`, :1315 `moved`), and any other request is still answered
/// by `installation`, as the old app's host row still named its installation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Origin {
    pub host: String,
    pub installation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
}

/// An account's own row of origins, as the account signed it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OriginsRow {
    pub account: String,
    pub account_key: String,
    pub revision: u64,
    pub origins: Vec<Origin>,
    pub signature: String,
}

impl OriginsRow {
    /// The account's row at `revision`, signed with its `key`. Hosts are written in their one form and sorted here; a
    /// host given twice, a host that is not a host, or an installation in another shape is refused.
    pub fn sign(revision: u64, origins: &[Origin], key: &AccountKey) -> Result<Self, CodedError<&'static str>> {
        let mut origins: Vec<Origin> = origins.iter()
            .map(|origin| Some(Origin {
                host: host_of(&origin.host)?,
                installation: origin.installation.clone(),
                moved_to: match &origin.moved_to { Some(to) => Some(host_of(to)?), None => None },
            }))
            .collect::<Option<_>>().ok_or(CodedError::new("origin refused"))?;
        origins.sort_by(|a, b| a.host.cmp(&b.host));
        let mut row = OriginsRow { account: key.address(), account_key: key.public_hex(), revision, origins, signature: String::new() };
        if !row.shape_ok() {
            return Err(CodedError::new("origins row refused"));
        }
        row.signature = key.sign(&row.signed_bytes());
        Ok(row)
    }

    /// Whether the forwarder may believe this row for the account at `address`: its shape is one a signature covers, the
    /// key it carries is the key `address` names, and that key signed exactly this row. Nothing stored is asked.
    pub fn believed(&self, address: &str) -> bool {
        let Some(public) = hex_bytes(&self.account_key).filter(|key| key.len() == 32) else { return false };
        let Some(signature) = hex_bytes(&self.signature).filter(|bytes| bytes.len() == 64) else { return false };
        self.account == address
            && self.shape_ok()
            && address_of(&public).as_deref() == Some(address)
            && UnparsedPublicKey::new(&ED25519, &public).verify(&self.signed_bytes(), &signature).is_ok()
    }

    fn shape_ok(&self) -> bool {
        let settings = settings();
        owner_text_ok(&self.account)
            && self.revision >= 1
            && self.revision < 1 << 53
            && self.origins.len() <= settings.most_origins
            && self.origins.windows(2).all(|pair| pair[0].host < pair[1].host)
            && self.origins.iter().all(|origin| host_of(&origin.host).as_deref() == Some(origin.host.as_str())
                && installation_ok(&origin.installation)
                && origin.moved_to.as_ref().is_none_or(|to| to != &origin.host
                    && self.origins.iter().any(|other| &other.host == to && other.moved_to.is_none())))
    }

    fn signed_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        push_text(&mut bytes, &settings().signed_domain);
        push_text(&mut bytes, &self.account);
        bytes.extend_from_slice(&self.revision.to_be_bytes());
        bytes.extend_from_slice(&(self.origins.len() as u32).to_be_bytes());
        for origin in &self.origins {
            push_text(&mut bytes, &origin.host);
            push_text(&mut bytes, &origin.installation);
            push_text(&mut bytes, origin.moved_to.as_deref().unwrap_or(""));
        }
        bytes
    }
}

fn push_text(bytes: &mut Vec<u8>, text: &str) {
    bytes.extend_from_slice(&(text.len() as u32).to_be_bytes());
    bytes.extend_from_slice(text.as_bytes());
}

fn installation_ok(id: &str) -> bool {
    id.len() == settings().installation_hex && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The one form of a host as a request or a row gives it: lowercase, no port, no trailing dot, two or more labels of
/// letters, digits and inner hyphens, at most `max_host_bytes`. `None` for anything else (an address with a user, an IP
/// literal in brackets, an empty label).
pub fn host_of(value: &str) -> Option<String> {
    let value = value.trim();
    let host = match value.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => value,
    };
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |label: &&str| (1..=63).contains(&label.len())
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-') && !label.ends_with('-');
    (host.len() <= settings().max_host_bytes && labels.len() >= 2 && labels.iter().all(label_ok)
        && !labels.last().is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit())))
        .then_some(host)
}

/// Whether `host` is a name no account may hold: its label is a reserved name, holds `--`, or looks like a code
/// (old trillion src/public-app-names.mjs:79 `checkedPublicAppName`, src/readable-names.mjs:47 LOOKS_LIKE_CODE).
fn is_reserved_name(host: &str) -> bool {
    static CODE: OnceLock<regex::Regex> = OnceLock::new();
    let settings = settings();
    let code = CODE.get_or_init(|| regex::Regex::new(&settings.code_pattern).expect("origins.json names a valid code pattern"));
    settings.name_suffixes.iter().filter_map(|suffix| host.strip_suffix(suffix.as_str())?.strip_suffix('.'))
        .any(|label| settings.reserved_names.iter().any(|reserved| reserved == label) || label.contains("--") || code.is_match(label))
}

/// Whether `host` is a name under one of `name_suffixes`: one label matching `name_label_pattern`.
fn is_name(host: &str) -> bool {
    settings().name_suffixes.iter().any(|suffix| host.strip_suffix(suffix.as_str())
        .and_then(|label| label.strip_suffix('.'))
        .is_some_and(|label| name_label().is_match(label)))
}

/// The resolver the hosting owner supplies, read for a person's own domain: the TXT strings at one DNS name. The
/// forwarder does not resolve names by itself; a test supplies its own answers.
pub trait OriginProof: Send + Sync {
    fn txt(&self, name: &str) -> Vec<String>;
}

/// Why a row was not taken.
#[derive(Clone, Debug)]
pub enum Refusal {
    /// The row is not believed for the address it was posted under.
    NotBelieved(crate::refusal_cause::Cause),
    /// The account already gave a newer row.
    Stale(crate::refusal_cause::Cause),
    /// Another live account holds this host.
    Taken(String, crate::refusal_cause::Cause),
    /// A person's own domain whose proof the resolver did not read (or no resolver was supplied).
    Unproven(String, crate::refusal_cause::Cause),
    /// The forwarder keeps as many accounts' rows as it may.
    Full(crate::refusal_cause::Cause),
    /// A name no account may hold (`is_reserved_name`).
    Reserved(String, crate::refusal_cause::Cause),
}
impl Refusal {
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotBelieved(cause) | Self::Stale(cause) | Self::Full(cause) => cause.clone(),
            Self::Taken(_, cause) | Self::Unproven(_, cause) | Self::Reserved(_, cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refusal);
// Source identity is independent of the existing refusal condition and named host.
impl PartialEq for Refusal {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NotBelieved(_), Self::NotBelieved(_)) | (Self::Stale(_), Self::Stale(_)) | (Self::Full(_), Self::Full(_)) => true,
            (Self::Taken(left, _), Self::Taken(right, _)) | (Self::Unproven(left, _), Self::Unproven(right, _)) | (Self::Reserved(left, _), Self::Reserved(right, _)) => left == right,
            _ => false,
        }
    }
}
impl Eq for Refusal {}


/// What a Host answers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lookup {
    /// One live account names the host: its address, the installation the host shows, and the host it was renamed to
    /// (`Origin::moved_to`), if any.
    Found { address: String, installation: String, moved_to: Option<String> },
    /// More than one live account names the host: nobody answers.
    Contested,
    /// No live account names the host.
    Unknown,
}

/// One account's row as the forwarder keeps it: the row, when a computer of the account was last seen live (ms), and
/// the hosts of it that another account took since by its own domain proof while this one had no live computer.
struct Held {
    row: OriginsRow,
    seen_ms: i64,
    released: Vec<String>,
}

/// The origins rows the forwarder believes now, by account address, in memory only.
///
/// A row stays held for `name_hold_ms` after a computer of its account was last seen live: while it is held no other
/// account may name its hosts, so a name is not lost the moment its computer goes offline (old trillion held a name
/// forever in its central KV list, src/public-app-names.mjs:111-133 `claimPublicAppName`). The hold is in memory, as
/// every row here: the forwarder stores nothing (docs/PRINCIPLES.md rule 3), so a forwarder that starts again holds
/// what its computers hand in again from then on. A person's own domain is the one exception: its DNS proof is the
/// domain owner's own choice, so another account that proves it takes it from a held (not live) row at once.
#[derive(Default)]
pub struct OriginBook {
    rows: Mutex<HashMap<String, Held>>,
}

impl OriginBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Take `row` for the account at `address` at `now_ms`. `live` says whether an account has a live computer now (the
    /// forwarder's list of connected computers); `proof` is the hosting owner's resolver. A held row whose hold ran out
    /// (no live computer for `name_hold_ms`) is let go first, so its hosts are free again. Taken only whole: one refused
    /// host refuses the row, and the row the account gave before stands.
    pub fn take(&self, address: &str, row: OriginsRow, now_ms: i64, live: &dyn Fn(&str) -> bool, proof: Option<&dyn OriginProof>)
        -> Result<(), Refusal> {
        if !row.believed(address) {
            return Err(crate::cause!(Refusal::NotBelieved));
        }
        let settings = settings();
        if let Some(origin) = row.origins.iter().find(|origin| is_reserved_name(&origin.host)) {
            return Err(Refusal::Reserved(origin.host.clone(), crate::cause!()));
        }
        // A domain's proof is read before the book is held: a resolver may take a while.
        for origin in row.origins.iter().filter(|origin| !is_name(&origin.host)) {
            let expected = format!("{}{address}", settings.proof_value_prefix);
            let proven = proof.is_some_and(|proof| proof.txt(&format!("{}.{}", settings.proof_label, origin.host))
                .iter().any(|value| value.trim() == expected));
            if !proven {
                return Err(Refusal::Unproven(origin.host.clone(), crate::cause!()));
            }
        }
        let Ok(mut rows) = self.rows.lock() else { return Err(crate::cause!(Refusal::Full)) };
        for (held, kept) in rows.iter_mut() {
            if held == address || live(held) {
                kept.seen_ms = kept.seen_ms.max(now_ms);
            }
        }
        rows.retain(|_, kept| now_ms.saturating_sub(kept.seen_ms) <= settings.name_hold_ms);
        if rows.get(address).is_some_and(|held| held.row.revision > row.revision) {
            return Err(crate::cause!(Refusal::Stale));
        }
        // Which other row names each host now: a live or held row, unless its host was already released to another.
        let mut releases: Vec<(String, String)> = Vec::new();
        for origin in &row.origins {
            for (held, other) in rows.iter() {
                if held == address || other.released.contains(&origin.host)
                    || !other.row.origins.iter().any(|named| named.host == origin.host) {
                    continue;
                }
                // A proven domain of a row held with no live computer goes to the account the domain's owner proved.
                if !is_name(&origin.host) && !live(held) {
                    releases.push((held.clone(), origin.host.clone()));
                    continue;
                }
                return Err(Refusal::Taken(origin.host.clone(), crate::cause!()));
            }
        }
        if !rows.contains_key(address) && rows.len() >= settings.most_accounts {
            return Err(crate::cause!(Refusal::Full));
        }
        for (held, host) in releases {
            if let Some(other) = rows.get_mut(&held) {
                other.released.push(host);
            }
        }
        rows.insert(address.to_owned(), Held { row, seen_ms: now_ms, released: Vec::new() });
        Ok(())
    }

    /// What the request host `host` answers now, among the accounts `live` says have a live computer. A held row
    /// answers nothing: its hosts are only kept from other accounts.
    pub fn find(&self, host: &str, live: &dyn Fn(&str) -> bool) -> Lookup {
        let Some(host) = host_of(host) else { return Lookup::Unknown };
        let Ok(rows) = self.rows.lock() else { return Lookup::Unknown };
        let mut found = rows.iter().filter(|(_, kept)| !kept.released.contains(&host)).filter_map(|(address, kept)| {
            kept.row.origins.iter().find(|origin| origin.host == host)
                .map(|origin| (address.clone(), origin.installation.clone(), origin.moved_to.clone()))
        }).collect::<Vec<_>>();
        drop(rows);
        found.retain(|(address, _, _)| live(address));
        match found.len() {
            0 => Lookup::Unknown,
            1 => {
                let (address, installation, moved_to) = found.remove(0);
                Lookup::Found { address, installation, moved_to }
            }
            _ => Lookup::Contested,
        }
    }

    /// Whether a certificate may be made for `host` now: exactly one live account names it (`find`). The question an
    /// on-demand TLS terminator in front of the forwarder asks before it makes a certificate for a host it has none
    /// for (`certificate_ask_path`), so no certificate is made for a host no account answers.
    pub fn may_certify(&self, host: &str, live: &dyn Fn(&str) -> bool) -> bool {
        matches!(self.find(host, live), Lookup::Found { .. })
    }
}

/// The word the forwarder answers a row with when the computer that posted it is not (yet) a live computer of the
/// account (`Refusal::NotBelieved`): the computer posts again on its next step.
pub(crate) fn not_believed_word() -> String {
    #[derive(Deserialize)]
    struct Words {
        origin_not_believed: String,
    }
    serde_json::from_slice::<Words>(include_bytes!("words.json")).map(|words| words.origin_not_believed).unwrap_or_default()
}

/// The computer's path for a request to `host` answered by `installation` of the account at `address`: under the
/// account's own path, so the computer's account routes answers it for that account only.
pub fn computer_target(address: &str, installation: &str, path_and_query: &str) -> String {
    let path_and_query = if path_and_query.starts_with('/') { path_and_query.to_owned() } else { format!("/{path_and_query}") };
    format!("/a/{address}/{}/{installation}{path_and_query}", settings().installation_path)
}

#[cfg(test)]
mod tests;
