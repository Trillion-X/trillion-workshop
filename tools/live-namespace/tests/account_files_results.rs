// tests/account_files_results.rs
//
// Purpose: What was worked out about a file, kept under its content identity and kind and found by any of its
// identities: the port of old trillion's results module's behaviour (ports/account-files-results.json: put, read,
// fields, list by kind, many at once, counts, merge, remove and the per-caller read bound) over the account files in
// memory. Synthetic data only.

mod account_files_common;

use account_files_common::*;
use serde_json::{json, Value};
use trillion_local::{
    account_files::{AccountFilesError, ALIASES},
    records::{Mutation, Records},
};

fn alias_of(files: &mut trillion_local::account_files::AccountFiles<trillion_local::storage::memory::Memory>, file: &str) -> String {
    use trillion_local::account_files::FILES;
    let alias = format!("12:{}", "e".repeat(64));
    files.store.mutate(ACCOUNT, ALIASES, Mutation { id: alias.clone(), expected_version: 0, request_key: "alias".into(), deleted: false,
        value: json!({"kind": trillion_local::account_files::ALIAS_KIND, "identity": file, "grade": "checked"}) }).unwrap();
    let record = files.store.get(ACCOUNT, FILES, file).unwrap().record.unwrap();
    let mut value = record.value.clone();
    value["aliases"] = json!([{"alias": alias, "grade": "checked"}]);
    files.store.mutate(ACCOUNT, FILES, Mutation { id: file.into(), expected_version: record.version, request_key: "aliases".into(), deleted: false, value }).unwrap();
    alias
}

