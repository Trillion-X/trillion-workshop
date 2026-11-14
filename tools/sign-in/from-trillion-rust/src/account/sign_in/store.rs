//! Typed rows over the `sign_in` families (`families.json` beside this file).
//! Every family has the same four fields: `id`, `account`, `expires_at` (ms,
//! 0 = never) and `value` (the record's JSON text). A row past its
//! `expires_at` reads as absent. Each module owns the JSON shape of its own
//! family's `value`; this file only moves rows.

use super::{now_ms, computer, Error, Result};
use crate::storage::{Bound, Order, Range, Read, Storage, Value, When};
use serde::{de::DeserializeOwned, Serialize};

/// The families, by name, as `families.json` declares them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    Clients,
    Grants,
    Tokens,
    Requests,
    Passkeys,
    Challenges,
    Sessions,
    PersonalKeys,
    Computers,
    Lists,
    Ways,
    WayCodes,
    Tries,
    Deliveries,
    SignupNames,
    EmailIndex,
}

impl Family {

    pub(crate) fn name(self) -> &'static str {
        match self {
            Family::Clients => "clients",
            Family::Grants => "grants",
            Family::Tokens => "tokens",
            Family::Requests => "requests",
            Family::Passkeys => "passkeys",
            Family::Challenges => "challenges",
            Family::Sessions => "sessions",
            Family::PersonalKeys => "personal_keys",
            Family::Computers => "places",
            Family::Lists => "lists",
            Family::Ways => "ways",
            Family::WayCodes => "way_codes",
            Family::Tries => "tries",
            Family::Deliveries => "deliveries",
            Family::SignupNames => "signup_names",
            Family::EmailIndex => "email_index",
        }
    }
}

/// One stored row with its decoded value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row<T> {
    pub id: String,
    pub account: String,
    pub expires_at: u64,
    pub value: T,
}

/// Largest stored value, in bytes.
const MAX_VALUE: usize = 64 * 1024;

/// The sign-in rows of one storage supply opened for the `sign_in` schema.
pub(crate) struct Store<'a> {
    storage: &'a dyn Storage,
}

impl<'a> Store<'a> {
    pub(crate) fn new(storage: &'a dyn Storage) -> Self {
        Store { storage }
    }

