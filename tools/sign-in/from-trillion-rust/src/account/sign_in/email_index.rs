// src/account/sign_in/email_index.rs
//
// Purpose: which account an email goes by, so the root sign-in page can find an account from its email. One row per
// email in the operator account's `email_index` family: its id is the keyed BLAKE3 hash of the email in the one form
// `ways::normal_name` keeps it (the `email` name shape, DATA in the account's ways row), and its value is the account
// address only. The operator account is the product settings' `sign_up_hosting.operator_account`
// (src/account_files/identity.json `sections`); a product whose settings carry no such section indexes no email.
//
// Non-negotiable invariants:
// 1. The index holds no plain email: the id is a keyed BLAKE3 hash under a key derived from the account's secrets key
//    (`email_index.json` `key_context`), so a copy of the rows reveals no email without that key.
// 2. A claim is a create-if-absent write (`Store::insert`), so two claims of one email cannot both succeed. A claim of an
//    email held by another account is refused `Taken`; the same account claiming again succeeds.
// 3. An email enters the index only after its inbox answered a code for the account (old trillion invariant 5,
//    src/sign-in-email.mjs). The caller claims after the code is answered, never before.
// 4. A move claims the new email first and releases the old one after, so a refused move leaves the old email held.
// 5. A lookup of an unindexed text, or of a text that is not an email, answers None, so the caller answers both with the
//    same words.
//
// Stored values, owned by this file: the `email_index` family (`families.json`) rows, with the value `{address}`; the
// key context is `email_index.json`; the operator account is the `sign_up_hosting` section.

use super::{
    store::{Family, Row, Store},
    ways::{self, WaySettings},
    Address, UserId,
};
use crate::secrets::SecretsKey;
use content_crypto::advanced::blake3;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    key_context: String,
    window_seconds: u64,
    lookup_per_email: u64,
    claim_per_computer: u64,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| serde_json::from_slice(include_bytes!("email_index.json")).expect("email_index.json is valid"))
}

/// The attempts counted under one key in its window (the operator's tries family, keyed, never a plain email).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Attempts {
    count: u64,
}

/// Attempts an email lookup may make per email in its window (`email_index.json` `lookup_per_email`).
pub(crate) fn lookup_per_email() -> u64 {
    settings().lookup_per_email
}

/// Claims one hosting computer may send per window (`email_index.json` `claim_per_computer`).
pub(crate) fn claim_per_computer() -> u64 {
    settings().claim_per_computer
}

/// The value of an `email_index` row: the account address the email goes by.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Entry {
    address: String,
}

/// Why an email is not claimed or moved. Each answer names its cause, never the address.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Refused {
    /// The typed text is not an email of the account's name shape.
    NotAnEmail(crate::refusal_cause::Cause),
    /// Another account holds this email.
    Taken(crate::refusal_cause::Cause),
    /// The index could not be read or written.
    Storage(crate::refusal_cause::Cause),
}

pub(crate) type Result<T> = std::result::Result<T, Refused>;

/// The row id of `email`: its keyed BLAKE3 hash under the index key of the account's secrets key.
fn row_id(secrets: &SecretsKey, email: &str) -> String {
    blake3::keyed_hash(&secrets.derive(&settings().key_context), email.as_bytes()).to_hex().to_string()
}

/// `text` in the one form the index keeps it by, or None when it is not an email.
pub(crate) fn normal_form(names: &WaySettings, text: &str) -> Option<String> {
    normal(names, text).ok()
}

/// `text` in the one form the index keeps it by, or `NotAnEmail`.
fn normal(names: &WaySettings, text: &str) -> Result<String> {
    ways::normal_name(names, "email", text).ok_or(crate::cause!(Refused::NotAnEmail))
}