#[test]
fn a_result_is_kept_once_and_found_by_any_identity_of_its_file() {
    let (mut files, _, _) = account_files();
    let file = write(&mut files, "/talk.m4a", b"a recording");
    let alias = alias_of(&mut files, &file);
    let put = call(&mut files, "record_file_results", json!({"results": [
        {"identity": alias, "kind": "transcript", "value": {"text": "hello"}, "produced_by": "a transcriber"},
        {"identity": file, "kind": "summary", "value": "a greeting"},
    ]})).unwrap();
    assert_eq!(put, json!({"recorded": 2, "unchanged": 0, "refused": []}));
    let again = call(&mut files, "record_file_results", json!({"results": [{"identity": alias, "kind": "transcript", "value": {"text": "hello"}}]})).unwrap();
    assert_eq!(again["unchanged"], 1, "the same value again changes nothing");
    let read = call(&mut files, "read_file_results", json!({"identity": file})).unwrap();
    assert_eq!(read["identities"], json!([file, alias]));
    let kinds: Vec<&str> = read["results"].as_array().unwrap().iter().map(|row| row["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, vec!["summary", "transcript"]);
    assert_eq!(read["results"][1]["identity"], json!(alias), "kept under the identity it was recorded under");
    assert_eq!(read["results"][1]["produced_by"], "a transcriber");
    let one = call(&mut files, "read_file_results", json!({"identity": alias, "kind": "summary"})).unwrap();
    assert_eq!(one["results"][0]["value"], "a greeting");
    let fields = call(&mut files, "read_file_result_fields", json!({"identity": file, "kind": "transcript", "fields": ["text", "words"]})).unwrap();
    assert_eq!(fields, json!({"text": "hello", "words": null}));
    let many = call(&mut files, "read_file_results_many", json!({"kind": "summary", "identities": [alias, format!("1f:{}", "0".repeat(64)), "not one"]})).unwrap();
    assert_eq!(many["results"], json!({ alias.clone(): "a greeting" }));
    assert_eq!(call(&mut files, "list_file_results", json!({})).unwrap()["kinds"], json!({"summary": 1, "transcript": 1}));
}

#[test]
fn a_bad_item_is_refused_by_its_index_and_only_if_absent_refuses_a_replacement() {
    let (mut files, _, _) = account_files();
    let file = write(&mut files, "/a.txt", b"bytes");
    let put = call(&mut files, "record_file_results", json!({"results": [
        {"identity": "nope", "kind": "facts", "value": 1},
        {"identity": file, "kind": "Facts", "value": 1},
        {"identity": file, "kind": "facts"},
        {"identity": file, "kind": "facts", "value": 1, "only_if_absent": "yes"},
        {"identity": file, "kind": "facts", "value": {"pages": 2}},
        {"identity": file, "kind": "facts", "value": {"pages": 3}, "only_if_absent": true},
    ]})).unwrap();
    assert_eq!(put["recorded"], 1);
    let indexes: Vec<u64> = put["refused"].as_array().unwrap().iter().map(|row| row["index"].as_u64().unwrap()).collect();
    assert_eq!(indexes, vec![0, 1, 2, 3, 5]);
    let refused = put["refused"].as_array().unwrap();
    let causes = refused.iter().map(|row| {
        let encoded = row["cause"].as_str().expect("each refused item names its own producer");
        let cause = trillion_local::refusal_cause::Cause::from_wire(encoded).unwrap();
        assert_eq!(cause.file(), "src/account_files/results.rs");
        let source_line = include_str!("../src/account_files/results.rs").lines().nth(cause.line() as usize - 1).unwrap();
        assert!(source_line.contains("CodedError::new(word("), "the original input condition, before result delivery");
        assert!(!encoded.contains(&file));
        assert!(!row["reason"].as_str().unwrap().contains("cause="), "metadata stays beside the original public reason");
        encoded.to_owned()
    }).collect::<std::collections::BTreeSet<_>>();
    assert_eq!(causes.len(), refused.len(), "the five distinct input conditions retain distinct origins");

    let replaced = call(&mut files, "record_file_results", json!({"results": [{"identity": file, "kind": "facts", "value": {"pages": 3}}]})).unwrap();
    assert_eq!(replaced["recorded"], 1, "an intentional replacement without only_if_absent is kept");
    assert_eq!(call(&mut files, "list_file_results", json!({})).unwrap()["kinds"]["facts"], 1, "a replacement is not a second result");
    assert!(matches!(call(&mut files, "record_file_results", json!({})), Err(AccountFilesError::Invalid(_, _))));
    let large = "x".repeat(1_500_001);
    let big = call(&mut files, "record_file_results", json!({"results": [{"identity": file, "kind": "facts", "value": large}]})).unwrap();
    assert_eq!(big["refused"][0]["index"], 0);
}

#[test]
fn one_kind_lists_across_every_file_in_identity_order_a_page_at_a_time() {
    let (mut files, _, _) = account_files();
    let mut identities: Vec<String> = (0..3).map(|n| write(&mut files, &format!("/{n}.txt"), format!("file {n}").as_bytes())).collect();
    for identity in &identities {
        call(&mut files, "record_file_results", json!({"results": [{"identity": identity, "kind": "summary", "value": identity}]})).unwrap();
    }
    identities.sort();
    let first = call(&mut files, "list_file_results", json!({"kind": "summary", "limit": 2})).unwrap();
    let shown: Vec<&str> = first["results"].as_array().unwrap().iter().map(|row| row["identity"].as_str().unwrap()).collect();
    assert_eq!(shown, vec![identities[0].as_str(), identities[1].as_str()]);
    let after = first["next_after"].as_str().unwrap();
    let second = call(&mut files, "list_file_results", json!({"kind": "summary", "after": after})).unwrap();
    assert_eq!(second["results"][0]["value"], json!(identities[2]));
    assert_eq!(second["next_after"], Value::Null);
    assert!(matches!(call(&mut files, "list_file_results", json!({"kind": "Bad"})), Err(AccountFilesError::Invalid(_, _))));
}

#[test]
fn a_merge_changes_only_the_named_fields_of_the_one_result_the_file_has() {
    let (mut files, _, _) = account_files();
    let file = write(&mut files, "/talk.m4a", b"a recording");
    let alias = alias_of(&mut files, &file);
    call(&mut files, "record_file_results", json!({"results": [{"identity": alias, "kind": "facts", "value": {"title": "", "pages": 2, "lang": "en"}}]})).unwrap();
    let merged = call(&mut files, "merge_file_result", json!({"identity": file, "kind": "facts", "value": {"pages": 3, "lang": null}})).unwrap();
    assert_eq!(merged["kept_under"], json!(alias), "the result the file already has, never a second copy");
    assert_eq!(merged["value"], json!({"title": "", "pages": 3}));
    assert_eq!(merged["changed"], true);
    let filled = call(&mut files, "merge_file_result", json!({"identity": alias, "kind": "facts", "value": {"title": "Talk", "pages": 9}, "only_if_empty": true})).unwrap();
    assert_eq!(filled["value"], json!({"title": "Talk", "pages": 3}), "only empty fields are filled");
    assert_eq!(call(&mut files, "list_file_results", json!({})).unwrap()["kinds"], json!({"facts": 1}));
    let fresh = call(&mut files, "merge_file_result", json!({"identity": file, "kind": "notes", "value": {"a": 1}})).unwrap();
    assert_eq!(fresh["kept_under"], json!(file));
    call(&mut files, "record_file_results", json!({"results": [{"identity": file, "kind": "summary", "value": "plain text"}]})).unwrap();
    assert!(matches!(call(&mut files, "merge_file_result", json!({"identity": file, "kind": "summary", "value": {"a": 1}})), Err(AccountFilesError::Invalid(_, _))));
    assert!(matches!(call(&mut files, "merge_file_result", json!({"identity": file, "kind": "facts", "value": [1]})), Err(AccountFilesError::Invalid(_, _))));
}

#[test]
fn a_removed_result_is_forgotten_under_exactly_its_identity_and_its_count_goes_down() {
    let (mut files, _, _) = account_files();
    let file = write(&mut files, "/a.txt", b"bytes");
    call(&mut files, "record_file_results", json!({"results": [{"identity": file, "kind": "title", "value": "A"}]})).unwrap();
    assert_eq!(call(&mut files, "remove_file_result", json!({"identity": file, "kind": "title"})).unwrap()["removed"], 1);
    assert_eq!(call(&mut files, "remove_file_result", json!({"identity": file, "kind": "title"})).unwrap()["removed"], 0);
    assert_eq!(call(&mut files, "read_file_results", json!({"identity": file})).unwrap()["results"], json!([]));
    assert_eq!(call(&mut files, "list_file_results", json!({})).unwrap()["kinds"], json!({}));
    assert_eq!(call(&mut files, "list_file_results", json!({"kind": "title"})).unwrap()["results"], json!([]));
    call(&mut files, "record_file_results", json!({"results": [{"identity": file, "kind": "title", "value": "A"}]})).unwrap();
    assert_eq!(call(&mut files, "read_file_results", json!({"identity": file, "kind": "title"})).unwrap()["results"][0]["value"], "A", "the same value kept again after a removal");
}

#[test]
fn reads_refuse_what_is_not_an_identity_kind_or_field() {
    let (mut files, _, _) = account_files();
    for (tool, input) in [
        ("read_file_results", json!({"identity": "/a.txt"})),
        ("read_file_results", json!({"identity": format!("1f:{}", "a".repeat(64)), "kind": "No"})),
        ("read_file_result_fields", json!({"identity": format!("1f:{}", "a".repeat(64)), "kind": "facts", "fields": []})),
        ("read_file_result_fields", json!({"identity": format!("1f:{}", "a".repeat(64)), "kind": "facts", "fields": ["a-b"]})),
        ("read_file_result_fields", json!({"identity": format!("1f:{}", "a".repeat(64)), "kind": "facts", "fields": [1]})),
        ("read_file_results_many", json!({"kind": "facts"})),
        ("remove_file_result", json!({"identity": "x", "kind": "facts"})),
    ] {
        assert!(matches!(call(&mut files, tool, input.clone()), Err(AccountFilesError::Invalid(_, _))), "{tool} {input}");
    }
}