    /// The underlying storage, for a test that reads it as it is stored.
    #[cfg(test)]
    pub(crate) fn storage(&self) -> &'a dyn Storage {
        self.storage
    }

    /// Check the exact retained source handle without opening a write or changing a row.
    pub(crate) fn assert_custody(&self) -> Result<()> {
        self.storage.custody().map_err(Into::into)
    }

    /// The live row `id`, or `None` when absent or expired.
    pub(crate) fn get<T: DeserializeOwned>(&self, family: Family, id: &str) -> Result<Option<Row<T>>> {
        Ok(self.stored(family, id)?.and_then(live))
    }

    /// The bounded stored row, including one whose expiry hides it from `get`. Lifecycle writers use it only as
    /// the expected row for a conditional replacement; an expired row must never authorize a proof or a session.
    pub(crate) fn stored<T: DeserializeOwned>(&self, family: Family, id: &str) -> Result<Option<Row<T>>> {
        let read = [Read::whole("account"), Read::whole("expires_at"), Read::at_most("value", MAX_VALUE)];
        let Some(mut row) = self.storage.get(family.name(), &[Value::from(id)], &read)? else { return Ok(None) };
        let row = decode(id.to_string(), row.take(0), row.take(1), row.take(2))?;
        Ok(Some(row))
    }

    /// Write a new row; refuses (`Error::Storage`) when `id` already exists.
    /// First deletes up to `expired_rows_per_write` (the computer's) expired rows of the same
    /// family, so expired rows do not pile up. The delete and the insert are
    /// two statements: the sign-in supply takes its lock per call, so no
    /// transaction spans them.
    pub(crate) fn insert<T: Serialize>(&self, family: Family, row: &Row<T>) -> Result<()> {
        self.prune_expired(family, computer().expired_rows_per_write, now_ms())?;
        let changed = self.storage.put(family.name(), &encode(row)?.iter().map(|(n, v)| (*n, v.clone())).collect::<Vec<_>>(), When::New)?;
        if changed == 1 { Ok(()) } else { Err(crate::cause!(Error::Storage)) }
    }

    /// Delete up to `limit` rows of `family` whose `expires_at` is past `now`
    /// (0 = never expires, so never deleted). Expired rows already read as
    /// absent; this only frees them.
    fn prune_expired(&self, family: Family, limit: usize, now: u64) -> Result<()> {
        if limit == 0 {
            return Ok(());
        }
        let read = [Read::whole("id"), Read::whole("expires_at")];
        let rows = self.storage.scan(family.name(), &Range::all(), &read)?;
        let mut expired = Vec::new();
        for mut row in rows {
            let id = match row.take(0) { Value::Text(id) => id, _ => return Err(crate::cause!(Error::Storage)) };
            let expires_at = match row.take(1) { Value::Integer(at) => u64::try_from(at).map_err(|error| crate::carry_cause!(Error::Storage, error))?, _ => return Err(crate::cause!(Error::Storage)) };
            if expires_at != 0 && expires_at <= now {
                expired.push(id);
                if expired.len() == limit { break; }
            }
        }
        for id in expired {
            self.remove(family, &id)?;
        }
        Ok(())
    }

    /// Write a row, replacing any row with the same `id`.
    pub(crate) fn put<T: Serialize>(&self, family: Family, row: &Row<T>) -> Result<()> {
        self.storage.put(family.name(), &encode(row)?.iter().map(|(n, v)| (*n, v.clone())).collect::<Vec<_>>(), When::Always)?;
        Ok(())
    }

    /// Replace `before` with `after` only if the stored row still has exactly
    /// `before`'s value (compare-and-set). Answers whether it replaced: false
    /// means another writer changed the row first.
    /// `before` and `after` may be two shapes of one row (a row moved to a new shape).
    pub(crate) fn replace_if<B: Serialize, A: Serialize>(&self, family: Family, before: &Row<B>, after: &Row<A>) -> Result<bool> {
        let expected = serde_json::to_string(&before.value).map_err(|error| crate::carry_cause!(Error::Storage, error))?;
        let row = encode(after)?;
        let row: Vec<(&str, Value)> = row.iter().map(|(n, v)| (*n, v.clone())).collect();
        let matches = [("value", Value::Text(expected))];
        Ok(self.storage.put(family.name(), &row, When::Matches(&matches))? == 1)
    }

    /// Remove row `id` if present. Returns whether a row was removed.
    pub(crate) fn remove(&self, family: Family, id: &str) -> Result<bool> {
        let exact = Range { order: Order::Key, from: Bound::Included(vec![Value::from(id)]), to: Bound::Included(vec![Value::from(id)]), reverse: false, limit: None };
        Ok(self.storage.erase(family.name(), &exact)? > 0)
    }

    /// Remove and return the live row `id` in one step (one-use codes and challenges).
    pub(crate) fn take<T: DeserializeOwned>(&self, family: Family, id: &str) -> Result<Option<Row<T>>> {
        let found = self.get(family, id)?;
        if found.is_some() && !self.remove(family, id)? {
            return Ok(None);
        }
        Ok(found)
    }

    /// The ids of every row of `account` in `family`, expired rows included, at most `limit`, in id order: what an
    /// account's erasure removes (src/account/erase.rs), a row an expiry hides from reads as much as a live one.
    pub(crate) fn ids_of(&self, family: Family, account: &str, limit: usize) -> Result<Vec<String>> {
        let read = [Read::whole("id"), Read::whole("account")];
        let rows = self.storage.scan(family.name(), &Range::all(), &read)?;
        let mut found = Vec::new();
        for mut row in rows {
            let (Value::Text(id), Value::Text(owner)) = (row.take(0), row.take(1)) else { return Err(crate::cause!(Error::Storage)) };
            if owner == account {
                found.push(id);
                if found.len() == limit { break; }
            }
        }
        Ok(found)
    }

    /// Every live row of `account` in `family`, at most `limit`.
    pub(crate) fn list<T: DeserializeOwned>(&self, family: Family, account: &str, limit: usize) -> Result<Vec<Row<T>>> {
        let read = [Read::whole("id"), Read::whole("account"), Read::whole("expires_at"), Read::at_most("value", MAX_VALUE)];
        let rows = self.storage.scan(family.name(), &Range::all(), &read)?;
        let mut found = Vec::new();
        for mut row in rows {
            let id = match row.take(0) { Value::Text(id) => id, _ => return Err(crate::cause!(Error::Storage)) };
            let decoded: Row<T> = decode(id, row.take(1), row.take(2), row.take(3))?;
            if decoded.account == account {
                if let Some(live) = live(decoded) {
                    found.push(live);
                    if found.len() == limit { break; }
                }
            }
        }
        Ok(found)
    }
}

