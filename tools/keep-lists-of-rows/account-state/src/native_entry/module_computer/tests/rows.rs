// src/native_entry/module_computer/tests/rows.rs
//
// Purpose: the module computer's own rules on any computer: the account's row is one compare-and-set on its revision,
// routes name an account or nothing, and its report and words load. (An integration test, so the library is built
// without trillion-local's own unit tests, which need the whole program.)
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::json;
use std::collections::BTreeMap;
use trillion_module_computer::{edit_allowed, report, route, settings, word, Placement, PlacementEdit};
fn row(revision: u64, writer: &str, copy_keepers: &[&str]) -> Placement {
    let mut computers = BTreeMap::new();
    for computer in std::iter::once(&writer).chain(copy_keepers) {
        computers.insert(computer.to_string(), format!("https://{computer}"));
    }
    Placement { revision, writer: writer.into(), copy_keepers: copy_keepers.iter().map(|one| one.to_string()).collect(), computers }
}

#[test]
fn a_row_edit_is_one_compare_and_set_on_its_revision() {
    let first = PlacementEdit { expected_revision: 0, row: row(1, "local", &["module"]) };
    assert!(edit_allowed(None, &first));
    let moved = PlacementEdit { expected_revision: 1, row: row(2, "module", &["local"]) };
    assert!(edit_allowed(Some(&first.row), &moved));
    // A stale edit, a skipped revision and a writer that is also a copy keeper are refused.
    assert!(!edit_allowed(Some(&moved.row), &PlacementEdit { expected_revision: 1, row: row(2, "local", &[]) }));
    assert!(!edit_allowed(Some(&first.row), &PlacementEdit { expected_revision: 1, row: row(3, "module", &[]) }));
    assert!(!edit_allowed(None, &PlacementEdit { expected_revision: 0, row: row(1, "a", &["a"]) }));
}

#[test]
fn routes_name_an_account_or_nothing() {
    assert_eq!(route("/a/abc/records/own-records/x"), Some(("abc", vec!["records", "own-records", "x"])));
    assert_eq!(route("/records"), None);
    assert_eq!(route("/a/../x"), None);
    assert!(report("https://computer", Some(true))["takes_new_accounts"] == json!(false));
    assert!(settings().follow_page > 0 && !word("not_writer").is_empty());
}
