//! Personal keys, for scripts and services that can only hold a key. A key is
//! `contract().personal_key_prefix` + the account's address (64 hex, derived from its signing key) + `_` +
//! `random_hex(32)`, shown once, stored by `blake3_hex(key)`. The address in
//! the key lets the forwarder read which account a key names without a lookup;
//! the secret part is checked only here, by the fingerprint. A key carries a name, scopes and an optional expiry, and
//! can be turned off (removed). Besides the scopes an AI app may be granted, a
//! key may hold `contract().account_scope`, the sign-in's own management, which
//! OAuth never offers. A key is the same kind of principal as an OAuth
//! grant, checked in the same computer, so it works at every door alike.
//!
//! Stored values, owned by this file:
//! - personal_keys: `PersonalKey`, id = blake3_hex(key)

use super::store::{Family, Row, Store};
use super::tokens::{self, blake3_hex, random_hex};
use super::{now_ms, contract, Error, Principal, Result};
use serde::{Deserialize, Serialize};

/// Longest name a key may carry, in characters after trimming.
const NAME_MAX_CHARS: usize = 100;

/// `last_used_at` is written at most this often, so a busy key does not write on every call.
const LAST_USED_EVERY_MS: u64 = 60_000;

/// Most keys one account is listed with.
const LIST_LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct PersonalKey {
    pub name: String,
    pub scopes: Vec<String>,
    /// The key's last 4 characters, for the list.
    pub ending: String,
    pub created_at: u64,
    pub last_used_at: Option<u64>,
}

