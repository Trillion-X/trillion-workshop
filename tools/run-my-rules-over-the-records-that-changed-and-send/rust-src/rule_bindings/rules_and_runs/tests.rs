// Formula fields, trigger rules and workflow runs as the record store calls them, each case ported from Trillion's
// own test of the same call (the commit that added this file names them).
use super::*;

/// Trillion's trigger rule test fixture `wonLead`.
fn won_lead() -> Value {
    json!({
        "id": "tell-me-when-a-lead-is-won",
        "match_condition": { "conditions": [{ "$bind": { "select": { "from": "change", "path": "stage" }, "transform": [{ "op": "op:core.equals", "args": { "value": "won" } }] } }] },
        "dispatch": {
            "target": "tool:send-message",
            "output_template": {
                "about": { "$bind": { "select": { "from": "envelope", "path": "address_text" } } },
                "value": { "$bind": { "select": { "from": "change", "path": "value" } } }
            }
        }
    })
}

#[test]
fn a_rule_fires_only_for_the_change_it_matches_and_its_send_is_handed_to_the_caller() {
    let rules = vec![("won".to_string(), won_lead())];
    let open = rules_over_records("person:test", "rule", &rules, &[json!({ "address": "lead:acme", "value": { "stage": "open", "value": 10 } })], &[]).unwrap();
    assert!(open.fires.is_empty(), "a change the rule does not match sends nothing");

    let won = rules_over_records("person:test", "rule", &rules, &[json!({ "address": "lead:acme", "value": { "stage": "won", "value": 12 } })], &[]).unwrap();
    assert_eq!(won.fires, vec![json!({ "target": "tool:send-message", "later": false, "payload": { "about": "lead:acme", "value": 12 } })]);
    // The trigger engine names the kind of its own outcome row itself (the crate); the rules keep one for the send.
    let outcome = won.writes.iter().find(|write| write["payload"]["rule_id"] == "tell-me-when-a-lead-is-won").expect("the rules keep their outcome");
    assert!(outcome["payload"]["kind"].as_str().is_some_and(|kind| !kind.is_empty()));
    assert_eq!(outcome["payload"]["status"], "succeeded");
    assert_eq!(outcome["payload"]["rule_id"], "tell-me-when-a-lead-is-won");
}

#[test]
fn a_removed_record_is_a_change_no_rule_reads_a_value_of() {
    let rules = vec![("won".to_string(), won_lead())];
    let gone = rules_over_records("person:test", "rule", &rules, &[json!({ "address": "lead:acme", "removed": true })], &[]).unwrap();
    assert!(gone.fires.is_empty());
}

/// Trillion's workflow test fixture `draft-then-count`.
fn draft_then_count() -> Value {
    json!([{
        "id": "draft-then-count", "name": "Draft then count", "kind": "workflow", "is_active": true, "version": 1,
        "steps": [
            { "id": "draft", "kind": "ask", "config": { "name": "tool:draft", "input": { "topic": "pottery" }, "context": { "step_id": "draft" } } },
            { "id": "count", "kind": "ask", "config": { "name": "tool:count-words", "input": {}, "context": { "step_id": "count" } } }
        ],
        "edges": [{ "from": "draft", "to": "count", "kind": "always" }]
    }])
}

#[test]
fn a_run_pauses_at_the_first_ask_it_has_no_answer_for_and_goes_on_once_answered() {
    let paused = run_workflow_definition(&draft_then_count(), "draft-then-count", &json!({}), &json!({}), "person:test", "").unwrap();
    assert_eq!(paused["status"], "paused", "{paused}");
    assert_eq!(paused["waiting"][0]["step_id"], "draft");
    assert_eq!(paused["waiting"][0]["asks"], "tool:draft");
    assert_eq!(paused["waiting"][0]["input"], json!({ "topic": "pottery" }));

    let half = run_workflow_definition(&draft_then_count(), "draft-then-count", &json!({}), &json!({ "draft": { "text": "x" } }), "person:test", "").unwrap();
    assert_eq!(half["status"], "paused", "{half}");
    assert_eq!(half["waiting"][0]["step_id"], "count");

    let done = run_workflow_definition(&draft_then_count(), "draft-then-count", &json!({}), &json!({ "draft": { "text": "x" }, "count": { "words": 1 } }), "person:test", "").unwrap();
    assert_eq!(done["status"], "completed", "{done}");
    assert_eq!(done["waiting"], json!([]));
    assert_eq!(done["execution_context"]["steps"]["count"]["output"], json!({ "words": 1 }));
}

#[test]
fn an_ask_is_answered_by_its_name_when_no_step_id_answers_it() {
    let done = run_workflow_definition(&draft_then_count(), "draft-then-count", &json!({}), &json!({ "tool:draft": { "text": "x" }, "tool:count-words": { "words": 1 } }), "person:test", "").unwrap();
    assert_eq!(done["status"], "completed", "{done}");
}

