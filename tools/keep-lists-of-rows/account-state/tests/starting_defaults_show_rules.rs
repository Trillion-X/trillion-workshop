//! Every account starts with Trillion's defaults: the show-rules read of a blank account, an existing account and an
//! account that switched the Simple workspace off, with a synthetic publisher row
//! (tests/fixtures/starting-set/tools/starting-set/shipped-defaults.json) laid under the person's record by the
//! generic overlay (src/records/shipped_defaults.rs) and read through the real ShowRules owner with minimal
//! synthetic schema DATA (tests/fixtures/starting-set/overlay-read-schema.json). Nothing is written.
use ecma_json::{JsString, Value};
use std::{fs, path::Path};
use trillion_local::{ecma_json, records::shipped_defaults, tool_runs::tools::shipped_defaults as published, workspace_show_rules};
use workspace_show_rules::{
    Authority, ClockFacts, ClockOwner, CurrentOwner, FormulaAnswer, FormulaOwner, GivenContext, Limits, ShowRules,
};

fn json(raw: &str) -> Value {
    ecma_json::parse(raw.as_bytes(), ecma_json::Limits::default()).unwrap()
}
fn show(value: &Value) -> String {
    ecma_json::stringify(value, ecma_json::Limits::default()).unwrap()
}
fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(object) => object.get(&JsString::from(key)),
        _ => None,
    }
}
fn words(value: Option<&Value>, field: Option<&str>) -> Vec<String> {
    match value {
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(|row| match field.map_or(Some(row), |f| get(row, f)) {
                Some(Value::String(s)) => s.to_rust_string().ok(),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

const TYPE: &str = "simple-workspace";
fn tools() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/starting-set/tools"))
}
/// The default the publisher ships for the show-rules record, read the way trillion-local reads the installed tools.
fn default_row() -> Value {
    published::published_in(tools()).remove("show-rules").expect("the starting set publishes a show-rules default")
}

struct Owner {
    record: Option<Value>,
}
impl CurrentOwner for Owner {
    fn assert_current(&mut self) -> workspace_show_rules::Result<()> {
        Ok(())
    }
    fn authority(&mut self) -> workspace_show_rules::Result<Authority> {
        Ok(Authority::Personal)
    }
    fn personal_record(&mut self, _: &str) -> workspace_show_rules::Result<Option<Value>> {
        Ok(self.record.clone())
    }
    fn given_context(&mut self, _: Option<&str>) -> workspace_show_rules::Result<Option<GivenContext>> {
        Ok(Some(GivenContext { giver: Value::Null, facts: json("{}"), space_types: vec![], audience_fields: vec![] }))
    }
    fn thing_facts(&mut self, _: &[Value], _: &Value, _: i64) -> workspace_show_rules::Result<Value> {
        Err(trillion_local::cause!(workspace_show_rules::Error::Unavailable))
    }
    fn edit_rules_now(&mut self, _: Option<&Value>, _: Authority, _: i64) -> workspace_show_rules::Result<Value> {
        Ok(json(r#"{"rules":[]}"#))
    }
    fn attribute_fields(&mut self, _: Option<&Value>) -> workspace_show_rules::Result<Value> {
        Ok(json("[]"))
    }
    fn controls(&mut self) -> workspace_show_rules::Result<Value> {
        Ok(json("[]"))
    }
    fn operators(&mut self) -> workspace_show_rules::Result<Value> {
        Ok(json("[]"))
    }
}
struct NoFormula;
impl FormulaOwner for NoFormula {
    fn matches(&mut self, _: &Value, _: &Value, _: &[Value]) -> workspace_show_rules::Result<FormulaAnswer> {
        Ok(FormulaAnswer { matches: false, incomplete: vec![] })
    }
}
struct Clock;
impl ClockOwner for Clock {
    fn now_ms(&mut self) -> workspace_show_rules::Result<i64> {
        Ok(1_800_000_000_000)
    }
    fn time_of(&mut self, _: &Value) -> workspace_show_rules::Result<Option<i64>> {
        Ok(None)
    }
    fn date_parse(&mut self, _: &Value) -> workspace_show_rules::Result<Option<i64>> {
        Ok(None)
    }
    fn facts(&mut self, _: i64, _: Option<&str>) -> workspace_show_rules::Result<ClockFacts> {
        Ok(ClockFacts { hour: None, minute: None, weekday: None })
    }
    fn next_turn(&mut self, _: i64, _: &str, _: Option<&str>) -> workspace_show_rules::Result<Option<i64>> {
        Ok(None)
    }
    fn rule_turn(&mut self, _: i64, _: &Value, _: &[Value], _: &Value, _: Option<&str>) -> workspace_show_rules::Result<Option<i64>> {
        Ok(None)
    }
}

/// The show-rules read of a person whose own record is `own`, with the shipped default `row` laid under it.
fn read(row: &Value, own: Option<&Value>) -> Value {
    let data = json(include_str!("fixtures/starting-set/overlay-read-schema.json"));
    let mut owner = Owner { record: shipped_defaults::lay_under(row, own) };
    ShowRules { data: &data, owner: &mut owner, formula: &mut NoFormula, clock: &mut Clock, limits: Limits::default() }
        .read()
        .unwrap()
}

#[test]
fn a_blank_new_account_lists_the_simple_workspace_and_has_it_in_use() {
    let answer = read(&default_row(), None);
    assert!(words(get(&answer, "types"), Some("id")).contains(&TYPE.to_owned()));
    assert_eq!(words(get(&answer, "in_use"), None), [TYPE]);
}

#[test]
fn an_existing_account_gets_it_beside_what_it_kept() {
    let own = json(r#"{"rules":[],"in_use":["mine"],"types":[{"id":"mine","label":"Mine","inherits":[],"rules":[]}]}"#);
    let answer = read(&default_row(), Some(&own));
    assert_eq!(words(get(&answer, "in_use"), None), ["mine", TYPE]);
    assert!(words(get(&answer, "types"), Some("id")).iter().any(|id| id == "mine"));
}

#[test]
fn turning_it_off_keeps_it_off_after_a_new_deploy_of_the_defaults() {
    let own = json(r#"{"starting":{"simple-workspace":{"on":false}}}"#);
    assert!(words(get(&read(&default_row(), Some(&own)), "in_use"), None).is_empty());
    // A new deploy: the publisher changes the type's words. The person's switch-off still wins.
    let changed = show(&default_row()).replace("\"Simple workspace\"", "\"Simple workspace, changed\"");
    let answer = read(&json(&changed), Some(&own));
    assert!(words(get(&answer, "in_use"), None).is_empty());
    assert!(words(get(&answer, "types"), Some("label")).iter().any(|l| l == "Simple workspace, changed"));
}

#[test]
fn an_account_that_had_already_turned_it_off_is_not_switched_back_on() {
    let own = json(r#"{"in_use":[],"starting":{"simple-workspace":{"on":false}},"rules":[]}"#);
    for _ in 0..2 {
        assert!(words(get(&read(&default_row(), Some(&own)), "in_use"), None).is_empty());
    }
}

#[test]
fn the_defaults_are_never_written_into_the_store() {
    let own = json(r#"{"in_use":["mine"],"rules":[]}"#);
    let store_before = show(&own);
    let published_before = fs::read(tools().join("starting-set/shipped-defaults.json")).unwrap();
    let _ = read(&default_row(), Some(&own));
    let _ = read(&default_row(), None);
    assert_eq!(show(&own), store_before, "the person's record is byte-equal before and after a read");
    assert_eq!(fs::read(tools().join("starting-set/shipped-defaults.json")).unwrap(), published_before);
}
