//! The account's own sign-in words: every word its sign-in pages, its ways and its sign-in operations say, as a row in
//! the account's own lists (family `lists` of its sign-in rows, beside its settings row and its ways row), not a file.
//! It travels with the account's other sign-in rows (`computers/settings.json` `copied_families`) and the owner
//! changes it through the door (`sign-in:set-words`, scope `sign-in`) by one compare-and-set on its revision.
//!
//! The row is made with the account, from the making computer's config (`new_accounts.sign_in_words`; the synthetic
//! starting words are src/account/sign_in/new-accounts.json `sign_in_words`), and written once into an account that opens
//! without it (`StartingRows::write_missing`): at a computer from its config's `new_accounts`, in the hosting app from
//! its product settings' `new_accounts` (src/native_boot.rs `account_sign_in_rules`). The row overrides only what it sets:
//! `current` fills each block or field the row lacks from the product's words (`PRODUCT_WORDS`, read from the product
//! settings each time the starting rows are read), so a page the product adds needs no write to any account. An account without the row answers each
//! page and each worded refusal with the code `sign_in_words_missing` alone, never with words from anywhere else.
//!
//! A way's own words are found by the way's name in the account's ways row (`ways.rows`), so a way the engine has never
//! seen needs only its rows: its ways row entry and its words here. The words must name every way of the ways row
//! (`covers`); a change to either row that would leave a way without its words is refused.
//!
//! Stored value, owned by this file: `WordsRow` = `{revision, words}`, id `settings:sign-in-words:` + the account's
//! user id.

use super::pages::Words;
use super::store::{Family, Row, Store};
use super::ways::{self, WaySettings};
use super::Result;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// The start of the row's id; the account's user id follows.
pub(crate) const ROW_PREFIX: &str = "settings:sign-in-words:";
/// The refusal code of a missing row (or one that names no words for a way of the ways row).
pub(crate) const MISSING: &str = "sign_in_words_missing";

/// The account's words and the revision that orders their changes: what `read` and `current` answer, every part filled.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WordsRow {
    pub revision: u64,
    pub words: Words,
    /// Fields a newer release wrote, kept as they were so a rewrite by this release loses none of them.
    #[serde(flatten)]
    pub unknown_keys: crate::account::computers::UnknownKeys,
}

/// The stored row: the revision and the words as they differ from the product's words (`differing`). A part the row
/// lacks is the product's; a part it holds, even null, is the account's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredRow {
    revision: u64,
    words: serde_json::Value,
    /// Fields a newer release wrote, kept as they were (see `WordsRow`).
    #[serde(flatten)]
    unknown_keys: crate::account::computers::UnknownKeys,
}

/// Why a change is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// The words leave a way of the account's ways row without its words.
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


impl Words {
    /// Whether these words name every way of `ways`, each kind of name it asks, and every field its pages ask.
    pub fn covers(&self, ways: &WaySettings) -> bool {
        ways.rows.iter().all(|row| {
            self.ways.rows.contains_key(&row.way)
                && row.named.as_ref().is_none_or(|kind| self.ways.fields.contains_key(kind) && self.ways.names_refused.contains_key(kind))
                && self.ways.fields.contains_key(row.proof.field())
        })
    }
}

pub(crate) fn row_id(account: &str) -> String {
    format!("{ROW_PREFIX}{account}")
}

/// The account's stored row, when it has one.
fn read_stored(store: &Store<'_>, account: &str) -> Result<Option<Row<StoredRow>>> {
    Ok(store.get::<StoredRow>(Family::Lists, &row_id(account))?.filter(|row| row.account == account))
}

/// The account's row, when it has one: its words filled from the product's words. A row that still holds the message the
/// seed wrote before (`previous_code_sent` in shape-defaults.json) reads as the shipped message; nothing is written.
pub(crate) fn read(store: &Store<'_>, account: &str) -> Result<Option<Row<WordsRow>>> {
    let Some(row) = read_stored(store, account)? else { return Ok(None) };
    let mut words = full(&row.value.words)?;
    if words.ways.code_sent == ways::shape_defaults().previous_code_sent {
        words.ways.code_sent = super::shipped().sign_in_words.ways.code_sent.clone();
    }
    Ok(Some(Row { id: row.id, account: row.account, expires_at: row.expires_at, value: WordsRow { revision: row.value.revision, words, unknown_keys: row.value.unknown_keys.clone() } }))
}