/// The account address the email `text` goes by, or None when no account is indexed under it (or it is not an email).
pub(crate) fn lookup(store: &Store<'_>, secrets: &SecretsKey, names: &WaySettings, text: &str) -> Result<Option<String>> {
    let Ok(email) = normal(names, text) else { return Ok(None) };
    let held = store.get::<Entry>(Family::EmailIndex, &row_id(secrets, &email)).map_err(|error| crate::carry_cause!(Refused::Storage, error))?;
    Ok(held.map(|row| row.value.address))
}

/// Claim `text`'s email for `address`, in the operator account `operator`. Create-if-absent: a row another account holds
/// is refused `Taken`. Call only after the email's inbox answered a code for `address` (invariant 3).
pub(crate) fn claim(store: &Store<'_>, secrets: &SecretsKey, names: &WaySettings, operator: UserId<'_>, text: &str, address: Address<'_>) -> Result<()> {
    let id = row_id(secrets, &normal(names, text)?);
    if let Some(held) = store.get::<Entry>(Family::EmailIndex, &id).map_err(|error| crate::carry_cause!(Refused::Storage, error))? {
        return if held.value.address == address.0 { Ok(()) } else { Err(crate::cause!(Refused::Taken)) };
    }
    let row = Row { id: id.clone(), account: operator.0.to_owned(), expires_at: 0, value: Entry { address: address.0.to_owned() } };
    match store.insert(Family::EmailIndex, &row) {
        Ok(()) => Ok(()),
        // Another claim wrote the row between the read and the insert: its answer is the one that counts.
        Err(_) => match store.get::<Entry>(Family::EmailIndex, &id).map_err(|error| crate::carry_cause!(Refused::Storage, error))? {
            Some(held) if held.value.address == address.0 => Ok(()),
            Some(_) => Err(crate::cause!(Refused::Taken)),
            None => Err(crate::cause!(Refused::Storage)),
        },
    }
}

/// Counts one attempt under `key` (any text the caller keys by; the row id is keyed, so no key text is stored) in the
/// operator account's tries family. Answers false, without counting, once `limit` attempts fell in the window that is
/// still open; the window opens at the first attempt and ends `window_seconds` later.
pub(crate) fn count_attempt(store: &Store<'_>, secrets: &SecretsKey, operator: UserId<'_>, key: &str, limit: u64) -> Result<bool> {
    let id = row_id(secrets, &format!("attempts:{key}"));
    let now = super::now_ms();
    let (count, expires_at) = match store.get::<Attempts>(Family::Tries, &id).map_err(|error| crate::carry_cause!(Refused::Storage, error))? {
        Some(held) => (held.value.count, held.expires_at),
        None => (0, now + settings().window_seconds * 1000),
    };
    if count >= limit {
        return Ok(false);
    }
    let row = Row { id, account: operator.0.to_owned(), expires_at, value: Attempts { count: count + 1 } };
    store.put(Family::Tries, &row).map_err(|error| crate::carry_cause!(Refused::Storage, error))?;
    Ok(true)
}

/// Release `text`'s email if `address` holds it. Answers whether a row was removed.
pub(crate) fn release(store: &Store<'_>, secrets: &SecretsKey, names: &WaySettings, text: &str, address: Address<'_>) -> Result<bool> {
    let id = row_id(secrets, &normal(names, text)?);
    match store.get::<Entry>(Family::EmailIndex, &id).map_err(|error| crate::carry_cause!(Refused::Storage, error))? {
        Some(held) if held.value.address == address.0 => store.remove(Family::EmailIndex, &id).map_err(|error| crate::carry_cause!(Refused::Storage, error)),
        _ => Ok(false),
    }
}

/// Move `address`'s claim from `old` to `new` in `operator`: claim `new` first, then release `old`, so a refused claim
/// leaves `old` held.
pub(crate) fn move_claim(store: &Store<'_>, secrets: &SecretsKey, names: &WaySettings, operator: UserId<'_>, old: &str, new: &str, address: Address<'_>) -> Result<()> {
    claim(store, secrets, names, operator, new, address)?;
    if normal(names, old)? != normal(names, new)? {
        release(store, secrets, names, old, address)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "email_index_tests.rs"]
mod tests;