fn encode<T: Serialize>(row: &Row<T>) -> Result<Vec<(&'static str, Value)>> {
    let value = serde_json::to_string(&row.value).map_err(|error| crate::carry_cause!(Error::Storage, error))?;
    if value.len() > MAX_VALUE { return Err(crate::cause!(Error::TooLarge)); }
    let expires = i64::try_from(row.expires_at).map_err(|error| crate::carry_cause!(Error::Storage, error))?;
    Ok(vec![
        ("id", Value::from(row.id.as_str())),
        ("account", Value::from(row.account.as_str())),
        ("expires_at", Value::Integer(expires)),
        ("value", Value::Text(value)),
    ])
}

fn decode<T: DeserializeOwned>(id: String, account: Value, expires_at: Value, value: Value) -> Result<Row<T>> {
    let (Value::Text(account), Value::Integer(expires_at), Value::Text(value)) = (account, expires_at, value) else { return Err(crate::cause!(Error::Storage)) };
    let value = serde_json::from_str(&value).map_err(|error| crate::carry_cause!(Error::Storage, error))?;
    Ok(Row { id, account, expires_at: u64::try_from(expires_at).map_err(|error| crate::carry_cause!(Error::Storage, error))?, value })
}

fn live<T>(row: Row<T>) -> Option<Row<T>> {
    (row.expires_at == 0 || row.expires_at > now_ms()).then_some(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    fn fixture() -> Memory {
        Memory::open("sign_in").expect("memory storage opens")
    }

    fn row(id: &str, expires_at: u64) -> Row<String> {
        Row { id: id.to_string(), account: "acct".to_string(), expires_at, value: "v".to_string() }
    }

    fn ids(store: &Store<'_>, family: Family) -> Vec<String> {
        let read = [Read::whole("id"), Read::whole("expires_at")];
        let mut found: Vec<String> = store.storage().scan(family.name(), &Range::all(), &read).unwrap()
            .into_iter()
            .map(|mut row| match row.take(0) { Value::Text(id) => id, _ => panic!("an id") })
            .collect();
        found.sort();
        found
    }

    #[test]
    fn the_next_write_of_a_family_deletes_its_expired_rows_and_keeps_live_ones() {
        let mem = fixture();
        let store = Store::new(&mem);
        let past = now_ms() - 1_000;
        store.put(Family::Tokens, &row("expired", past)).unwrap();
        store.put(Family::Tokens, &row("live", now_ms() + 60_000)).unwrap();
        store.put(Family::Tokens, &row("forever", 0)).unwrap();
        assert!(store.get::<String>(Family::Tokens, "expired").unwrap().is_none(), "an expired row reads as absent");

        store.insert(Family::Tokens, &row("new", now_ms() + 60_000)).unwrap();
        assert_eq!(ids(&store, Family::Tokens), vec!["forever", "live", "new"]);
    }

    #[test]
    fn a_write_deletes_only_expired_rows_of_its_own_family() {
        let mem = fixture();
        let store = Store::new(&mem);
        let past = now_ms() - 1_000;
        store.put(Family::Sessions, &row("session-expired", past)).unwrap();
        store.put(Family::Tokens, &row("token-expired", past)).unwrap();
        store.insert(Family::Tokens, &row("token-new", 0)).unwrap();
        assert_eq!(ids(&store, Family::Tokens), vec!["token-new"]);
        assert_eq!(ids(&store, Family::Sessions), vec!["session-expired"], "another family is not touched");
    }

    #[test]
    fn at_most_the_limit_of_expired_rows_go_per_write() {
        let mem = fixture();
        let store = Store::new(&mem);
        let past = now_ms() - 1_000;
        for id in ["a", "b", "c"] {
            store.put(Family::Challenges, &row(id, past)).unwrap();
        }
        store.prune_expired(Family::Challenges, 2, now_ms()).unwrap();
        assert_eq!(ids(&store, Family::Challenges).len(), 1);
        store.prune_expired(Family::Challenges, 0, now_ms()).unwrap();
        assert_eq!(ids(&store, Family::Challenges).len(), 1, "a limit of zero deletes nothing");
        store.prune_expired(Family::Challenges, 2, now_ms()).unwrap();
        assert!(ids(&store, Family::Challenges).is_empty());
    }
}
