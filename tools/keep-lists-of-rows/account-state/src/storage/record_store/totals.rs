// src/storage/record_store/totals.rs
//
// Purpose: Declared totals of the record store. A record kind can declare, as DATA (`settings.json` `totals`), a running
// count of its live records and a running sum of one integer field, per group (the text of one field, or one group
// for the whole kind). The store keeps one `totals` row per account, total and group, changed in the same write as
// the record, so reading every total of an account is one range scan, whatever the number of records.
//
// Non-Negotiable Invariants:
// - A total row equals the live records of its kind in the account: every write adds its record's contribution after
//   and removes its contribution before (a create +1, a delete or erase -1, an update moves the sum and, when the
//   group changes, moves the count between groups), inside the write's own scope.
// - A total counts the records written while it is declared. A total declared after records of its kind exist is
//   filled (`RecordStore::fill_total`, run by the account's idle upkeep): its rows leave, then the account's records
//   are walked a bounded step at a time, a live write meanwhile counting only the records the walk has passed; until
//   the fill completes under the total's current declaration, `total_known` answers false, so a reader never takes an
//   undercount for the count (old trillion record-log-store.mjs: "an old projection never guesses its count").
// - A sum field that holds something other than an integer, null or nothing is a refused write.
//
// Key Concepts:
// - `Declared`: `{ total, kind, group?, sum? }`. `group` and `sum` are paths of object keys from the record value.
// - Totals are account-wide: one total adds up a kind across every resource scope of the account (an account's files keeps
//   its names in one scope per folder and still reads their count in one row).
// - `contribution`: what one record value adds to one total: its group and its sum.
//
// Security Considerations:
// - A total row holds a group text, a count and a sum; erase moves the count and sum with the record.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::records::Error;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One declared total, as DATA.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Declared {
    #[serde(rename = "_why")]
    pub why: String,
    /// The total's name, as readers find it in `RecordStore::totals`.
    pub total: String,
    /// The record kind (the value's `kind_field`) the total adds up.
    pub kind: String,
    /// The field whose text names a record's group; empty: one group for the whole kind.
    #[serde(default)]
    pub group: Vec<String>,
    /// The integer field summed per group; empty: the total only counts.
    #[serde(default)]
    pub sum: Vec<String>,
}
impl Declared {
    pub fn valid(&self) -> bool {
        !self.total.is_empty()
            && !self.total.contains('\0')
            && !self.kind.is_empty()
            && self.group.iter().chain(&self.sum).all(|step| !step.is_empty())
    }
}

/// One total row of an account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Total {
    pub total: String,
    /// The group's text; none for a total without a group.
    pub group: Option<String>,
    pub count: i64,
    pub sum: i64,
}

/// What a total's rows depend on (old trillion record-log-store.mjs: counts rebuilt when what they count changes): its
/// kind, group and sum. A changed signature under the same name fills the total again.
pub fn signature_of(declared: &Declared) -> String {
    serde_json::json!({ "kind": declared.kind, "group": declared.group, "sum": declared.sum }).to_string()
}

fn at<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |at, key| at.get(key))
}

/// What one record value of kind `kind` adds to `declared`: its group text (empty for no group) and its sum; none when
/// the total does not cover the kind.
pub fn contribution(declared: &Declared, kind: Option<&str>, value: &Value) -> Result<Option<(String, i64)>, Error> {
    if kind != Some(declared.kind.as_str()) {
        return Ok(None);
    }
    let group = if declared.group.is_empty() {
        String::new()
    } else {
        match at(value, &declared.group) {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => text.clone(),
            Some(other) => other.to_string(),
        }
    };
    let sum = if declared.sum.is_empty() {
        0
    } else {
        match at(value, &declared.sum) {
            None | Some(Value::Null) => 0,
            Some(number) => number.as_i64().ok_or(Error::Invalid("a declared total's sum field is not an integer", crate::cause!()))?,
        }
    };
    Ok(Some((group, sum)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn declared(group: &[&str], sum: &[&str]) -> Declared {
        Declared {
            why: "test".into(),
            total: "file/origin".into(),
            kind: "file".into(),
            group: group.iter().map(|step| step.to_string()).collect(),
            sum: sum.iter().map(|step| step.to_string()).collect(),
        }
    }

    #[test]
    fn a_covered_record_adds_its_group_and_sum() {
        let total = declared(&["origin"], &["byte_length"]);
        let value = json!({ "kind": "file", "origin": "b2", "byte_length": 7 });
        assert_eq!(contribution(&total, Some("file"), &value).unwrap(), Some(("b2".into(), 7)));
        assert_eq!(contribution(&total, Some("name"), &value).unwrap(), None);
        assert_eq!(contribution(&declared(&[], &[]), Some("file"), &value).unwrap(), Some((String::new(), 0)));
    }

    #[test]
    fn a_sum_that_is_not_an_integer_refuses_the_write() {
        let total = declared(&[], &["byte_length"]);
        assert!(contribution(&total, Some("file"), &json!({ "byte_length": "7" })).is_err());
        assert_eq!(contribution(&total, Some("file"), &json!({ "byte_length": null })).unwrap(), Some((String::new(), 0)));
    }
}
