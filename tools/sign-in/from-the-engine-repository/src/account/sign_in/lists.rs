//! The account's own sign-in settings: a row in the account's own lists (family `lists` of its sign-in rows,
//! `families.json`), not a file. It is the account's data like its keys and its computers row: it travels to every computer
//! that may answer the account (`computers/settings.json` `copied_families`), and the owner changes it through the door
//! (`sign-in:set-settings`, scope `sign-in`) by one compare-and-set on its revision.
//!
//! The row is made with the account, from the starting values of the computer that makes it (the computer config's
//! `new_accounts`). Nothing fills it in later: an account without it is refused (`Error::SettingsMissing`, code
//! `sign_in_settings_missing`) whenever a number is needed (a new token, code, request, session or challenge), while
//! the credentials it already holds keep their stored expiry and still admit.
//!
//! Stored value, owned by this file: `SettingsRow` = `{revision, settings}`, id `settings:sign-in:` + the account's
//! user id.

use super::store::{Family, Row, Store};
use super::{Error, Result};
use serde::{Deserialize, Serialize};

/// The start of the row's id; the account's user id follows.
pub(crate) const ROW_PREFIX: &str = "settings:sign-in:";
/// The refusal code of a missing row, at the door and on the sign-in routes.
pub(crate) const MISSING: &str = "sign_in_settings_missing";
/// The longest any lifetime may be, in seconds (400 days).
const MOST_SECONDS: u64 = 400 * 24 * 3600;

/// The account's sign-in numbers. Lifetimes are seconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountSettings {
    pub access_token_seconds: u64,
    pub refresh_token_seconds: u64,
    /// An OAuth authorization code.
    pub code_seconds: u64,
    /// A pending authorization request (the consent page).
    pub request_seconds: u64,
    /// A passkey challenge and a passkey link.
    pub challenge_seconds: u64,
    /// A browser session, sliding.
    pub session_seconds: u64,
    /// The idle-day limit per approval (`most_days`, `idle_days_by_approval`), in the shape
    /// `SignInRules::from_source_json` reads. Read when the account opens.
    pub idle_days: serde_json::Value,
}

impl AccountSettings {
    /// Whether every number is in range: a lifetime is at least one second and at most `MOST_SECONDS`, a refresh token
    /// outlives its access token, and the idle days read as rules.
    pub fn valid(&self) -> bool {
        let lifetimes = [
            self.access_token_seconds, self.refresh_token_seconds, self.code_seconds,
            self.request_seconds, self.challenge_seconds, self.session_seconds,
        ];
        lifetimes.iter().all(|seconds| (1..=MOST_SECONDS).contains(seconds))
            && self.refresh_token_seconds >= self.access_token_seconds
            && crate::account::SignInRules::from_source_json(&self.idle_days).is_ok()
    }
}

/// The stored row: the settings and the revision that orders their changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SettingsRow {
    pub revision: u64,
    pub settings: AccountSettings,
    /// Fields a newer release wrote, kept as they were so a rewrite by this release loses none of them.
    #[serde(flatten)]
    pub unknown_keys: crate::account::computers::UnknownKeys,
}

