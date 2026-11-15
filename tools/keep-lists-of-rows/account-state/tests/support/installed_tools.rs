//! The synthetic tools a fixture account has installed: one tool whose row's `record_model` declares the record
//! kinds these tests write. trillion-local names no record kind; it builds the account's model from the tools in its
//! state folder (src/record_model_policy/installed.rs), so a fixture account installs one, as every account does at
//! its first start. The kind rows are the ones the tools that keep them declare (the list rule and
//! field kinds of tools/export-records-as-list-rows, pursuit of tools/decide-with-a-method, agent-handoff of
//! tools/hand-work-to-ais, told-the-person and the live heads of tools/tell-the-person, the rules' kinds of
//! tools/workflows), cut to the fields these tests read.
#![allow(dead_code)]
use serde_json::json;
use std::{fs, path::Path};

/// Install the fixture tool into the account state folder `state_root`.
pub fn install(state_root: &Path) {
    // Where the account's installed copy is found (tool-runs.json: a folder in the state folder, then its tools).
    let folder = state_root.join("workshop").join("tools").join("kept-records");
    fs::create_dir_all(&folder).unwrap();
    let model = json!({
        "declared_by": [{"type": "list", "kind": {"path": ["row_type"], "prefix": "record:"},
            "properties": {"path": ["fields"], "name": ["id"], "kind": ["kind"], "choices": ["choices"], "moves": ["moves"]},
            "indexes": {"path": ["indexes"]}, "parts_when": ["row-ids", "file"]}],
        "field_kinds": [{"id": "text", "value": "text"}, {"id": "number", "value": "number"}, {"id": "choice", "value": "text"},
            {"id": "tags", "value": "texts"}, {"id": "link", "value": "row-ids"},
            // A computed field kind (made-up target name: only the kind row's own default target is answered).
            {"id": "formula", "kind": "text", "value": "computed",
                "carries": {"key": "derive", "defaults": {"target": "formula-engine", "result_path": ["value"]}}}],
        "kinds": [
            {"type": "kept-here", "stays_on_this_device": true},
            {"type": "pursuit", "properties": {"parents": "ids", "children": "ids", "space_id": "id"},
                "parts": [{"role": "parent", "path": ["parents"]}, {"role": "child", "path": ["children"]}, {"role": "space", "path": ["space_id"]}]},
            {"type": "agent-handoff", "erasable": ["job", "said", "asked", ["input", "said"]], "erasable_key": ["input", "arrived", "message_id"]},
            {"type": "told-the-person", "erasable": [["item", "title"], ["item", "body"]]}
        ],
        // The record the live heads read the told list's head from (tools/tell-the-person), and the kinds the rules
        // and runs read and write (tools/workflows).
        "live_heads": {"told": "told-the-person"},
        "rules_and_runs": {"rule": "trigger-rule", "outcome": "trigger-dispatch-outcome", "run": "workflow-run",
            "recipe": "workflow-recipe", "send": "rule-tool-send",
            "own": ["trigger-rule", "trigger-dispatch-outcome", "workflow-dispatch-failure", "workflow-run", "workflow-recipe", "rule-tool-send"]},
        // The kind a harness hook keeps a session's card as (tools/hand-work-to-ais).
        "harness_hooks": {"agent_card": "session-card"}
    });
    let rows = json!({"records": [{"payload": {"kind": "ai-tool-descriptor", "id": "tool:kept-records", "record_model": model}}]});
    fs::write(folder.join("tool-rows.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
}
