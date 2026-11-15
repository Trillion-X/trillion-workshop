//! The incident scenarios as DATA (`src/account/computers/simulation/scenarios.json`). A row names one scenario, the
//! incident it answers, the owner lane that closes it, the plan rows and the fault and property ids it needs. `expect`
//! is the verdict the row records for main: `pass` (the scenario must pass), `fail` (it must fail until its owner's
//! change lands, which flips the row to `pass`), or `unwritten` (no scenario yet). A scenario that disagrees with its row
//! fails the suite, so a fix cannot land without its row changing, and a regression cannot hide behind a stale row.

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioRow {
    pub incident: u32,
    pub scenario: String,
    pub owner: String,
    pub plan: Vec<String>,
    pub faults: Vec<String>,
    pub properties: Vec<String>,
    pub status_on_main: String,
    pub expect: String,
    /// The owner's test that runs the scenario: `<file from the repository root>::<fn>`. Required once `expect` is pass or fail.
    #[serde(default)]
    pub test: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenarios {
    format: String,
    about: String,
    rows: Vec<ScenarioRow>,
}

pub fn load(json: &str) -> Vec<ScenarioRow> {
    let scenarios: Scenarios = serde_json::from_str(json).expect("scenario rows parse");
    assert_eq!(scenarios.format, "deterministic-world-scenarios/1", "unknown scenario row format");
    assert!(!scenarios.about.is_empty(), "scenario rows name their purpose");
    scenarios.rows
}

/// The row a named scenario answers to. A scenario with no row is a scenario the list does not know.
pub fn named(json: &str, scenario: &str) -> ScenarioRow {
    load(json).into_iter().find(|row| row.scenario == scenario).unwrap_or_else(|| panic!("no scenario row named {scenario}"))
}