/// Why a change is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// The settings are out of range.
    Invalid(crate::refusal_cause::Cause),
    /// The row moved on since the revision the caller read.
    Stale(crate::refusal_cause::Cause),
    /// The sign-in storage did not answer.
    Storage(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub(crate) fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Stale(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
crate::impl_caused!(Refused);

impl PartialEq for Refused {
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

/// The account's row, when it has one.
pub(crate) fn read(store: &Store<'_>, account: &str) -> Result<Option<Row<SettingsRow>>> {
    Ok(store.get::<SettingsRow>(Family::Lists, &row_id(account))?.filter(|row| row.account == account))
}

/// The account's settings now; `Error::SettingsMissing` when it has no row.
pub(crate) fn current(store: &Store<'_>, account: &str) -> Result<AccountSettings> {
    read(store, account)?.map(|row| row.value.settings).ok_or(crate::cause!(Error::SettingsMissing))
}

/// Replace the account's settings with `settings` when the row's revision is still `expected_revision` (0: no row
/// yet). One compare-and-set on the stored value, so a second editor refuses. The new revision is one more.
pub(crate) fn set(store: &Store<'_>, account: &str, expected_revision: u64, settings: AccountSettings)
    -> std::result::Result<SettingsRow, Refused> {
    if !settings.valid() || expected_revision >= 1 << 53 {
        return Err(crate::cause!(Refused::Invalid));
    }
    let before = read(store, account).map_err(|error| Refused::Storage(error.cause()))?;
    let current = before.as_ref().map_or(0, |row| row.value.revision);
    if current != expected_revision {
        return Err(crate::cause!(Refused::Stale));
    }
    let unknown_keys = before.as_ref().map(|row| row.value.unknown_keys.clone()).unwrap_or_default();
    let value = SettingsRow { revision: current + 1, settings, unknown_keys };
    let after = Row { id: row_id(account), account: account.to_string(), expires_at: 0, value: value.clone() };
    match before {
        None => store.insert(Family::Lists, &after).map_err(|error| Refused::Stale(error.cause()))?,
        Some(prior) => {
            if !store.replace_if(Family::Lists, &prior, &after).map_err(|error| Refused::Storage(error.cause()))? {
                return Err(crate::cause!(Refused::Stale));
            }
        }
    }
    Ok(value)
}

/// The settings the tests give an account (the same numbers the test computers' configs give).
#[doc(hidden)]
pub fn for_tests() -> AccountSettings {
    AccountSettings {
        access_token_seconds: 3600,
        refresh_token_seconds: 2_592_000,
        code_seconds: 300,
        request_seconds: 900,
        challenge_seconds: 300,
        session_seconds: 2_592_000,
        idle_days: serde_json::json!({"most_days": 90, "idle_days_by_approval": {"passkey": 90, "key": 90, "unknown": 30}}),
    }
}

/// The accounts the sign-in's own tests name.
#[cfg(test)]
const TEST_ACCOUNTS: [&str; 6] = ["owner", "person", "ada", "bea", "acct", "someone-else"];

/// For tests: give each of `accounts` the test settings row (and, in the crate's own tests, the test words row) in
/// `storage`, as account creation does.
#[doc(hidden)]
pub(crate) fn prefill(storage: &dyn crate::storage::Storage, accounts: &[&str]) {
    for account in accounts {
        if read(&Store::new(storage), account).expect("the test store answers").is_none() {
            set(&Store::new(storage), account, 0, for_tests()).expect("the test settings row is kept");
        }
        #[cfg(test)]
        if super::words_row::read(&Store::new(storage), account).expect("the test store answers").is_none() {
            super::words_row::set(&Store::new(storage), account, 0, super::words_row::for_tests(), None).expect("the test words row is kept");
        }
    }
}

/// A sign-in store in memory whose test accounts (`TEST_ACCOUNTS`) have their settings row.
#[cfg(test)]
pub(crate) fn test_memory() -> crate::storage::memory::Memory {
    let memory = crate::storage::memory::Memory::open("sign_in").expect("the sign_in schema opens");
    prefill(&memory, &TEST_ACCOUNTS);
    memory
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    #[test]
    fn a_missing_row_is_refused_and_never_filled_in() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        assert_eq!(current(&store, "ada"), Err(crate::cause!(Error::SettingsMissing)));
        assert!(read(&store, "ada").unwrap().is_none(), "reading wrote nothing");
    }

    #[test]
    fn the_row_changes_only_from_the_revision_read() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        let first = set(&store, "ada", 0, for_tests()).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(set(&store, "ada", 0, for_tests()), Err(crate::cause!(Refused::Stale)), "a second first row is refused");
        let mut shorter = for_tests();
        shorter.access_token_seconds = 60;
        assert_eq!(set(&store, "ada", 1, shorter.clone()).unwrap().revision, 2);
        assert_eq!(current(&store, "ada").unwrap(), shorter);
        assert_eq!(set(&store, "ada", 1, for_tests()), Err(crate::cause!(Refused::Stale)), "a stale revision is refused");
        assert_eq!(current(&store, "bob"), Err(crate::cause!(Error::SettingsMissing)), "another account's row is not this one");
    }

    #[test]
    fn numbers_out_of_range_are_refused() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        let mut zero = for_tests();
        zero.code_seconds = 0;
        assert_eq!(set(&store, "ada", 0, zero), Err(crate::cause!(Refused::Invalid)));
        let mut backwards = for_tests();
        backwards.refresh_token_seconds = 10;
        assert_eq!(set(&store, "ada", 0, backwards), Err(crate::cause!(Refused::Invalid)));
        let mut no_rules = for_tests();
        no_rules.idle_days = serde_json::json!({"most_days": 90});
        assert_eq!(set(&store, "ada", 0, no_rules), Err(crate::cause!(Refused::Invalid)));
        assert!(read(&store, "ada").unwrap().is_none());
    }
}
