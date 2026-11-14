//! Passkeys (WebAuthn Level 3), "none" attestation. Registration takes the
//! browser's `response.getPublicKey()` SPKI DER and
//! `getPublicKeyAlgorithm()` (-7 ES256 or -257 RS256), and checks
//! clientDataJSON (type `webauthn.create`, the stored challenge, the origin)
//! and authenticatorData (rpIdHash = SHA-256 of the origin's host, user
//! present, user verified, attested credential present). Sign-in reuses
//! `crate::account::passkey_verification::verify_assertion` and commits the
//! new counter. Challenges are `random_text(32)`, one use, `challenge_seconds`.
//!
//! A passkey's provenance (`Passkey::authority`) is fixed when it is saved and read by `known.rs`, which decides
//! which passkeys are known; a known passkey's use cancels what waits (`known::cancel_waiting`). A confirmation of
//! one guarded change is a passkey ceremony over a challenge bound to exactly that change (`confirm_options`,
//! `confirm`). The account's passkeys are listed and one removed, never the last way in (`remove`; old trillion
//! src/passkey-list.mjs:36-39 `passkeysOf` and src/account-routes.mjs:658-676 `account/passkeys/remove`).
//!
//! Stored values, owned by this file:
//! - passkeys:   `Passkey`, id = the credential id (base64url)
//! - challenges: `Challenge`, id = the challenge text

use super::store::{Family, Row, Store};
use super::tokens::random_text;
use super::{now_ms, computer, Error, Result};
use crate::account::passkey_verification::{verify_assertion, AssertionPolicy};
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine};
use der::{asn1::{Null, ObjectIdentifier, UintRef}, Decode, Reader, SliceReader};
use ring::digest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use spki::SubjectPublicKeyInfoRef;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Passkey {
    /// SPKI DER, base64url.
    pub public_key: String,
    /// COSE algorithm number: -7 or -257.
    pub algorithm: i64,
    pub counter: u64,
    pub name: String,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
    /// How it was added and from when it is known (`known.rs`); none on a row saved before provenance existed, which
    /// `known::state` classifies once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority: Option<super::known::Authority>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Challenge {
    /// "register", "sign-in" or "confirm".
    pub purpose: String,
    /// For a confirmation: the one change it is for (`known::Change::key`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<String>,
    /// A sign-up's registration: the passkey it saves made the account, so it is known at once.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sign_up: bool,
}

const ES256: i64 = -7;
const RS256: i64 = -257;
const DEFAULT_NAME: &str = "Passkey";
const MAX_NAME_CHARS: usize = 100;
/// How many existing passkeys a registration excludes.
const MAX_LISTED: usize = 100;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;
const FLAG_ATTESTED: u8 = 0x40;
/// The attested credential data starts after rpIdHash (32), flags (1) and counter (4).
const ATTESTED_AT: usize = 37;
const AAGUID_BYTES: usize = 16;
/// Lowest RSA modulus accepted at registration, in bytes (2048 bits).
const MIN_RSA_MODULUS_BYTES: usize = 256;

/// The `PublicKeyCredentialCreationOptions` JSON for adding a passkey to
/// `account`, with a fresh stored challenge. `origin` is "https://host".
pub(crate) fn registration_options(store: &Store<'_>, account: &str, origin: &str) -> Result<Value> {
    let relying = relying_party(origin)?;
    check_account(account)?;
    let timeout = timeout_ms(store, account)?;
    let challenge = issue_challenge(store, account, "register", timeout)?;
    let existing: Vec<Row<Passkey>> = store.list(Family::Passkeys, account, MAX_LISTED)?;
    let excluded: Vec<Value> = existing.iter().map(|row| json!({"type": "public-key", "id": row.id})).collect();
    Ok(json!({
        "challenge": challenge,
        "rp": {"id": relying, "name": relying},
        "user": {"id": URL_SAFE_NO_PAD.encode(user_handle(account)), "name": account, "displayName": account},
        "pubKeyCredParams": [{"type": "public-key", "alg": ES256}, {"type": "public-key", "alg": RS256}],
        "timeout": timeout,
        "attestation": "none",
        "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
        "excludeCredentials": excluded,
    }))
}

/// The options for a new account's first passkey, under the one-use `challenge` a sign-up made. The account does not
/// exist yet, so nothing is stored here: the sign-up stores the challenge in the new account's rows when it finishes
/// (`remember_challenge`). `timeout_ms` is the computer's sign-up wait (no account, so no account row, exists yet).
pub(crate) fn sign_up_options(challenge: &str, origin: &str, user_name: &str, timeout_ms: u64) -> Result<Value> {
    let relying = relying_party(origin)?;
    let handle = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, challenge.as_bytes()));
    Ok(json!({
        "challenge": challenge,
        "rp": {"id": relying, "name": relying},
        "user": {"id": handle, "name": user_name, "displayName": user_name},
        "pubKeyCredParams": [{"type": "public-key", "alg": ES256}, {"type": "public-key", "alg": RS256}],
        "timeout": timeout_ms,
        "attestation": "none",
        "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
        "excludeCredentials": [],
    }))
}

/// Store a one-use registration challenge for `account`, which lives until `expires_at` (ms since the epoch). Its ceremony then takes it
/// like one `registration_options` issued.
pub(crate) fn remember_challenge(store: &Store<'_>, account: &str, challenge: &str, expires_at: u64) -> Result<()> {
    store.insert(
        Family::Challenges,
        &Row {
            id: challenge.to_string(),
            account: account.to_string(),
            expires_at,
            value: Challenge { purpose: "register".to_string(), change: None, sign_up: true },
        },
    )?;
    Ok(())
}

