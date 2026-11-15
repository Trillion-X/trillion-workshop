//! The account's limits row: the limits its plans and contracts give, by source, as a row of the account's own lists
//! (family `lists` of its account rows, `rows/families.json`). It travels to every computer that may answer the
//! account like its settings row, and it is changed through the door (`sign-in:set-limits`, scope `sign-in`) by one
//! compare-and-set on its revision; `sign-in:limits` reads it with the number each limit comes to now.
//!
//! Ported from old trillion src/payment.mjs:368-408, the payment fold that made `account_policy.access`: for each
//! active offer it put the offer's `allowances` rows (less their `access`) under `access.limits[name]`, and for each
//! active contract snapshot its `limits` rows (less their `key`). Here each source (`plan:<offer>` or
//! `contract:<key>`) keeps its own rows, written or ended on its own, and the access the engine reads
//! (`with_row`) is the account's `account_policy.access` with every source's rows added under the same names. The
//! number a limit comes to is unchanged: the most generous row wins over the shipped rows
//! (src/contract-entitlements.mjs `quantityFor`, `computers::access_limit`). Dropped: the fold's payment provider
//! (Stripe) reads and its server-side run, which are the old app's; whoever holds the account's `sign-in` scope
//! writes a source here.
//!
//! Stored value, owned by this file: `LimitsRow` = `{revision, sources: {source: {name: [row, ...]}}}`, id
//! `limits.row_prefix` + the account's user id.

use super::settings;
use crate::account::rows::store::{Family, Row, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// The rows one source gives, by limit name.
pub(crate) type SourceLimits = BTreeMap<String, Vec<Value>>;

/// The stored row: every source's rows and the revision that orders their changes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LimitsRow {
    pub revision: u64,
    pub sources: BTreeMap<String, SourceLimits>,
    /// Fields a newer release wrote, kept as they were so a rewrite by this release loses none of them.
    #[serde(flatten)]
    pub unknown_keys: crate::account::computers::UnknownKeys,
}

/// The bounds of the limits row (`computers/settings.json` `limits.row`).
#[derive(Debug, Deserialize)]
pub(crate) struct RowSettings {
    /// The start of the row's id; the account's user id follows.
    pub prefix: String,
    /// What a source's name starts with: one per kind of source (a plan's offer, a contract).
    pub source_kinds: Vec<String>,
    pub most_sources: usize,
    pub most_names: usize,
    pub most_rows: usize,
    pub name_bytes: usize,
    /// The most bytes one row's JSON text holds.
    pub row_bytes: usize,
}

/// Why a change is not kept.
#[derive(Clone, Debug, Eq)]
pub(crate) enum Refused {
    /// The source or its rows are not a plan's or contract's limits.
    Invalid(crate::refusal_cause::Cause),
    /// The row moved on since the revision the caller read.
    Stale(crate::refusal_cause::Cause),
    /// The sign-in storage did not answer.
    Storage(crate::refusal_cause::Cause),
}

impl Refused {
    /// The content-free source condition; retained separately from public class equality.
    pub fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Invalid(cause) => cause.clone(),
            Self::Stale(cause) => cause.clone(),
            Self::Storage(cause) => cause.clone(),
        }
    }
}
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
    format!("{}{account}", settings().limits.row.prefix)
}

/// The account's row, when it has one.
pub(crate) fn read(store: &Store<'_>, account: &str) -> Result<Option<Row<LimitsRow>>, Refused> {
    Ok(store
        .get::<LimitsRow>(Family::Lists, &row_id(account))
        .map_err(|error| Refused::Storage(error.cause()))?
        .filter(|row| row.account == account))
}

/// A name: plain text of at most `name_bytes`, no control characters.
fn plain(text: &str, bytes: usize) -> bool {
    !text.is_empty() && text.len() <= bytes && !text.chars().any(char::is_control)
}

