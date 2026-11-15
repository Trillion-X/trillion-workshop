// tests/support/workshop_data.rs
//
// Purpose: give an integration test one DATA file of a tool, read from a checkout of the tools by trillion-local's
// own reader (src/tool_runs/tools/installed_data.rs). Trillion-local carries no product DATA; the tests that use the
// real operator table or the real show rules read the tools' own copy, the same file an installed account reads.
//
// Key Concepts: the checkout is the launch setting `WORKSHOP_MODULE_ROOT` (the tools folder, as for
// tests/workshop_output_kept.rs), else `trillion-workshop` beside this repository (docs/cloud-sessions.md); a missing
// checkout or file stops the test and names the setting.
//
// Included with `#[path]` by integration tests, so it holds only items and plain comments.
#![allow(dead_code)]

use std::path::PathBuf;
use trillion_local::ecma_json::Value;

/// The tools checkout's folder of tools.
pub fn workshop_tools() -> PathBuf {
    std::env::var_os("WORKSHOP_MODULE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../trillion-workshop")))
        .join("tools")
}

/// `file` of `tool` in the tools checkout, parsed as JSON by trillion-local's own reader.
pub fn workshop_json(tool: &str, file: &str) -> Value {
    let tools = workshop_tools();
    trillion_local::tool_runs::tools::installed_data::json_in(&tools, tool, file).unwrap_or_else(|| {
        panic!("{tool}/{file} is not readable under {} (set WORKSHOP_MODULE_ROOT to a Workshop checkout)", tools.display())
    })
}

/// The operator table every rule is compiled with (the tools checkout's tools/formula-engine/rules/rule-operators.json).
pub fn rule_operators() -> Value {
    workshop_json("formula-engine", "rules/rule-operators.json")
}

/// Lay every DATA file the show-rules reader names (src/local_account/show_rules/data.json) into the account state
/// folder `state_root` the way installed tools hold it (tool-runs.json: `workshop/tools/<tool>/<file>`), copied
/// from the tools checkout, so a fixture account reads the same DATA an installed account reads.
pub fn install_show_rules_data(state_root: &std::path::Path) {
    let data: serde_json::Value =
        serde_json::from_str(include_str!("../../src/local_account/show_rules/data.json")).unwrap();
    let tools = workshop_tools();
    for place in data["files"].as_object().unwrap().values() {
        let (tool, file) = (place[0].as_str().unwrap(), place[1].as_str().unwrap());
        let bytes = trillion_local::tool_runs::tools::installed_data::read_in(&tools, tool, file)
            .unwrap_or_else(|| panic!("{tool}/{file} is not readable under {} (set WORKSHOP_MODULE_ROOT)", tools.display()));
        let to = state_root.join("workshop").join("tools").join(tool).join(file);
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();
        std::fs::write(to, bytes).unwrap();
    }
}