/// Issue a key for `account` (its sign-in rows) that names `address` (its address). Answers the key text (shown
/// once) and its id.
pub(crate) fn issue(store: &Store<'_>, account: &str, address: &str, name: &str, scopes: &[String], expires_at: u64)
    -> Result<(String, String)> {
    let settings = contract();
    if !tokens::owner_text_ok(address) {
        return Err(Error::InvalidRequest("address must be 64 lowercase hex characters", crate::cause!()));
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX_CHARS {
        return Err(Error::InvalidRequest("name must be 1 to 100 characters", crate::cause!()));
    }
    if scopes.is_empty() {
        return Err(Error::InvalidRequest("scopes must not be empty", crate::cause!()));
    }
    if !scopes_known(scopes) {
        return Err(Error::InvalidRequest("unknown scope", crate::cause!()));
    }
    let now = now_ms();
    if expires_at != 0 && expires_at <= now {
        return Err(Error::InvalidRequest("expires_at must be 0 or in the future", crate::cause!()));
    }
    let mut kept: Vec<String> = Vec::new();
    for scope in scopes {
        if !kept.contains(scope) {
            kept.push(scope.clone());
        }
    }
    let key = format!("{}{address}_{}", settings.personal_key_prefix, random_hex(32));
    let id = blake3_hex(&key);
    let row = Row {
        id: id.clone(),
        account: account.to_string(),
        expires_at,
        value: PersonalKey {
            name: name.to_string(),
            scopes: kept,
            ending: key[key.len() - 4..].to_string(),
            created_at: now,
            last_used_at: None,
        },
    };
    store.insert(Family::PersonalKeys, &row)?;
    Ok((key, id))
}

/// The scope names a personal key may hold, shared by input validation and the key writer. Reach within the
/// caller's own current scopes is a separate authority check, never a way to accept an unknown scope.
pub(crate) fn scopes_known(scopes: &[String]) -> bool {
    let settings = contract();
    scopes.iter().all(|scope| settings.scopes.contains(scope) || *scope == settings.account_scope)
}

/// How a principal names the personal key it signs in as: `key:<key id>`.
pub(crate) const KEY_SIGN_IN: &str = "key:";

/// How a principal names the personal key `id` it signs in as: `key:<key id>`.
pub(crate) fn sign_in_name(id: &str) -> String {
    format!("{KEY_SIGN_IN}{id}")
}

/// The keys of `account`.
pub(crate) fn list(store: &Store<'_>, account: &str) -> Result<Vec<Row<PersonalKey>>> {
    store.list(Family::PersonalKeys, account, LIST_LIMIT)
}

/// Turn off key `id` of `account`.
pub(crate) fn turn_off(store: &Store<'_>, account: &str, id: &str) -> Result<bool> {
    match store.get::<PersonalKey>(Family::PersonalKeys, id)? {
        Some(row) if row.account == account => store.remove(Family::PersonalKeys, id),
        _ => Ok(false),
    }
}

/// The principal of a presented key, or `None`. A key in any other shape (including the shape before addresses
/// were added) is refused before any lookup.
pub(crate) fn check(store: &Store<'_>, key: &str) -> Result<Option<Principal>> {
    let Some(mut row) = key_row(store, key)? else { return Ok(None) };
    let now = now_ms();
    let due = match row.value.last_used_at {
        Some(used) => now.saturating_sub(used) >= LAST_USED_EVERY_MS,
        None => true,
    };
    if due {
        row.value.last_used_at = Some(now);
        store.put(Family::PersonalKeys, &row)?;
    }
    Ok(Some(principal(row)))
}

/// A retained call's current key, read afresh without writing its last-use note. A delivery check must not start
/// a replicated activity write; initial admission keeps that work in `check`.
pub(crate) fn current(store: &Store<'_>, key: &str) -> Result<Option<Principal>> {
    Ok(key_row(store, key)?.map(principal))
}

/// The principal the live key `id` (its stored id, the BLAKE3 of the key) acts as now, read without its last-use note:
/// how a run a key's holder started is admitted again by its cause's own sign-in name (`key:<id>`), never by a kept copy
/// of the key. A key turned off answers `None`, so the run stops at its next check.
pub(crate) fn named(store: &Store<'_>, id: &str) -> Result<Option<Principal>> {
    Ok(store.get::<PersonalKey>(Family::PersonalKeys, id)?.map(principal))
}

fn key_row(store: &Store<'_>, key: &str) -> Result<Option<Row<PersonalKey>>> {
    if tokens::credential_address(key).is_none() {
        return Ok(None);
    }
    store.get(Family::PersonalKeys, &blake3_hex(key))
}

fn principal(row: Row<PersonalKey>) -> Principal {
    Principal {
        account: row.account,
        sign_in: sign_in_name(&row.id),
        client_id: Some(row.value.name),
        scopes: row.value.scopes,
        expires_at_ms: row.expires_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    /// A well-formed owner id for the tests (64 lowercase hex).
    const OWNER: &str = "abababababababababababababababababababababababababababababababab";

    fn fixture() -> Memory {
        crate::account::sign_in::lists::test_memory()
    }

    fn records() -> Vec<String> {
        vec!["records".to_string()]
    }

    fn issue_key(store: &Store<'_>, account: &str) -> (String, String) {
        issue(store, account, OWNER, "ci", &records(), 0).expect("issued")
    }

    /// A key in the current shape, not stored by anyone.
    fn unissued_key() -> String {
        format!("{}{OWNER}_{}", contract().personal_key_prefix, random_hex(32))
    }

    fn put_key(store: &Store<'_>, key: &str, account: &str, expires_at: u64, last_used_at: Option<u64>) {
        let row = Row {
            id: blake3_hex(key),
            account: account.to_string(),
            expires_at,
            value: PersonalKey { name: "old".to_string(), scopes: records(), ending: key[key.len() - 4..].to_string(), created_at: 1, last_used_at },
        };
        store.put(Family::PersonalKeys, &row).expect("row written");
    }

    #[test]
    fn issue_answers_the_key_once_and_stores_only_its_fingerprint() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, id) = issue(&store, "acct", OWNER, "  ci  ", &["tools".to_string(), "records".to_string()], 0).unwrap();
        let prefix = &contract().personal_key_prefix;
        assert!(key.starts_with(&format!("{prefix}{OWNER}_")), "the key names its owner");
        assert_eq!(key.len(), prefix.len() + OWNER.len() + 1 + 64);
        assert_eq!(id, blake3_hex(&key));
        assert!(store.get::<PersonalKey>(Family::PersonalKeys, &key).unwrap().is_none(), "the key text is not a row id");

        let row = store.get::<PersonalKey>(Family::PersonalKeys, &id).unwrap().expect("stored");
        assert_eq!(row.account, "acct");
        assert_eq!(row.expires_at, 0);
        assert_eq!(row.value.name, "ci");
        assert_eq!(row.value.scopes, vec!["tools".to_string(), "records".to_string()]);
        assert_eq!(row.value.ending, &key[key.len() - 4..]);
        assert_eq!(row.value.last_used_at, None);
    }

    #[test]
    fn issue_refuses_bad_requests() {
        let mem = fixture();
        let store = Store::new(&mem);
        let refused = |name: &str, scopes: &[String], expires_at: u64| issue(&store, "acct", OWNER, name, scopes, expires_at);
        assert_eq!(refused("", &records(), 0), Err(Error::InvalidRequest("name must be 1 to 100 characters", crate::cause!())));
        assert_eq!(refused("   ", &records(), 0), Err(Error::InvalidRequest("name must be 1 to 100 characters", crate::cause!())));
        assert_eq!(refused(&"x".repeat(101), &records(), 0), Err(Error::InvalidRequest("name must be 1 to 100 characters", crate::cause!())));
        assert!(refused(&"x".repeat(100), &records(), 0).is_ok());
        assert_eq!(refused("ci", &[], 0), Err(Error::InvalidRequest("scopes must not be empty", crate::cause!())));
        assert_eq!(refused("ci", &["admin".to_string()], 0), Err(Error::InvalidRequest("unknown scope", crate::cause!())));
        assert_eq!(refused("ci", &records(), now_ms() - 1_000), Err(Error::InvalidRequest("expires_at must be 0 or in the future", crate::cause!())));
        for owner in ["owner", &OWNER.to_uppercase(), &OWNER[1..], ""] {
            assert_eq!(issue(&store, "acct", owner, "ci", &records(), 0),
                Err(Error::InvalidRequest("address must be 64 lowercase hex characters", crate::cause!())), "owner {owner:?}");
        }
    }

    #[test]
    fn check_answers_the_principal_of_a_good_key() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, id) = issue_key(&store, "acct");
        let principal = check(&store, &key).unwrap().expect("a principal");
        assert_eq!(principal.account, "acct");
        assert_eq!(principal.sign_in, format!("key:{id}"));
        assert_eq!(principal.client_id, Some("ci".to_string()));
        assert_eq!(principal.scopes, records());
        assert_eq!(principal.expires_at_ms, 0);
    }

    #[test]
    fn check_reports_a_future_expiry() {
        let mem = fixture();
        let store = Store::new(&mem);
        let expires = now_ms() + 60_000;
        let (key, _) = issue(&store, "acct", OWNER, "ci", &records(), expires).unwrap();
        assert_eq!(check(&store, &key).unwrap().expect("live").expires_at_ms, expires);
    }

    #[test]
    fn check_refuses_malformed_keys() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, _) = issue_key(&store, "acct");
        let prefix = contract().personal_key_prefix.clone();
        let secret = &key[prefix.len() + OWNER.len() + 1..];
        let refused = vec![
            String::new(),
            prefix.clone(),
            secret.to_string(),
            format!("xx_{OWNER}_{secret}"),
            format!("{prefix}{secret}"),
            format!("{prefix}{OWNER}{secret}"),
            format!("{prefix}{OWNER}-{secret}"),
            format!("{prefix}{}_{secret}", OWNER.to_uppercase()),
            format!("{prefix}{}_{secret}", &OWNER[1..]),
            format!("{prefix}{OWNER}_{}", &secret[..63]),
            format!("{prefix}{OWNER}_{secret}0"),
            format!("{prefix}{OWNER}_{}", secret.to_uppercase()),
            format!("{prefix}{OWNER}_{}g", &secret[..63]),
        ];
        for presented in refused {
            assert_eq!(check(&store, &presented).unwrap(), None, "key {presented:?}");
        }
    }

    #[test]
    fn an_old_shape_key_is_refused_even_when_it_was_stored() {
        let mem = fixture();
        let store = Store::new(&mem);
        let old = format!("{}{}", contract().personal_key_prefix, random_hex(32));
        put_key(&store, &old, "acct", 0, None);
        assert_eq!(check(&store, &old).unwrap(), None, "the old shape is refused before the lookup");
    }

    #[test]
    fn check_refuses_an_unknown_key() {
        let mem = fixture();
        let store = Store::new(&mem);
        assert_eq!(check(&store, &unissued_key()).unwrap(), None);
    }

    #[test]
    fn check_refuses_an_expired_key() {
        let mem = fixture();
        let store = Store::new(&mem);
        let key = unissued_key();
        put_key(&store, &key, "acct", now_ms() - 1, None);
        assert_eq!(check(&store, &key).unwrap(), None);
        assert!(list(&store, "acct").unwrap().is_empty(), "an expired key is not listed");
    }

    #[test]
    fn a_turned_off_key_is_refused() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, id) = issue_key(&store, "acct");
        assert!(turn_off(&store, "acct", &id).unwrap());
        assert_eq!(check(&store, &key).unwrap(), None);
        assert!(!turn_off(&store, "acct", &id).unwrap(), "already off");
    }

    #[test]
    fn another_account_cannot_turn_a_key_off() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, id) = issue_key(&store, "owner");
        assert!(!turn_off(&store, "intruder", &id).unwrap());
        assert!(check(&store, &key).unwrap().is_some());
        assert_eq!(list(&store, "owner").unwrap().len(), 1);
        assert!(list(&store, "intruder").unwrap().is_empty());
    }

    #[test]
    fn list_answers_only_the_accounts_keys() {
        let mem = fixture();
        let store = Store::new(&mem);
        issue_key(&store, "a");
        issue_key(&store, "a");
        issue_key(&store, "b");
        let mine = list(&store, "a").unwrap();
        assert_eq!(mine.len(), 2);
        assert!(mine.iter().all(|row| row.account == "a" && row.value.name == "ci"));
    }

    #[test]
    fn last_used_is_written_at_most_once_a_minute() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (key, id) = issue_key(&store, "acct");

        check(&store, &key).unwrap().expect("live");
        let first = store.get::<PersonalKey>(Family::PersonalKeys, &id).unwrap().unwrap().value.last_used_at;
        assert!(first.is_some());

        check(&store, &key).unwrap().expect("live");
        let second = store.get::<PersonalKey>(Family::PersonalKeys, &id).unwrap().unwrap().value.last_used_at;
        assert_eq!(second, first, "a second use within the minute writes nothing");

        put_key(&store, &key, "acct", 0, Some(now_ms() - 2 * LAST_USED_EVERY_MS));
        let before = now_ms();
        check(&store, &key).unwrap().expect("live");
        let third = store.get::<PersonalKey>(Family::PersonalKeys, &id).unwrap().unwrap().value.last_used_at;
        assert!(third.unwrap() >= before, "a use after a minute is recorded");
    }
}