/// Whether `source` names a source of a known kind and `limits` are rows a plan or contract gives: each row an object
/// within `row_bytes` that grants a number (`computers::row_quantity`), within the counts the settings allow.
fn valid(source: &str, limits: &SourceLimits) -> bool {
    let bounds = &settings().limits.row;
    let kind_ok = bounds.source_kinds.iter().any(|kind| source.strip_prefix(kind.as_str()).is_some_and(|rest| plain(rest, bounds.name_bytes)));
    kind_ok
        && !limits.is_empty()
        && limits.len() <= bounds.most_names
        && limits.iter().all(|(name, rows)| {
            plain(name, bounds.name_bytes)
                && !rows.is_empty()
                && rows.len() <= bounds.most_rows
                && rows.iter().all(|row| {
                    row.is_object()
                        && super::row_quantity(row).is_some_and(|n| n < 1 << 53)
                        && serde_json::to_vec(row).is_ok_and(|text| text.len() <= bounds.row_bytes)
                })
        })
}

/// Write the rows `source` gives (`Some`), or end that source (`None`), when the row's revision is still
/// `expected_revision` (0: no row yet). One compare-and-set on the stored value, so a second editor refuses. The new
/// revision is one more; ending a source the row does not hold changes nothing and is answered with the row as it is.
pub(crate) fn set(store: &Store<'_>, account: &str, expected_revision: u64, source: &str, limits: Option<SourceLimits>)
    -> Result<LimitsRow, Refused> {
    let bounds = &settings().limits.row;
    if expected_revision >= 1 << 53 || limits.as_ref().is_some_and(|limits| !valid(source, limits)) {
        return Err(crate::cause!(Refused::Invalid));
    }
    let before = read(store, account)?;
    let current = before.as_ref().map(|row| row.value.clone()).unwrap_or_default();
    if current.revision != expected_revision {
        return Err(crate::cause!(Refused::Stale));
    }
    let mut value = current.clone();
    match limits {
        Some(limits) => {
            value.sources.insert(source.to_string(), limits);
        }
        None => {
            if value.sources.remove(source).is_none() {
                return Ok(current);
            }
        }
    }
    if value.sources.len() > bounds.most_sources {
        return Err(crate::cause!(Refused::Invalid));
    }
    value.revision = current.revision + 1;
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

/// The access the engine reads limits from: `access` (the account's `account_policy.access`) with every source's rows
/// of `row` added under their names, the way the old fold put each offer's and contract's rows side by side.
pub(crate) fn with_row(access: Value, row: Option<&LimitsRow>) -> Value {
    let Some(row) = row.filter(|row| !row.sources.is_empty()) else { return access };
    let mut access = if access.is_object() { access } else { Value::Object(Default::default()) };
    if !access.get("limits").is_some_and(Value::is_object) {
        access["limits"] = Value::Object(Default::default());
    }
    let limits = access["limits"].as_object_mut().expect("limits was just made an object");
    for rows in row.sources.values() {
        for (name, given) in rows {
            let entry = limits.entry(name.clone()).or_insert_with(|| Value::Array(Vec::new()));
            if !entry.is_array() {
                *entry = Value::Array(Vec::new());
            }
            entry.as_array_mut().expect("an array").extend(given.iter().cloned());
        }
    }
    access
}

/// The number each limit named in `access` or in the shipped rows comes to now (`computers::access_limit`).
pub(crate) fn numbers(access: &Value) -> BTreeMap<String, usize> {
    let mut names: Vec<String> = settings().limits.shipped.keys().cloned().collect();
    if let Some(granted) = access.get("limits").and_then(Value::as_object) {
        names.extend(granted.keys().cloned());
    }
    names.into_iter().map(|name| {
        let number = super::access_limit(access, &name);
        (name, number)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;
    use serde_json::json;

    fn rows(value: Value) -> SourceLimits {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_contract_raises_the_computers_limit_and_ending_it_lowers_it_again() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        assert!(read(&store, "ada").unwrap().is_none());
        assert_eq!(super::super::computers_limit(&with_row(Value::Null, None)), 16, "no row: the shipped number");
        let first = set(&store, "ada", 0, "contract:acme-2026", Some(rows(json!({"access:places": [{"quantity": 40}]})))).unwrap();
        assert_eq!(first.revision, 1);
        let access = with_row(json!({"capabilities": [], "limits": {}}), Some(&first));
        assert_eq!(super::super::computers_limit(&access), 40);
        assert_eq!(numbers(&access)["access:places"], 40);
        assert_eq!(numbers(&access)["access:place-accounts"], 256, "a name no source gives stays shipped");
        let plan = set(&store, "ada", 1, "plan:team", Some(rows(json!({"access:places": [{"count": 24, "per": "month"}]})))).unwrap();
        assert_eq!(super::super::computers_limit(&with_row(Value::Null, Some(&plan))), 40, "the most generous row wins");
        let ended = set(&store, "ada", 2, "contract:acme-2026", None).unwrap();
        assert_eq!(ended.revision, 3);
        assert_eq!(super::super::computers_limit(&with_row(Value::Null, Some(&ended))), 24);
        let again = set(&store, "ada", 3, "contract:acme-2026", None).unwrap();
        assert_eq!(again.revision, 3, "ending a source the row does not hold changes nothing");
        assert_eq!(read(&store, "ada").unwrap().unwrap().value, ended, "the row is kept");
    }

    #[test]
    fn a_policy_row_and_a_source_row_of_one_name_both_count() {
        let policy = json!({"limits": {"access:places": [{"quantity": 30}]}});
        let row = LimitsRow { revision: 1, sources: BTreeMap::from([("plan:a".into(), rows(json!({"access:places": [{"quantity": 20}]})))]), unknown_keys: Default::default() };
        let access = with_row(policy, Some(&row));
        assert_eq!(access["limits"]["access:places"].as_array().unwrap().len(), 2);
        assert_eq!(super::super::computers_limit(&access), 30);
    }

    #[test]
    fn a_stale_revision_and_rows_that_grant_nothing_are_refused() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        let good = || Some(rows(json!({"access:places": [{"quantity": 20}]})));
        assert_eq!(set(&store, "ada", 1, "plan:a", good()), Err(crate::cause!(Refused::Stale)), "no row yet is revision 0");
        assert_eq!(set(&store, "ada", 0, "gift:a", good()), Err(crate::cause!(Refused::Invalid)), "an unknown kind of source");
        assert_eq!(set(&store, "ada", 0, "plan:", good()), Err(crate::cause!(Refused::Invalid)), "a source with no name");
        assert_eq!(set(&store, "ada", 0, "plan:a", Some(rows(json!({"access:places": [{"per": "month"}]})))), Err(crate::cause!(Refused::Invalid)));
        assert_eq!(set(&store, "ada", 0, "plan:a", Some(rows(json!({"access:places": [{"quantity": 0}]})))), Err(crate::cause!(Refused::Invalid)));
        assert_eq!(set(&store, "ada", 0, "plan:a", Some(rows(json!({"access:places": []})))), Err(crate::cause!(Refused::Invalid)));
        assert_eq!(set(&store, "ada", 0, "plan:a", Some(rows(json!({})))), Err(crate::cause!(Refused::Invalid)));
        assert!(read(&store, "ada").unwrap().is_none(), "nothing refused was kept");
        set(&store, "ada", 0, "plan:a", good()).unwrap();
        assert_eq!(set(&store, "ada", 0, "plan:b", good()), Err(crate::cause!(Refused::Stale)), "a second first row is refused");
        assert!(read(&store, "bob").unwrap().is_none(), "another account's row is not this one");
    }

    #[test]
    fn no_more_sources_than_the_settings_allow() {
        let mem = Memory::open("sign_in").unwrap();
        let store = Store::new(&mem);
        let most = settings().limits.row.most_sources;
        for n in 0..most {
            set(&store, "ada", n as u64, &format!("plan:{n}"), Some(rows(json!({"access:places": [{"quantity": 20}]})))).unwrap();
        }
        assert_eq!(set(&store, "ada", most as u64, "plan:one-more", Some(rows(json!({"access:places": [{"quantity": 20}]})))), Err(crate::cause!(Refused::Invalid)));
    }
}

crate::impl_caused!(Refused);