/// The product's words (`new_accounts.sign_in_words`, the starting words the hosting app or a computer writes once): what
/// `current` fills in for each block or field an account's row lacks. Set when the starting rows are read (the first set
/// wins; one product per process).
static PRODUCT_WORDS: OnceLock<Words> = OnceLock::new();

pub(crate) fn set_product_words(words: &Words) {
    let _ = PRODUCT_WORDS.set(words.clone());
}

/// `row` with each part it lacks (absent) filled from `product`, recursively: the row overrides only what it holds.
fn filled(row: serde_json::Value, product: &serde_json::Value) -> serde_json::Value {
    match (row, product) {
        (serde_json::Value::Object(mut row), serde_json::Value::Object(product)) => {
            for (key, value) in product {
                match row.remove(key) {
                    Some(kept) => {
                        row.insert(key.clone(), filled(kept, value));
                    }
                    None => {
                        row.insert(key.clone(), value.clone());
                    }
                }
            }
            serde_json::Value::Object(row)
        }
        (row, _) => row,
    }
}

/// `own` without each part equal to the product's (None when all of it is): what a save stores.
fn differing(own: serde_json::Value, product: &serde_json::Value) -> Option<serde_json::Value> {
    if &own == product {
        return None;
    }
    match (own, product) {
        (serde_json::Value::Object(own), serde_json::Value::Object(product)) => Some(serde_json::Value::Object(
            own.into_iter()
                .filter_map(|(key, value)| match product.get(&key) {
                    Some(part) => differing(value, part).map(|kept| (key, kept)),
                    None => Some((key, value)),
                })
                .collect(),
        )),
        (own, _) => Some(own),
    }
}

fn value_of(words: &Words) -> Result<serde_json::Value> {
    serde_json::to_value(words).map_err(|error| crate::carry_cause!(super::Error::Storage, error))
}

/// The stored words filled from the product's words: what the account holds, and the product's for the rest.
fn full(stored: &serde_json::Value) -> Result<Words> {
    let whole = match PRODUCT_WORDS.get() {
        Some(product) => filled(stored.clone(), &value_of(product)?),
        None => stored.clone(),
    };
    serde_json::from_value(whole).map_err(|error| crate::carry_cause!(super::Error::Storage, error))
}

/// The account's words now, when it has a row.
pub(crate) fn current(store: &Store<'_>, account: &str) -> Result<Option<Words>> {
    Ok(read(store, account)?.map(|row| row.value.words))
}

/// Replace the account's words with `words` when the row's revision is still `expected_revision` (0: no row yet). With
/// `ways` (the account's ways row, when it has one), words that leave one of its ways without words are refused.
pub(crate) fn set(store: &Store<'_>, account: &str, expected_revision: u64, words: Words, ways: Option<&WaySettings>)
    -> std::result::Result<WordsRow, Refused> {
    if ways.is_some_and(|ways| !words.covers(ways)) || expected_revision >= 1 << 53 {
        return Err(crate::cause!(Refused::Invalid));
    }
    let before = read_stored(store, account).map_err(|error| Refused::Storage(error.cause()))?;
    let current = before.as_ref().map_or(0, |row| row.value.revision);
    if current != expected_revision {
        return Err(crate::cause!(Refused::Stale));
    }
    let own = serde_json::to_value(&words).map_err(|error| crate::carry_cause!(Refused::Invalid, error))?;
    let stored = match PRODUCT_WORDS.get() {
        Some(product) => {
            let product = serde_json::to_value(product).map_err(|error| crate::carry_cause!(Refused::Storage, error))?;
            differing(own, &product).unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
        }
        None => own,
    };
    let unknown_keys = before.as_ref().map(|row| row.value.unknown_keys.clone()).unwrap_or_default();
    let after = Row { id: row_id(account), account: account.to_string(), expires_at: 0, value: StoredRow { revision: current + 1, words: stored, unknown_keys: unknown_keys.clone() } };
    match before {
        None => store.insert(Family::Lists, &after).map_err(|error| Refused::Stale(error.cause()))?,
        Some(prior) => {
            if !store.replace_if(Family::Lists, &prior, &after).map_err(|error| Refused::Storage(error.cause()))? {
                return Err(crate::cause!(Refused::Stale));
            }
        }
    }
    Ok(WordsRow { revision: current + 1, words, unknown_keys })
}

/// The words the tests give an account: the synthetic starting rows src/account/sign_in/new-accounts.json `sign_in_words`.
#[cfg(test)]
pub(crate) fn for_tests() -> Words {
    super::StartingRows::for_tests().sign_in_words
}

#[cfg(test)]
#[path = "words_row_tests.rs"]
mod tests;