/// The challenge a registration answer says it answers (its clientDataJSON's `challenge`).
pub(crate) fn answered_challenge(body: &Value) -> Result<String> {
    let client = client_data(response(body)?)?;
    client.get("challenge").and_then(Value::as_str).map(str::to_owned).ok_or(crate::cause!(Error::PasskeyRefused))
}

/// Check a registration response JSON (as the page's script posts it) and
/// store the passkey. Answers the credential id.
pub(crate) fn finish_registration(store: &Store<'_>, account: &str, origin: &str, body: &Value) -> Result<String> {
    let relying = relying_party(origin)?;
    check_account(account)?;
    let id = text(body, "id")?;
    if text(body, "rawId")? != id || text(body, "type")? != "public-key" {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let credential_id = bytes(id)?;
    let answer = response(body)?;
    let client = client_data(answer)?;
    let challenge = client.get("challenge").and_then(Value::as_str).ok_or(crate::cause!(Error::PasskeyRefused))?;
    let taken = take_challenge(store, challenge, "register", account)?;
    if client.get("type").and_then(Value::as_str) != Some("webauthn.create")
        || client.get("origin").and_then(Value::as_str) != Some(origin)
        || client.get("crossOrigin") == Some(&Value::Bool(true))
    {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let auth = bytes(text(answer, "authenticatorData")?)?;
    let relying_hash = digest::digest(&digest::SHA256, relying.as_bytes());
    let required = FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED;
    if auth.len() < ATTESTED_AT + AAGUID_BYTES + 2
        || auth[..32] != *relying_hash.as_ref()
        || auth[32] & required != required
    {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let counter = u32::from_be_bytes([auth[33], auth[34], auth[35], auth[36]]);
    let length_at = ATTESTED_AT + AAGUID_BYTES;
    let length = usize::from(u16::from_be_bytes([auth[length_at], auth[length_at + 1]]));
    let attested = auth.get(length_at + 2..length_at + 2 + length).ok_or(crate::cause!(Error::PasskeyRefused))?;
    if attested != credential_id.as_slice() {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let algorithm = answer.get("publicKeyAlgorithm").and_then(Value::as_i64).ok_or(crate::cause!(Error::PasskeyRefused))?;
    let public_key = text(answer, "publicKey")?;
    check_public_key(algorithm, &bytes(public_key)?)?;
    let name = passkey_name(body)?;
    if store.get::<Passkey>(Family::Passkeys, id)?.is_some() {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    // Its provenance, fixed now (old trillion src/passkey-authority.mjs invariant 2); every passkey but the one that
    // made the account is told, within the window's room, or the add is refused (old :206-215, :278-279).
    let now = now_ms();
    let authority = super::known::for_new_passkey(store, account, taken.value.sign_up, now)?;
    // The sign-up passkey is told nothing, so it needs no words; any other is told in the account's own words.
    let notice = match authority.by {
        super::known::Provenance::SignUp => None,
        _ => super::known::added_notice(&super::known::words(store, account)?, &authority),
    };
    if let Some((title, body)) = notice {
        if !super::known::take_notice_room(store, account, now, &title, &body)? {
            return Err(Error::InvalidRequest("too many passkeys were added or recoveries asked for on this account today", crate::cause!()));
        }
    }
    store.insert(
        Family::Passkeys,
        &Row {
            id: id.to_string(),
            account: account.to_string(),
            expires_at: 0,
            value: Passkey {
                public_key: public_key.to_string(),
                algorithm,
                counter: u64::from(counter),
                name,
                created_at: now,
                last_used_at: None,
                authority: Some(authority),
            },
        },
    )?;
    Ok(id.to_string())
}

/// The `PublicKeyCredentialRequestOptions` JSON for signing in, with a fresh
/// stored challenge (no allowCredentials: discoverable credentials). The challenge lives as long as the account this
/// door serves (`account`) says (its settings row).
pub(crate) fn sign_in_options(store: &Store<'_>, account: &str, origin: &str) -> Result<Value> {
    let relying = relying_party(origin)?;
    let timeout = timeout_ms(store, account)?;
    let challenge = issue_challenge(store, "", "sign-in", timeout)?;
    Ok(json!({
        "challenge": challenge,
        "rpId": relying,
        "timeout": timeout,
        "userVerification": "required",
    }))
}

/// Check an assertion JSON and answer the account it signs in. A known passkey's sign-in cancels what waits that no
/// known passkey confirmed (`known::cancel_waiting`, old trillion src/passkey-authority.mjs invariant 3).
pub(crate) fn finish_sign_in(store: &Store<'_>, origin: &str, body: &Value) -> Result<String> {
    let used = verify_use(store, origin, body, "sign-in", "", None)?;
    let now = now_ms();
    if super::known::state(store, &used.account, now)?.known.contains(&used.id) {
        super::known::cancel_waiting(store, &used.account, now)?;
    }
    Ok(used.account)
}

/// The `PublicKeyCredentialRequestOptions` JSON for a confirmation of exactly `change` (`known::Change::key`) by one
/// of `account`'s passkeys: a fresh challenge bound to it, allowing only the account's own passkeys (old trillion
/// src/passkey-authority.mjs:57-58 `step_needed`, the ceremony src/passkey-step.mjs ran).
pub(crate) fn confirm_options(store: &Store<'_>, account: &str, origin: &str, change: &str) -> Result<Value> {
    let relying = relying_party(origin)?;
    check_account(account)?;
    let timeout = timeout_ms(store, account)?;
    let id = random_text(32);
    store.insert(
        Family::Challenges,
        &Row {
            id: id.clone(),
            account: account.to_string(),
            expires_at: now_ms() + timeout,
            value: Challenge { purpose: "confirm".to_string(), change: Some(change.to_string()), sign_up: false },
        },
    )?;
    let allowed: Vec<Value> = store.list::<Passkey>(Family::Passkeys, account, MAX_LISTED)?.iter()
        .map(|row| json!({"type": "public-key", "id": row.id})).collect();
    Ok(json!({
        "challenge": id,
        "rpId": relying,
        "timeout": timeout,
        "userVerification": "required",
        "allowCredentials": allowed,
    }))
}

/// Check a confirmation (an assertion over a `confirm_options` challenge for exactly `change`) by one of `account`'s
/// passkeys, and answer that passkey as it is now. Whether it is known is `known.rs`'s to say.
pub(crate) fn confirm(store: &Store<'_>, account: &str, origin: &str, change: &str, body: &Value) -> Result<Row<Passkey>> {
    check_account(account)?;
    verify_use(store, origin, body, "confirm", account, Some(change))
}

/// Why a passkey is not removed.
#[derive(Clone, Debug, Eq)]
pub(crate) enum RemoveRefused {
    /// Not a passkey of this account.
    NotHere(crate::refusal_cause::Cause),
    /// It is the account's only passkey and no held way alone keeps the account reachable.
    LastWayIn(crate::refusal_cause::Cause),
    Storage(crate::refusal_cause::Cause),
}

impl RemoveRefused {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::NotHere(cause) => cause.clone(),
            Self::LastWayIn(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(RemoveRefused);

impl PartialEq for RemoveRefused {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::NotHere(_), Self::NotHere(_)) => true,
            (Self::LastWayIn(_), Self::LastWayIn(_)) => true,
            (Self::Storage(_), Self::Storage(_)) => true,
            _ => false,
        }
    }
}


impl From<Error> for RemoveRefused {
    fn from(error: Error) -> Self {
        RemoveRefused::Storage(error.cause())
    }
}

/// Remove passkey `id` of `account` (old trillion src/account-routes.mjs:658-676): never the last way in, so the only
/// passkey goes only while a held way of `ways` alone keeps the account reachable (an account with no ways row has
/// no other way). Whether a known passkey's confirmation is needed first is `known::removal`'s to say.
pub(crate) fn remove(store: &Store<'_>, account: &str, id: &str, ways: Option<&super::ways::WaySettings>) -> std::result::Result<(), RemoveRefused> {
    let mine: Vec<Row<Passkey>> = store.list(Family::Passkeys, account, usize::MAX)?;
    if !mine.iter().any(|row| row.id == id) {
        return Err(crate::cause!(RemoveRefused::NotHere));
    }
    if mine.len() <= 1 {
        let held = super::ways::held(store, account).map_err(|error| RemoveRefused::Storage(error.cause()))?;
        let reachable = ways.is_some_and(|ways| held.iter().any(|way_in| ways.row(&way_in.value.way).is_some_and(|row| row.alone)));
        if !reachable {
            return Err(crate::cause!(RemoveRefused::LastWayIn));
        }
    }
    if !store.remove(Family::Passkeys, id)? {
        return Err(crate::cause!(RemoveRefused::NotHere));
    }
    Ok(())
}

/// Check one use of a passkey (a sign-in, or a confirmation of `change`) over a challenge issued for `purpose` and
/// `account`, commit its new counter, and answer the passkey row as it is now.
fn verify_use(store: &Store<'_>, origin: &str, body: &Value, purpose: &str, account: &str, change: Option<&str>) -> Result<Row<Passkey>> {
    let relying = relying_party(origin)?;
    let id = text(body, "id")?;
    if text(body, "rawId")? != id || text(body, "type")? != "public-key" {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let found: Row<Passkey> = store.get(Family::Passkeys, id)?.ok_or(crate::cause!(Error::PasskeyRefused))?;
    let client = client_data(response(body)?)?;
    let challenge = client.get("challenge").and_then(Value::as_str).ok_or(crate::cause!(Error::PasskeyRefused))?;
    let taken = take_challenge(store, challenge, purpose, account)?;
    if taken.value.change.as_deref() != change || (!account.is_empty() && found.account != account) {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let previous = found.value.counter;
    let previous_32 = u32::try_from(previous).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
    let credential = credential_of(id, &found.value).ok_or(crate::cause!(Error::PasskeyRefused))?;
    let policy = AssertionPolicy {
        challenge,
        origin,
        relying_party: &relying,
        user_verified: true,
        previous_counter: previous_32,
        maximum_component_bytes: computer().max_body_bytes,
        client_json_limits: Default::default(),
    };
    let assertion = verify_assertion(body, &credential, &policy).map_err(|error| Error::PasskeyRefused(error.cause()))?;
    // verify_assertion enforces this already; kept here as the stated rule.
    let counter = u64::from(assertion.counter);
    if (counter != 0 || previous != 0) && counter <= previous {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    let mut passkey = found.clone();
    passkey.value.counter = counter;
    passkey.value.last_used_at = Some(now_ms());
    // Compare-and-set: two sign-ins racing on the same counter cannot both pass.
    if !store.replace_if(Family::Passkeys, &found, &passkey)? {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    Ok(passkey)
}

/// How long a challenge of `account` lives, in ms (its settings row's `challenge_seconds`).
fn timeout_ms(store: &Store<'_>, account: &str) -> Result<u64> {
    Ok(super::lists::current(store, account)?.challenge_seconds.saturating_mul(1000))
}

fn check_account(account: &str) -> Result<()> {
    if account.is_empty() {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    Ok(())
}

/// The WebAuthn user handle of `account`: its SHA-256, 32 bytes. WebAuthn caps a handle at 64 bytes, and an account's
/// user id can be longer (a made account's is `account-` and 64 hex). Nothing reads the handle back: sign-in finds the
/// account by the credential id.
fn user_handle(account: &str) -> Vec<u8> {
    digest::digest(&digest::SHA256, account.as_bytes()).as_ref().to_vec()
}

/// The relying party id: the origin's host less `relying_party_drop_labels` leading labels (the computer's, `ComputerSignIn`).
/// WebAuthn lets a page name any registrable suffix of its host, so a passkey made on one host of a domain signs in
/// on every host of it. The origin must be exactly `scheme://host[:port]`, as the browser reports it.
fn relying_party(origin: &str) -> Result<String> {
    let url = url::Url::parse(origin).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
    let host = url.host_str().ok_or(crate::cause!(Error::PasskeyRefused))?;
    if url.origin().ascii_serialization() != origin {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    Ok(host_suffix(host, computer().relying_party_drop_labels))
}

/// `host` less `drop` leading labels, never fewer than two labels; an IP address is kept whole.
fn host_suffix(host: &str, drop: usize) -> String {
    if host.starts_with('[') || host.parse::<std::net::IpAddr>().is_ok() {
        return host.to_string();
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels[drop.min(labels.len().saturating_sub(2))..].join(".")
}

/// A fresh one-use challenge, stored for `account` with its purpose.
fn issue_challenge(store: &Store<'_>, account: &str, purpose: &str, timeout_ms: u64) -> Result<String> {
    let id = random_text(32);
    store.insert(
        Family::Challenges,
        &Row {
            id: id.clone(),
            account: account.to_string(),
            expires_at: now_ms() + timeout_ms,
            value: Challenge { purpose: purpose.to_string(), change: None, sign_up: false },
        },
    )?;
    Ok(id)
}

/// Consume the stored challenge (one use, even when the check then fails) and
/// require that it was issued for `purpose` and `account`.
fn take_challenge(store: &Store<'_>, challenge: &str, purpose: &str, account: &str) -> Result<Row<Challenge>> {
    let row: Row<Challenge> = store.take(Family::Challenges, challenge)?.ok_or(crate::cause!(Error::PasskeyRefused))?;
    if row.value.purpose != purpose || row.account != account {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    Ok(row)
}

fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value.get(name).and_then(Value::as_str).ok_or(crate::cause!(Error::PasskeyRefused))
}

/// Strict base64url (no padding, no trailing bits), as the browser sends it.
fn bytes(encoded: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(encoded).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))
}

fn response(body: &Value) -> Result<&Value> {
    body.get("response").ok_or(crate::cause!(Error::PasskeyRefused))
}

/// The clientDataJSON object of a response.
fn client_data(answer: &Value) -> Result<Map<String, Value>> {
    match serde_json::from_slice(&bytes(text(answer, "clientDataJSON")?)?) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(crate::cause!(Error::PasskeyRefused)),
    }
}

/// The name the browser asked for, trimmed; the default when absent or blank.
fn passkey_name(body: &Value) -> Result<String> {
    let name = match body.get("name") {
        None | Some(Value::Null) => return Ok(DEFAULT_NAME.to_string()),
        Some(Value::String(name)) => name.trim(),
        Some(_) => return Err(crate::cause!(Error::PasskeyRefused)),
    };
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(crate::cause!(Error::PasskeyRefused));
    }
    Ok(if name.is_empty() { DEFAULT_NAME.to_string() } else { name.to_string() })
}

/// The SPKI must be of the algorithm's kind: an uncompressed P-256 point for
/// ES256, an RSA key of at least 2048 bits for RS256.
fn check_public_key(algorithm: i64, spki: &[u8]) -> Result<()> {
    let key = SubjectPublicKeyInfoRef::from_der(spki).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
    let bits = key.subject_public_key.as_bytes().ok_or(crate::cause!(Error::PasskeyRefused))?;
    let oid = key.algorithm.oid.to_string();
    let parameter = key.algorithm.parameters;
    match algorithm {
        ES256 => {
            let curve = parameter.and_then(|p| p.decode_as::<ObjectIdentifier>().ok()).map(|c| c.to_string());
            if oid != "1.2.840.10045.2.1"
                || curve.as_deref() != Some("1.2.840.10045.3.1.7")
                || bits.len() != 65
                || bits[0] != 0x04
            {
                return Err(crate::cause!(Error::PasskeyRefused));
            }
            Ok(())
        }
        RS256 => {
            if oid != "1.2.840.113549.1.1.1" || !parameter.is_some_and(|p| p.decode_as::<Null>().is_ok()) {
                return Err(crate::cause!(Error::PasskeyRefused));
            }
            let mut outer = SliceReader::new(bits).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
            let modulus = outer
                .sequence(|inner| {
                    let modulus = UintRef::decode(inner)?;
                    UintRef::decode(inner)?;
                    Ok(modulus.as_bytes().iter().skip_while(|byte| **byte == 0).count())
                })
                .map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
            outer.finish(()).map_err(|error| crate::carry_cause!(Error::PasskeyRefused, error))?;
            if modulus < MIN_RSA_MODULUS_BYTES {
                return Err(crate::cause!(Error::PasskeyRefused));
            }
            Ok(())
        }
        _ => Err(crate::cause!(Error::PasskeyRefused)),
    }
}

/// The credential `verify_assertion` reads for the stored passkey `id`: {id, publicKey, algorithm}. None for an
/// algorithm this file never saves.
fn credential_of(id: &str, passkey: &Passkey) -> Option<Value> {
    let algorithm = match passkey.algorithm {
        ES256 => "ES256",
        RS256 => "RS256",
        _ => return None,
    };
    Some(json!({"id": id, "publicKey": passkey.public_key, "algorithm": algorithm}))
}

/// The account's own KNOWN passkeys (`known.rs`), as the person-present confirmation of a records write reads them
/// (`account::person_confirmation::Passkeys`). The door registers one for the account it serves
/// (`native_entry::door`), so a write of a value a list marks as needing the person present can be confirmed by the
/// person's passkey and by nothing else.
///
/// Only a known passkey confirms: a passkey added without a known passkey's confirmation (one an AI could hold, from
/// an emailed code or a passkey link it made) is never one, exactly as for a guarded change to the ways in. A use
/// commits the passkey's new counter by compare-and-set (two confirmations racing on one counter cannot both pass),
/// keeps when it was used, and cancels what waits that no known passkey confirmed (`known::cancel_waiting`,
/// invariant 3), as a known passkey's sign-in does.
pub(crate) struct KnownPasskeys {
    storage: super::Shared,
    /// The sign-in account (its user id) whose passkey rows these are.
    account: String,
    /// The door's public origin, "scheme://host[:port]", the one the person's browser signs from.
    origin: String,
    /// The relying party id of that origin (`relying_party`).
    relying_party: String,
}

impl KnownPasskeys {
    /// The known passkeys of sign-in account `account` in `storage`, signed from `origin`. None when `origin` is not
    /// exactly an origin (no relying party can be named for it).
    pub(crate) fn new(storage: super::Shared, account: &str, origin: &str) -> Option<Self> {
        let relying_party = relying_party(origin).ok()?;
        (!account.is_empty()).then(|| KnownPasskeys {
            storage,
            account: account.to_string(),
            origin: origin.to_string(),
            relying_party,
        })
    }

    fn known_rows(&self) -> Result<Vec<Row<Passkey>>> {
        let store = Store::new(&*self.storage);
        let state = super::known::state(&store, &self.account, now_ms())?;
        Ok(state.passkeys.into_iter().filter(|row| state.known.contains(&row.id)).collect())
    }
}

impl std::fmt::Debug for KnownPasskeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KnownPasskeys([redacted])")
    }
}

impl crate::account::person_confirmation::Passkeys for KnownPasskeys {
    fn origin(&self) -> String {
        self.origin.clone()
    }

    fn relying_party(&self) -> String {
        self.relying_party.clone()
    }

    /// The account's known passkeys now; none when the rows cannot be read (which only refuses). The `account` the
    /// records-write authority names is the one this source was registered for, so it is not read again here.
    fn credentials(&self, _account: &str) -> Vec<crate::account::person_confirmation::StoredPasskey> {
        self.known_rows().unwrap_or_default().into_iter().filter_map(|row| {
            Some(crate::account::person_confirmation::StoredPasskey {
                credential: credential_of(&row.id, &row.value)?,
                counter: u32::try_from(row.value.counter).ok()?,
            })
        }).collect()
    }

    fn advance(&self, _account: &str, credential_id: &str, counter: u32) -> bool {
        let store = Store::new(&*self.storage);
        let advanced = || -> Result<bool> {
            let Some(found) = self.known_rows()?.into_iter().find(|row| row.id == credential_id) else { return Ok(false) };
            let (previous, counter) = (found.value.counter, u64::from(counter));
            // verify_assertion enforces this already; kept here as the stated rule.
            if (counter != 0 || previous != 0) && counter <= previous {
                return Ok(false);
            }
            let mut used = found.clone();
            used.value.counter = counter;
            used.value.last_used_at = Some(now_ms());
            if !store.replace_if(Family::Passkeys, &found, &used)? {
                return Ok(false);
            }
            super::known::cancel_waiting(&store, &self.account, now_ms())?;
            Ok(true)
        };
        advanced().unwrap_or(false)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use ring::{
        rand::SystemRandom,
        signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING},
    };

    pub(crate) const ORIGIN: &str = "https://trillion.example";
    pub(crate) const RP: &str = "trillion.example";
    pub(crate) const BOTH: u8 = FLAG_USER_PRESENT | FLAG_USER_VERIFIED;
    const ALL: u8 = BOTH | FLAG_ATTESTED;
    /// SPKI prefix of an uncompressed P-256 public key (91 bytes in all).
    const P256_SPKI_PREFIX: [u8; 26] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48,
        0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    const RSA_SPKI: &str = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsbcofufR22R9iF3V/MYxU5QWNkyPXc7DSiScS6tVhcCQYjwn53Ht\
        fQ6nX+DC/237B8x1qrmf/yhXtvVEfVmXlfbt3U29mHxoPGimSJ9Fkj2+hFD3gtFAv9LV8FFNal1IyQJl5rrRwCtE//005zGK\
        JjIwKNj1A+fPeVs212bRp6eJOTPL5qUmFWdFrROS/6K1BAVB+vDJgBgyPsWNW6qVa/KROZOmqnttPyzUkQdfnK4847TjPYkc\
        NADD2TG6JmrNqQc6GTTYixuhEtb7KnuUS1h7Q5xL6JDnEtjh+y26s5hIxf31u9enJnSI/kBSHs22hnb7OvrulGwD8xc5Cbjc\
        LwIDAQAB";
    /// An RSA-2048 public key (SPKI DER, made with openssl) for registration.
    /// Registration checks the key's shape, not a signature, so no RSA signer is needed.
    /// A 1024-bit RSA public key, which registration refuses.
    const WEAK_SPKI: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDisg2cUjdHGoCmHvo4nKWyAx+EGC50dulcom1c5qzObYaw5mhGYzNABVCV\
        aI9VaeZOZp2Ad2gRxwERVGaOsW/uGFhDl5WxCHQlB5TSjqrVyQ4d5gwOUhSrped7Fx1hMiidcX/wlZH/LTID3ye4PU88sa+8\
        vtJbhNzPCnWnij7uGwIDAQAB";

    /// A simulated authenticator: its key, the SPKI the browser reports, and
    /// its credential id.
    pub(crate) struct Authenticator {
        key: EcdsaKeyPair,
        spki: Vec<u8>,
        pub(crate) id: Vec<u8>,
        algorithm: i64,
    }

    impl Authenticator {
        pub(crate) fn ec(byte: u8) -> Self {
            let rng = SystemRandom::new();
            let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
            let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng).unwrap();
            let mut spki = P256_SPKI_PREFIX.to_vec();
            spki.extend_from_slice(key.public_key().as_ref());
            Authenticator { key, spki, id: vec![byte; 16], algorithm: ES256 }
        }

        /// A registrant that declares the 2048-bit RSA key as RS256. Its signing key is never used.
        fn rsa(byte: u8) -> Self {
            let key = Authenticator::ec(byte).key;
            Authenticator {
                key,
                spki: STANDARD.decode(RSA_SPKI).unwrap(),
                id: vec![byte; 16],
                algorithm: RS256,
            }
        }

        fn sign(&self, message: &[u8]) -> Vec<u8> {
            self.key.sign(&SystemRandom::new(), message).unwrap().as_ref().to_vec()
        }
    }

    /// The passkey row `auth` would be stored as, with `authority`, as a test that needs no ceremony writes it.
    pub(crate) fn row_of(auth: &Authenticator, account: &str, authority: Option<crate::account::sign_in::known::Authority>) -> Row<Passkey> {
        Row {
            id: b(&auth.id),
            account: account.to_string(),
            expires_at: 0,
            value: Passkey { public_key: b(&auth.spki), algorithm: auth.algorithm, counter: 0, name: "Passkey".into(), created_at: 1, last_used_at: None, authority },
        }
    }

    pub(crate) fn b(bytes: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn client_json(kind: &str, challenge: &str, origin: &str, cross_origin: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({"type": kind, "challenge": challenge, "origin": origin, "crossOrigin": cross_origin}))
            .unwrap()
    }

    fn authenticator_data(rp: &str, flags: u8, counter: u32, attested: Option<&[u8]>) -> Vec<u8> {
        let mut data = digest::digest(&digest::SHA256, rp.as_bytes()).as_ref().to_vec();
        data.push(flags);
        data.extend_from_slice(&counter.to_be_bytes());
        if let Some(id) = attested {
            data.extend_from_slice(&[0u8; AAGUID_BYTES]);
            data.extend_from_slice(&(id.len() as u16).to_be_bytes());
            data.extend_from_slice(id);
            // Stands in for the COSE key, which this door does not parse.
            data.extend_from_slice(&[0xa5, 0x01, 0x02]);
        }
        data
    }

    /// A registration answer for `challenge` that passes every check.
    pub(crate) fn registration(auth: &Authenticator, challenge: &str) -> Value {
        let client = client_json("webauthn.create", challenge, ORIGIN, false);
        let data = authenticator_data(RP, ALL, 0, Some(&auth.id));
        json!({
            "id": b(&auth.id),
            "rawId": b(&auth.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b(&client),
                "authenticatorData": b(&data),
                "publicKey": b(&auth.spki),
                "publicKeyAlgorithm": auth.algorithm,
            },
        })
    }

    /// An assertion for `challenge`, signed over authenticatorData and the
    /// clientDataJSON hash, with the given origin, RP and flags.
    pub(crate) fn assertion(auth: &Authenticator, challenge: &str, origin: &str, rp: &str, flags: u8, counter: u32) -> Value {
        let client = client_json("webauthn.get", challenge, origin, false);
        let data = authenticator_data(rp, flags, counter, None);
        let mut message = data.clone();
        message.extend_from_slice(digest::digest(&digest::SHA256, &client).as_ref());
        let signature = auth.sign(&message);
        json!({
            "id": b(&auth.id),
            "rawId": b(&auth.id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b(&client),
                "authenticatorData": b(&data),
                "signature": b(&signature),
            },
        })
    }

    fn set_response(body: &mut Value, field: &str, value: &[u8]) {
        body["response"][field] = json!(b(value));
    }

    fn challenge_of(options: &Value) -> String {
        options["challenge"].as_str().unwrap().to_string()
    }

    fn fresh_registration_challenge(store: &Store<'_>, account: &str) -> String {
        challenge_of(&registration_options(store, account, ORIGIN).unwrap())
    }

    fn fresh_sign_in_challenge(store: &Store<'_>) -> String {
        challenge_of(&sign_in_options(store, "owner", ORIGIN).unwrap())
    }

    fn stored(store: &Store<'_>, id: &[u8]) -> Passkey {
        store.get::<Passkey>(Family::Passkeys, &b(id)).unwrap().unwrap().value
    }

    /// Register `auth` for `account` and answer the credential id.
    fn register_passkey(store: &Store<'_>, account: &str, auth: &Authenticator) -> String {
        let challenge = fresh_registration_challenge(store, account);
        finish_registration(store, account, ORIGIN, &registration(auth, &challenge)).unwrap()
    }

    #[test]
    fn options_name_the_relying_party_and_exclude_existing_passkeys() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let first = registration_options(&store, "ada", ORIGIN).unwrap();
        assert_eq!(first["rp"]["id"], RP);
        assert_eq!(first["user"]["id"], b(&user_handle("ada")));
        assert_eq!(first["timeout"], 300_000);
        assert_eq!(first["excludeCredentials"], json!([]));
        assert_eq!(first["pubKeyCredParams"], json!([{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}]));
        let auth = Authenticator::ec(1);
        let id = register_passkey(&store, "ada", &auth);
        let second = registration_options(&store, "ada", ORIGIN).unwrap();
        assert_eq!(second["excludeCredentials"], json!([{"type": "public-key", "id": id}]));
        let sign_in = sign_in_options(&store, "owner", ORIGIN).unwrap();
        assert_eq!(sign_in["rpId"], RP);
        assert_eq!(sign_in["userVerification"], "required");
        assert!(sign_in.get("allowCredentials").is_none());
        assert_eq!(registration_options(&store, "", ORIGIN), Err(crate::cause!(Error::PasskeyRefused)));
        assert_eq!(registration_options(&store, "ada", "https://trillion.example/"), Err(crate::cause!(Error::PasskeyRefused)));
    }

    #[test]
    fn registration_then_sign_in_round_trip() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::ec(1);
        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["name"] = json!("  Work laptop  ");
        let id = finish_registration(&store, "ada", ORIGIN, &body).unwrap();
        assert_eq!(id, b(&auth.id));
        let row = store.get::<Passkey>(Family::Passkeys, &id).unwrap().unwrap();
        assert_eq!(row.account, "ada");
        assert_eq!(row.value.name, "Work laptop");
        assert_eq!(row.value.algorithm, ES256);
        assert_eq!(row.value.counter, 0);
        assert_eq!(row.value.last_used_at, None);

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 3);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), Ok("ada".to_string()));
        let after = stored(&store, &auth.id);
        assert_eq!(after.counter, 3);
        assert!(after.last_used_at.is_some());
    }

    #[test]
    fn rsa_registration_is_stored_as_rs256_with_the_default_name() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::rsa(7);
        let id = register_passkey(&store, "ada", &auth);
        assert_eq!(id, b(&auth.id));
        let row = stored(&store, &auth.id);
        assert_eq!(row.algorithm, RS256);
        assert_eq!(row.name, "Passkey");
        assert_eq!(row.public_key, b(&auth.spki));
    }

    #[test]
    fn zero_counters_are_accepted_as_the_rule_allows() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::ec(2);
        register_passkey(&store, "ada", &auth);
        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 0);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), Ok("ada".to_string()));
    }

    #[test]
    fn registration_refuses_every_bad_ceremony() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::ec(3);
        let refused = Err(crate::cause!(Error::PasskeyRefused));

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["clientDataJSON"] = json!(b(&client_json("webauthn.create", &challenge, "https://evil.example", false)));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "wrong origin");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["clientDataJSON"] = json!(b(&client_json("webauthn.get", &challenge, ORIGIN, false)));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "wrong type");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["clientDataJSON"] = json!(b(&client_json("webauthn.create", &challenge, ORIGIN, true)));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "cross origin");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["authenticatorData"] = json!(b(&authenticator_data("evil.example", ALL, 0, Some(&auth.id))));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "wrong rpIdHash");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        set_response(&mut body, "authenticatorData", &authenticator_data(RP, FLAG_USER_PRESENT | FLAG_ATTESTED, 0, Some(&auth.id)));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "missing user verification");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        set_response(&mut body, "authenticatorData", &authenticator_data(RP, FLAG_USER_VERIFIED | FLAG_ATTESTED, 0, Some(&auth.id)));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "missing user presence");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        set_response(&mut body, "authenticatorData", &authenticator_data(RP, BOTH, 0, None));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "no attested credential");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        set_response(&mut body, "authenticatorData", &authenticator_data(RP, ALL, 0, Some(&[9u8; 16])));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "attested id differs from rawId");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["rawId"] = json!(b(&[9u8; 16]));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "id differs from rawId");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["type"] = json!("password");
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "wrong credential type");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["publicKeyAlgorithm"] = json!(-8);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "unsupported algorithm");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["publicKeyAlgorithm"] = json!(RS256);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "EC key declared as RSA");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["response"]["publicKey"] = json!(b(b"not a key"));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "not SPKI DER");

        let challenge = fresh_registration_challenge(&store, "ada");
        let rsa = Authenticator::rsa(4);
        let mut body = registration(&rsa, &challenge);
        body["response"]["publicKeyAlgorithm"] = json!(ES256);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "RSA key declared as EC");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut weak = Authenticator::rsa(5);
        weak.spki = STANDARD.decode(WEAK_SPKI).unwrap();
        let body = registration(&weak, &challenge);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "1024-bit RSA");

        let challenge = fresh_registration_challenge(&store, "ada");
        let mut body = registration(&auth, &challenge);
        body["name"] = json!("x".repeat(101));
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "name too long");

        let challenge = fresh_registration_challenge(&store, "ada");
        let body = registration(&auth, &challenge);
        assert_eq!(finish_registration(&store, "bob", ORIGIN, &body), refused, "challenge of another account");

        let challenge = fresh_sign_in_challenge(&store);
        let body = registration(&auth, &challenge);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "sign-in challenge used to register");

        let spent = fresh_registration_challenge(&store, "ada");
        let body = registration(&auth, &spent);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), Ok(b(&auth.id)), "the clean ceremony still works");
        let other = Authenticator::ec(10);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &registration(&other, &spent)), refused, "challenge already used");

        let challenge = fresh_registration_challenge(&store, "ada");
        let body = registration(&auth, &challenge);
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "duplicate credential");

        let body = registration(&other, "never-issued");
        assert_eq!(finish_registration(&store, "ada", ORIGIN, &body), refused, "challenge never issued");
    }

    #[test]
    fn sign_in_refuses_every_bad_assertion() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::ec(6);
        register_passkey(&store, "ada", &auth);
        let refused = Err(crate::cause!(Error::PasskeyRefused));

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, "https://evil.example", RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "wrong origin");

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, "evil.example", BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "wrong rpIdHash");

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, FLAG_USER_PRESENT, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "missing user verification");

        let challenge = fresh_registration_challenge(&store, "ada");
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "registration challenge used to sign in");

        let challenge = fresh_sign_in_challenge(&store);
        let mut body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 1);
        let signature = body["response"]["signature"].as_str().unwrap().to_string();
        let mut raw = bytes(&signature).unwrap();
        *raw.last_mut().unwrap() ^= 0x01;
        body["response"]["signature"] = json!(b(&raw));
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "bad signature");

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&Authenticator::ec(8), &challenge, ORIGIN, RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "unknown credential");

        let challenge = fresh_sign_in_challenge(&store);
        let mut body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 1);
        body["rawId"] = json!(b(&[9u8; 16]));
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "id differs from rawId");

        let body = assertion(&auth, "never-issued", ORIGIN, RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "challenge never issued");

        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), Ok("ada".to_string()), "the clean assertion works");
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "reused challenge");
        assert_eq!(stored(&store, &auth.id).counter, 1);

        // Counter rule: the stored counter is 1 now; a repeat or a lower value is refused and changes nothing.
        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 1);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "counter not increased");
        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 0);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), refused, "counter went to zero");
        assert_eq!(stored(&store, &auth.id).counter, 1);
        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 2);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), Ok("ada".to_string()), "counter advanced");
        assert_eq!(stored(&store, &auth.id).counter, 2);
    }

    #[test]
    fn sign_in_refuses_a_stored_counter_it_cannot_advance_past() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let auth = Authenticator::ec(9);
        register_passkey(&store, "ada", &auth);
        let challenge = fresh_sign_in_challenge(&store);
        assert_eq!(finish_sign_in(&store, ORIGIN, &assertion(&auth, &challenge, ORIGIN, RP, BOTH, 5)), Ok("ada".to_string()));
        let challenge = fresh_sign_in_challenge(&store);
        let body = assertion(&auth, &challenge, ORIGIN, RP, BOTH, 4);
        assert_eq!(finish_sign_in(&store, ORIGIN, &body), Err(crate::cause!(Error::PasskeyRefused)), "lower counter");
        assert_eq!(stored(&store, &auth.id).counter, 5);
    }

    #[test]
    fn the_relying_party_leaves_out_leading_host_labels_but_never_goes_below_two() {
        assert_eq!(host_suffix("app.door.example", 1), "door.example");
        assert_eq!(host_suffix("a.app.door.example", 1), "app.door.example");
        assert_eq!(host_suffix("door.example", 1), "door.example");
        assert_eq!(host_suffix("localhost", 1), "localhost");
        assert_eq!(host_suffix("127.0.0.1", 1), "127.0.0.1");
        assert_eq!(host_suffix("[::1]", 1), "[::1]");
        assert_eq!(host_suffix("app.door.example", 0), "app.door.example");
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        assert_eq!(sign_in_options(&store, "owner", "https://app.door.example").unwrap()["rpId"], "door.example");
    }

    #[test]
    fn a_door_note_an_earlier_build_wrote_still_names_its_account_and_origin() {
        let state = tempfile::tempdir().unwrap();
        std::fs::write(state.path().join(&super::super::contract().door_note_file), br#"{"account":"ada","origin":"https://app.door.example"}"#).unwrap();
        let note = super::super::read_door_note(state.path()).unwrap();
        assert_eq!((note.account.as_str(), note.address.as_str(), note.origin.as_str()), ("ada", "", "https://app.door.example"));
    }

    #[test]
    fn a_passkey_is_removed_but_never_the_last_way_in() {
        let memory = crate::account::sign_in::lists::test_memory();
        let store = Store::new(&memory);
        let first = register_passkey(&store, "ada", &Authenticator::ec(70));
        let second = register_passkey(&store, "ada", &Authenticator::ec(71));
        register_passkey(&store, "bea", &Authenticator::ec(72));
        assert_eq!(remove(&store, "ada", &b(&Authenticator::ec(72).id), None), Err(crate::cause!(RemoveRefused::NotHere)), "another account's");
        assert_eq!(remove(&store, "ada", &second, None), Ok(()));
        assert_eq!(remove(&store, "ada", &second, None), Err(crate::cause!(RemoveRefused::NotHere)), "already gone");
        assert_eq!(remove(&store, "ada", &first, None), Err(crate::cause!(RemoveRefused::LastWayIn)), "no other way in");
        // A held way that alone keeps the account reachable lets the last passkey go.
        let ways = crate::account::sign_in::ways::for_tests();
        crate::account::sign_in::ways::set(&store, "ada", 0, ways.clone()).unwrap();
        assert_eq!(remove(&store, "ada", &first, Some(&ways)), Err(crate::cause!(RemoveRefused::LastWayIn)), "a ways row with nothing held");
        let who = crate::account::sign_in::ways::Adding { account: "ada", address: "", method: "passkey", issuer: RP };
        let alone = ways.rows.iter().find(|row| row.alone && row.proof == crate::account::sign_in::ways::Proof::Listed).expect("an alone listed way");
        crate::account::sign_in::ways::add(&store, &ways, &who, alone, &Default::default(), None).unwrap();
        assert_eq!(remove(&store, "ada", &first, Some(&ways)), Ok(()));
    }

}
