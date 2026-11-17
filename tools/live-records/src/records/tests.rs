// src/records/tests.rs
//
// Purpose: The records door's operations over rows in memory: what each answers, what each refuses, and that a write is all or nothing and
// answers its first receipt when sent again.

use super::*;
use crate::settings::Settings;
use rows_store::store::SqlStore;
use std::sync::Arc;

fn records() -> Records {
    let settings = Settings::read(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/settings.json"))).unwrap();
    Records::new(Arc::new(SqlStore::memory().unwrap()), settings)
}

fn write(records: &Records, key: &str, items: Value) -> Result<Value, Refusal> {
    records.call("records:write", &json!({"records": items, "call_key": key}))
}

fn ids(page: &Value) -> Vec<String> {
    page["records"].as_array().unwrap().iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect()
}

#[test]
fn a_record_is_written_read_listed_and_removed_by_its_type_and_id() {
    let records = records();
    let receipt = write(&records, "k1", json!([{"id": "a", "type": "note", "value": {"title": "Red boat"}}, {"id": "a", "type": "other", "value": {"n": 1}}])).unwrap();
    assert_eq!(receipt, json!({"changed": true, "write_count": 2}));
    assert_eq!(records.call("records:read", &json!({"id": "a", "type": "note"})).unwrap(), json!({"id": "a", "type": "note", "value": {"title": "Red boat"}}));
    assert_eq!(records.call("records:read", &json!({"id": "b", "type": "note"})).unwrap()["value"], Value::Null, "absent reads as null");
    assert_eq!(records.call("records:read", &json!({"id": "a", "type": "nothing"})).unwrap()["value"], Value::Null, "another type is another record");
    assert_eq!(write(&records, "k2", json!([{"id": "a", "type": "note", "value": null}])).unwrap(), json!({"changed": true, "write_count": 1}));
    assert_eq!(records.call("records:read", &json!({"id": "a", "type": "note"})).unwrap()["value"], Value::Null);
    assert_eq!(write(&records, "k3", json!([{"id": "a", "type": "note", "value": null}])).unwrap(), json!({"changed": false, "write_count": 0}), "removing what is not there counts nothing");
}

#[test]
fn the_same_key_answers_the_first_receipt_and_another_body_under_it_is_a_conflict() {
    let records = records();
    let first = json!([{"id": "a", "type": "t", "value": {"n": 1}}]);
    assert_eq!(write(&records, "same", first.clone()).unwrap(), json!({"changed": true, "write_count": 1}));
    // The row changes by another write, and the first key sent again still answers the first receipt and does not undo it.
    write(&records, "other", json!([{"id": "a", "type": "t", "value": {"n": 2}}])).unwrap();
    assert_eq!(write(&records, "same", first).unwrap(), json!({"changed": true, "write_count": 1}));
    assert_eq!(records.call("records:read", &json!({"id": "a", "type": "t"})).unwrap()["value"], json!({"n": 2}));
    assert_eq!(write(&records, "same", json!([{"id": "a", "type": "t", "value": {"n": 9}}])), Err(Refusal::conflict()));
    let original = json!({"records": [{"id": "a", "type": "t", "value": {"n": 1}}]});
    assert_eq!(records.call("records:result", &json!({"request_key": "same", "operation": "records:write", "input": original})).unwrap(), json!({"changed": true, "write_count": 1}));
    assert_eq!(records.call("records:result", &json!({"request_key": "never", "operation": "records:write", "input": original})), Err(Refusal::source_unknown()));
}

#[test]
fn an_expected_condition_that_fails_refuses_the_whole_write_before_any_row_changes() {
    let records = records();
    write(&records, "k1", json!([{"id": "a", "type": "t", "value": {"n": 1}}])).unwrap();
    let refused = write(&records, "k2", json!([{"id": "b", "type": "t", "value": {"n": 5}}, {"id": "a", "type": "t", "value": {"n": 2}, "expected": {"type": "t", "value": {"n": 7}}}]));
    assert_eq!(refused, Err(Refusal::conflict()));
    assert_eq!(records.call("records:read", &json!({"id": "b", "type": "t"})).unwrap()["value"], Value::Null, "the row before the refusal was not written");
    assert_eq!(write(&records, "k3", json!([{"id": "a", "type": "t", "value": {"n": 2}, "expected": {"type": "t", "value": {"n": 1}}}])).unwrap()["write_count"], 1);
    assert_eq!(write(&records, "k4", json!([{"id": "a", "type": "t", "value": {"n": 3}, "expected": null}])), Err(Refusal::conflict()), "null requires absence");
    assert_eq!(write(&records, "k5", json!([{"id": "z", "type": "t", "value": {"n": 3}, "expected": null}])).unwrap()["write_count"], 1);
    let checked = records.call("records:write", &json!({"records": [{"id": "q", "type": "t", "value": {}}], "call_key": "k6", "check_only": true})).unwrap();
    assert_eq!(checked, json!({"changed": true, "write_count": 1, "check_only": true}));
    assert_eq!(records.call("records:read", &json!({"id": "q", "type": "t"})).unwrap()["value"], Value::Null, "a check stores nothing");
}

#[test]
fn a_malformed_write_is_refused_before_anything_is_read() {
    let records = records();
    for bad in [
        json!([]),
        json!([{"id": "a/b", "type": "t", "value": {}}]),
        json!([{"id": "a", "type": "", "value": {}}]),
        json!([{"id": "a", "type": "t", "value": [1]}]),
        json!([{"id": "a", "type": "t", "value": {}, "extra": 1}]),
        json!([{"id": "a", "type": "t", "value": {}}, {"id": "a", "type": "t", "value": {"n": 1}}]),
    ] {
        assert_eq!(write(&records, "k", bad), Err(Refusal::input()));
    }
    assert_eq!(records.call("records:write", &json!({"records": [{"id": "a", "type": "t", "value": {}}]})), Err(Refusal::input()), "a write names its request key");
}

#[test]
fn a_list_walks_ids_greatest_first_in_pages_bounded_by_prefix_above_and_below() {
    let records = records();
    let items: Vec<Value> = (0..10).map(|n| json!({"id": format!("r{n}"), "type": "t", "value": {"n": n, "even": n % 2 == 0}})).collect();
    write(&records, "k", Value::Array(items)).unwrap();
    let first = records.call("records:list", &json!({"type": "t", "limit": 4})).unwrap();
    assert_eq!(ids(&first), ["r9", "r8", "r7", "r6"]);
    let second = records.call("records:list", &json!({"type": "t", "limit": 4, "after": first["next"]})).unwrap();
    assert_eq!(ids(&second), ["r5", "r4", "r3", "r2"]);
    let last = records.call("records:list", &json!({"type": "t", "limit": 4, "after": second["next"]})).unwrap();
    assert_eq!((ids(&last), &last["next"]), (vec!["r1".to_owned(), "r0".to_owned()], &Value::Null));
    assert_eq!(ids(&records.call("records:list", &json!({"type": "t", "reverse": false, "above": "r2", "below": "r6"})).unwrap()), ["r3", "r4", "r5"]);
    assert_eq!(ids(&records.call("records:list", &json!({"type": "t", "prefix": "r1"})).unwrap()), ["r1"]);
    assert_eq!(records.call("records:list", &json!({"type": "t", "limit": 1, "fields": []})).unwrap()["records"][0], json!({"id": "r9", "type": "t"}));
    assert_eq!(records.call("records:list", &json!({"type": "t", "limit": 1, "fields": ["n"]})).unwrap()["records"][0]["value"], json!({"n": 9}));
    for refused in [json!({"type": "t", "order": "by-date"}), json!({"type": "t", "limit": 0}), json!({"type": "t", "view": true}), json!({"type": "t", "bogus": 1}), json!({"type": "t", "where": {}})] {
        assert_eq!(records.call("records:list", &refused), Err(Refusal::input()), "{refused}");
    }
}

#[test]
fn where_reads_on_until_limit_rows_match_and_names_where_it_stopped() {
    let records = records();
    let items: Vec<Value> = (0..30).map(|n| json!({"id": format!("r{n:02}"), "type": "t", "value": {"even": n % 2 == 0}})).collect();
    write(&records, "k", Value::Array(items)).unwrap();
    let page = records.call("records:list", &json!({"type": "t", "where": {"even": true}, "limit": 3})).unwrap();
    assert_eq!(ids(&page), ["r28", "r26", "r24"]);
    assert_eq!(page["next"], "r24", "it stopped at the last row read");
    let rest = records.call("records:list", &json!({"type": "t", "where": {"even": true}, "limit": 99, "after": page["next"]})).unwrap();
    assert_eq!(ids(&rest).len(), 12);
    assert_eq!(rest["next"], Value::Null);
    assert_eq!(ids(&records.call("records:list", &json!({"type": "t", "where": {"even": "no"}})).unwrap()).len(), 0);
}

#[test]
fn a_list_page_is_cut_before_the_row_that_would_pass_a_message_and_a_row_too_big_alone_goes_as_byte_pages() {
    let records = records();
    let items: Vec<Value> = (0..40).map(|n| json!({"id": format!("r{n:02}"), "type": "t", "value": {"text": "x".repeat(2000)}})).collect();
    write(&records, "k", Value::Array(items)).unwrap();
    let page = records.call("records:list", &json!({"type": "t", "limit": 40})).unwrap();
    let shown = page["records"].as_array().unwrap().len();
    assert!((20..40).contains(&shown), "{shown}");
    assert!(serde_json::to_vec(&page).unwrap().len() <= 48_000);
    assert_eq!(page["next"].as_str(), page["records"][shown - 1]["id"].as_str(), "the next page starts after the last row shown");
    let big = json!([{"id": "big", "type": "huge", "value": {"text": "y".repeat(100_000)}}]);
    write(&records, "kb", big).unwrap();
    let first = records.call("records:read", &json!({"id": "big", "type": "huge"})).unwrap();
    assert!(first["byte_page"]["next_after_byte"].is_u64());
    let again = records.call("records:read", &json!({"id": "big", "type": "huge", "after_byte": first["byte_page"]["next_after_byte"]})).unwrap();
    assert_eq!(again["byte_page"]["offset"], first["byte_page"]["next_after_byte"]);
    assert_eq!(again["byte_page"]["blake3"], first["byte_page"]["blake3"]);
}

#[test]
fn a_search_finds_the_records_holding_every_word_at_the_start_of_a_word_ranked_newest_first() {
    let records = records();
    write(&records, "k1", json!([{"id": "1", "type": "note", "value": {"title": "Red boat"}}])).unwrap();
    write(&records, "k2", json!([{"id": "2", "type": "note", "value": {"title": "Red car", "body": "scarlet boat"}}, {"id": "3", "type": "task", "value": {"name": "boat repair, red"}}])).unwrap();
    let found = records.call("records:search", &json!({"question": "red BOAT"})).unwrap();
    assert_eq!(found["terms"], json!(["red", "boat"]));
    let order: Vec<String> = found["results"].as_array().unwrap().iter().map(|result| format!("{}:{}", result["type"].as_str().unwrap(), result["id"].as_str().unwrap())).collect();
    assert_eq!(order.len(), 3, "{order:?}");
    assert!(found["results"][0]["address"]["input"]["id"].is_string());
    assert_eq!(found["results"][0]["address"]["operation"], "records:read");
    assert!(found["results"][0]["score"].as_f64().unwrap() > found["results"][2]["score"].as_f64().unwrap() - 1e-12);
    assert_eq!(records.call("records:search", &json!({"question": "ca", "type": "note"})).unwrap()["results"].as_array().unwrap().len(), 1, "ca starts the word car, not scarlet");
    assert_eq!(records.call("records:search", &json!({"question": "a", "type": "note"})).unwrap()["results"], json!([]), "a one-letter word is not asked");
}

#[test]
fn workspace_labels_are_written_and_read_by_exact_label_in_the_http_envelope() {
    let records = records();
    let receipt = records.call("workspace:write", &json!({"writes": [{"address_label": "screen-look", "payload": {"a": 1}}, {"address_label": "nothing", "payload": null}], "call_key": "w1"})).unwrap();
    assert_eq!(receipt, json!({"changed": true, "write_count": 2}));
    let read = records.call("workspace:read", &json!({"selection": {"labels": ["screen-look", "nothing", "absent"], "prefixes": []}})).unwrap();
    assert_eq!((read["status"].clone(), read["content_type"].clone()), (json!(200), json!("application/json")));
    let body: Value = serde_json::from_str(read["text"].as_str().unwrap()).unwrap();
    assert_eq!(body, json!({"records": {"screen-look": {"a": 1}, "nothing": null}}), "a stored null stays and an absent label is absent");
    for refused in [
        json!({"selection": {"labels": ["a"]}}),
        json!({"selection": {"labels": ["a"], "prefixes": ["a"]}}),
        json!({"selection": {"labels": [], "prefixes": []}}),
        json!({"selection": {"labels": ["a", "a"], "prefixes": []}}),
    ] {
        assert_eq!(records.call("workspace:read", &refused), Err(Refusal::input()), "{refused}");
    }
}