/// Trillion lists.json `formula`, in the shape the list tool's field_kinds has it (tools/export-records-as-list-rows),
/// with a made-up target name (only the kind row's own default target is answered), joined into an installed model.
fn kinds() -> Vec<Value> {
    let formula = json!({"id": "formula", "kind": "text", "value": "computed",
        "carries": {"key": "derive", "defaults": {"target": "formula-engine", "result_path": ["value"]}}});
    let model = crate::record_model_policy::Installed::from_rows(&[json!({"record_model": {"field_kinds": [formula]}})], true).unwrap();
    field_kinds(&model)
}

#[test]
fn a_formula_field_is_worked_out_from_its_rows_values_and_kept_fields_are_not() {
    // Trillion test/list-formula-and-button-columns.test.mjs `seconds`: minutes × 60.
    let binding = json!({ "$kind": "binding", "select": { "from": "self", "path": ["minutes"] }, "transform": [{ "op": "op:core.mul", "args": { "value": 60 } }, { "op": "op:core.to_number" }] });
    let fields = vec![
        json!({ "id": "name", "label": "Name", "kind": "text" }),
        json!({ "id": "minutes", "label": "Minutes", "kind": "number" }),
        json!({ "id": "seconds", "label": "Seconds", "kind": "formula", "derive": { "request": { "binding": binding } } }),
    ];
    let values = derived_values(&fields, &kinds(), &json!({ "name": "Bo Chen", "minutes": 12 }));
    assert_eq!(values, json!({ "seconds": 720 }).as_object().unwrap().clone());
}

#[test]
fn a_formula_that_fails_or_names_another_target_reads_as_null() {
    let fields = vec![
        json!({ "id": "minutes", "kind": "number" }),
        json!({ "id": "broken", "kind": "formula", "derive": { "request": { "binding": { "$kind": "binding", "select": { "from": "self", "path": ["minutes"] }, "transform": [{ "op": "op:core.no-such-op" }] } } } }),
        json!({ "id": "elsewhere", "kind": "formula", "derive": { "target": "tools.run", "request": { "binding": { "$kind": "binding", "select": { "from": "self", "path": ["minutes"] } } } } }),
    ];
    let values = derived_values(&fields, &kinds(), &json!({ "minutes": 3 }));
    assert_eq!(values, json!({ "broken": null, "elsewhere": null }).as_object().unwrap().clone());
}

#[test]
fn ids_are_the_ones_trillion_gave() {
    // workflows.mjs start: run:${identityOf({ workflow_id, request_key }).slice(3, 27)}; identityOf = '1f:' + BLAKE3 hex.
    let canonical = r#"{"request_key":"k1","workflow_id":"w1"}"#;
    let expected = format!("run:{}", &content_crypto::advanced::blake3::hash(canonical.as_bytes()).to_hex()[..24]);
    assert_eq!(run_id("w1", "k1").unwrap(), expected);
    assert_eq!(send_key(&json!({ "rule_id": "r", "record_id": "record:calls:a", "content": "c" })), "rule:r:record:calls:a:c");
    assert_eq!(send_key(&json!({ "rule_id": "r" })), "rule:r:undefined:undefined");
    assert!(rule_run_id("2026-11-03T00:00:00.000Z", "addr").unwrap().starts_with("rule-run:2026-11-03T00:00:00.000Z:"));
}

#[test]
fn the_kinds_are_the_installed_tools_and_with_none_no_rule_runs() {
    use crate::record_model_policy::Installed;
    // No installed tool declares the section: no kinds, so the records write runs no rule (on_write.rs returns early).
    let none = Installed::from_rows(&[json!({"record_model": {"kinds": [{"type": "note"}]}})], true).unwrap();
    assert!(Kinds::of(&none).unwrap().is_none());
    // The tool that keeps the rules names them; the rules never watch what they write.
    let section = json!({"rule": "r", "outcome": "o", "run": "w", "recipe": "p", "send": "s", "own": ["r", "o", "w", "p", "s"]});
    let named = Installed::from_rows(&[json!({"record_model": {"rules_and_runs": section}})], true).unwrap();
    let kinds = Kinds::of(&named).unwrap().unwrap();
    assert_eq!((kinds.rule.as_str(), kinds.run.as_str(), kinds.send.as_str()), ("r", "w", "s"));
    assert!(kinds.own("o") && !kinds.own("note"));
    // A section that does not read as the kinds refuses, never silently runs no rule.
    let broken = Installed::from_rows(&[json!({"record_model": {"rules_and_runs": {"rule": "r"}}})], true).unwrap();
    assert!(Kinds::of(&broken).is_err());
}
