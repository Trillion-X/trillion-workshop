// src/rule_bindings/rules_and_runs/shipped_rules.rs
//
// Purpose: The rules that ship with the deploy, as the rules the record store runs beside an account's own rule rows.
// Each installed tool folder may hold the rules and schedules every account has by itself (settings `shipped_rules`:
// `file`, its `rows`, each rule row named by `id_field`) in plain words (`when`, `then`); here each is compiled to the
// trigger engine's rule exactly as Trillion's set_rule did (src/automations.mjs `compileRecordRule`, `defaultAutomationOf`),
// and `change_of` is the shape of a changed record those rules bind (Trillion's `shaped`: `{ kind, id, record }`).
//
// Non-Negotiable Invariants:
//   1. A shipped rule is read, never written: no row of it is made in an account's store (src/records/shipped_defaults.rs
//      invariant 1), so a rule changed in the deploy reaches every account that never touched it, with no row written.
//   2. The account's own row of the same id wins, switched off or on: it is the rule, and the shipped one is not read.
//   3. Nothing here names a rule, a kind, a workflow or a tool: the rows say them. A row this port does not read (a
//      rule about a space's items, a test or word it does not know) is left out alone, with one stderr line, and never
//      stops the others; a schedule (a row with `schedule_id_field`) is not a rule: the wake reads it
//      (`shipped_schedules`), and each_connected_event rows are left out unlogged.
//   3a. The rules read are kept for the installed commit served last, in one slot a different commit replaces, so a
//      write costs one path resolution, not a read and a compile and the kept copy never grows with deploys.
//   4. Two tool folders shipping one rule id refuse both, so a reader never gets one of two at random.
//   5. A change keeps its record's own fields as they were: the rules an account holds bind those and read the same after
//      this owner as before. The shape shipped rules bind sits beside them under one field named in DATA.
//
// Security Considerations: reading writes nothing; a file over `max_bytes` or unreadable is left out whole.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, fs, io::Read, path::{Path, PathBuf}, sync::Mutex};

const WHERE_TESTS: [&str; 5] = ["equals", "one_of", "starts_with", "contains", "present"];

fn nonempty(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.trim().is_empty())
}

fn bind(from: &str, path: &str, transform: Option<Value>) -> Value {
    let mut select = json!({ "select": { "from": from, "path": path } });
    if let Some(transform) = transform {
        select["transform"] = transform;
    }
    json!({ "$bind": select })
}
fn on_change(path: &str, transform: Option<Value>) -> Value {
    bind("change", path, transform)
}
fn equals(value: &Value) -> Value {
    json!([{ "op": "op:core.equals", "args": { "value": value } }])
}

/// The field of a changed record's value that holds `{ kind, id, record }` (settings `shipped_rules.change_field`).
fn shaped() -> String {
    super::settings().map(|settings| settings.shipped_rules.change_field.clone()).unwrap_or_default()
}

/// A field of the changed record as a path in `change_of`'s shape (`id` and `kind` are the change's own).
fn path_of(field: &str) -> String {
    let at = shaped();
    if field == "id" || field == "kind" { format!("{at}.{field}") } else { format!("{at}.record.{field}") }
}

/// What a rule sees of one changed record: its own fields as they are (the rules an account holds bind those), and under
/// `change_field` the shape Trillion's rules bind, `{ kind, id, record }` (Trillion `shaped`). A record that is not an
/// object is handed as it is: no shipped rule matches it, and no rule of the account's own changes.
pub fn change_of(id: &str, kind: &str, record: &Value) -> Value {
    let Some(fields) = record.as_object() else { return record.clone() };
    let mut value = fields.clone();
    value.insert(shaped(), json!({ "kind": kind, "id": id, "record": record }));
    Value::Object(value)
}

fn where_condition(test: &Value, at: usize) -> Result<Value, String> {
    let field = nonempty(test.get("field")).ok_or_else(|| format!("when.where[{at}] needs field"))?;
    let tests: Vec<&str> = WHERE_TESTS.into_iter().filter(|name| test.get(*name).is_some()).collect();
    let [name] = tests[..] else { return Err(format!("when.where[{at}] needs exactly one of {}", WHERE_TESTS.join(", "))) };
    if test.get("not").is_some_and(|not| *not != Value::Bool(true)) {
        return Err(format!("when.where[{at}].not must be true"));
    }
    let path = path_of(field);
    let value = &test[name];
    let mut transform = match name {
        "equals" => equals(value).as_array().cloned().unwrap_or_default(),
        "one_of" => match value.as_array().filter(|values| !values.is_empty()) {
            Some(values) => vec![json!({ "op": "op:core.in_list", "args": { "values": values } })],
            None => return Err(format!("when.where[{at}].one_of must list the values that match")),
        },
        "starts_with" => match nonempty(Some(value)) {
            Some(prefix) => vec![json!({ "op": "op:core.starts_with", "args": { "prefix": prefix } })],
            None => return Err(format!("when.where[{at}].starts_with must be text")),
        },
        "contains" => match nonempty(Some(value)) {
            Some(text) => vec![json!({ "op": "op:core.lower" }), json!({ "op": "op:core.contains", "args": { "value": text.to_lowercase() } })],
            None => return Err(format!("when.where[{at}].contains must be text")),
        },
        _ if *value == Value::Bool(true) => vec![json!({ "op": "op:core.is_not_null" })],
        _ => return Err(format!("when.where[{at}].present must be true")),
    };
    // `not: true` turns any test around.
    if test.get("not") == Some(&Value::Bool(true)) {
        transform.push(json!({ "op": "op:core.not" }));
    }
    Ok(on_change(&path, Some(Value::Array(transform))))
}

/// A tool's or workflow's input with every `{ fill: { from: "record", field } }` made a binding on what changed.
fn input_template(value: &Value, where_: &str) -> Result<Value, String> {
    match value {
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| input_template(item, &format!("{where_}[{index}]"))).collect::<Result<_, _>>().map(Value::Array),
        Value::Object(fields) => {
            if let (1, Some(fill)) = (fields.len(), fields.get("fill").filter(|fill| fill.is_object())) {
                let field = nonempty(fill.get("field")).filter(|_| fill.get("from") == Some(&json!("record")));
                return field.map(|field| on_change(&path_of(field), None)).ok_or_else(|| format!("{where_}: this rule fills from the record: {{ \"fill\": {{ \"from\": \"record\", \"field\": \"text\" }} }}"));
            }
            fields.iter().map(|(name, item)| Ok((name.clone(), input_template(item, &format!("{where_}.{name}"))?))).collect::<Result<Map<_, _>, String>>().map(Value::Object)
        }
        other => Ok(other.clone()),
    }
}

/// Trillion `checkedThen`: the workflow to start or the tool to run, and its input.
fn checked_then(then: &Value) -> Result<(Value, &str), String> {
    let input = then.get("input").cloned().unwrap_or_else(|| json!({}));
    if !input.is_object() {
        return Err("then.input must be an object".into());
    }
    match (nonempty(then.get("workflow_id")), nonempty(then.get("tool_id"))) {
        (Some(workflow), _) => Ok((json!({ "workflow_id": workflow, "input": input }), workflow)),
        (None, Some(tool)) => Ok((json!({ "tool_id": tool, "input": input }), tool)),
        _ => Err("then must be { tool_id, input } or { workflow_id, input }".into()),
    }
}

/// One shipped rule row in plain words as the trigger engine's rule, marked `default: true` and never stamped with when
/// it was set (Trillion `defaultAutomationOf`). Refuses what this port does not read, with the words.
pub fn compile_record_rule(row: &Value, id_field: &str) -> Result<(String, Value), String> {
    let rule_id = nonempty(row.get(id_field)).ok_or("the row names no rule")?.to_string();
    let when = row.get("when").filter(|when| when.is_object()).ok_or("the rule has no when")?;
    if nonempty(when.get("space_id")).is_some() {
        return Err("a rule about a space's items is not read here: only the account's own records are watched".into());
    }
    let recorded = nonempty(when.get("recorded")).ok_or("when needs recorded")?.trim().to_string();
    let tests = when.get("where").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut conditions = vec![on_change(&path_of("kind"), Some(equals(&json!(recorded))))];
    for (at, test) in tests.iter().enumerate() {
        conditions.push(where_condition(test, at)?);
    }
    let (then, target) = checked_then(row.get("then").ok_or("the rule has no then")?)?;
    let enabled = row.get("enabled") != Some(&Value::Bool(false));
    let mut plain_when = json!({ "recorded": recorded });
    if !tests.is_empty() {
        plain_when["where"] = Value::Array(tests);
    }
    let mut rule = json!({
        "id": rule_id, "label": row.get("label"), "when": plain_when, "then": then,
        "enabled": enabled, "is_active": enabled,
        "match_condition": { "conditions": conditions },
        "dispatch": { "target": target, "output_template": {
            "rule_id": rule_id,
            "then": if then.get("workflow_id").is_some() { json!({ "workflow_id": then["workflow_id"] }) } else { json!({ "tool_id": then["tool_id"] }) },
            "record_id": bind("envelope", "address_text", None),
            "content": bind("envelope", "content_hash", None),
            "input": input_template(&then["input"], "then.input")?,
        } },
        "default": true,
    });
    if let Some(backs) = row.get("backs") {
        rule["backs"] = backs.clone();
    }
    Ok((rule_id, rule))
}

/// Every rule the tool folders under `packages` ship, by rule id, in folder name order. A schedule row (one with
/// `schedule_id`) is not a rule and is left to its own reader.
pub fn shipped_rules_in(packages: &Path) -> BTreeMap<String, Value> {
    let Ok(settings) = super::settings() else { return BTreeMap::new() };
    let shipped = &settings.shipped_rules;
    let Ok(folders) = fs::read_dir(packages) else { return BTreeMap::new() };
    let mut names: Vec<_> = folders.filter_map(Result::ok).filter(|entry| entry.path().is_dir()).map(|entry| entry.file_name()).collect();
    names.sort();
    let mut found = BTreeMap::<String, Value>::new();
    let mut twice = Vec::new();
    for name in names {
        let path = packages.join(&name).join(&shipped.file);
        if !path.is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        let read = fs::File::open(&path).and_then(|file| file.take(shipped.max_bytes + 1).read_to_end(&mut bytes)).ok()
            .filter(|n| (*n as u64) <= shipped.max_bytes)
            .and_then(|_| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(document) = read else {
            crate::quiet_eprintln!("shipped-rules unreadable folder={}", name.to_string_lossy());
            continue;
        };
        for row in document.get(&shipped.rows).and_then(Value::as_array).into_iter().flatten() {
            if row.get(&shipped.id_field).is_none() {
                continue;
            }
            match compile_record_rule(row, &shipped.id_field) {
                Ok((id, rule)) => {
                    if found.insert(id.clone(), rule).is_some() {
                        twice.push(id);
                    }
                }
                Err(why) => crate::quiet_eprintln!("shipped-rules left-out folder={} why={why}", name.to_string_lossy()),
            }
        }
    }
    for id in twice {
        crate::quiet_eprintln!("shipped-rules twice rule={id}");
        found.remove(&id);
    }
    found
}

/// The rules the account's installed tools ship now; none when it has none installed. Read once for the installed
/// commit served last (shipped_recipes.rs `kept`: one slot, a different commit replaces it, so the kept copy never grows
/// with deploys), as the installed rows are (tools catalog.rs `rows`): a write costs one path resolution, not a read
/// and a compile of the file.
pub fn shipped_rules(state_root: &Path) -> BTreeMap<String, Value> {
    static KEPT: Mutex<Option<(PathBuf, BTreeMap<String, Value>)>> = Mutex::new(None);
    let Some(packages) = crate::tool_runs::tools::shipped().ok().and_then(|tools| tools.installed_tools(state_root)) else { return BTreeMap::new() };
    super::shipped_recipes::kept(&KEPT, &packages, shipped_rules_in)
}

/// Every schedule the tool folders under `packages` ship (a row with `schedule_id_field`), by schedule id, in folder name
/// order, as the row is written: its `every`, `then` and `overlap` are read by the wake (src/wake.rs `shipped_rows`), the
/// one scheduler. A row with no text id is left out, and two folders shipping one id refuse both.
pub fn shipped_schedules_in(packages: &Path) -> BTreeMap<String, Value> {
    let Ok(settings) = super::settings() else { return BTreeMap::new() };
    let shipped = &settings.shipped_rules;
    let Ok(folders) = fs::read_dir(packages) else { return BTreeMap::new() };
    let mut names: Vec<_> = folders.filter_map(Result::ok).filter(|entry| entry.path().is_dir()).map(|entry| entry.file_name()).collect();
    names.sort();
    let mut found = BTreeMap::<String, Value>::new();
    let mut twice = Vec::new();
    for name in names {
        let path = packages.join(&name).join(&shipped.file);
        let mut bytes = Vec::new();
        let read = fs::File::open(&path).and_then(|file| file.take(shipped.max_bytes + 1).read_to_end(&mut bytes)).ok()
            .filter(|n| (*n as u64) <= shipped.max_bytes)
            .and_then(|_| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(document) = read else { continue };
        for row in document.get(&shipped.rows).and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = nonempty(row.get(&shipped.schedule_id_field)) else { continue };
            if found.insert(id.to_string(), row.clone()).is_some() { twice.push(id.to_string()); }
        }
    }
    for id in twice {
        crate::quiet_eprintln!("shipped-schedules twice schedule={id}");
        found.remove(&id);
    }
    found
}

/// The schedules the account's installed tools ship now, kept for the installed commit served last (`kept`).
pub fn shipped_schedules(state_root: &Path) -> BTreeMap<String, Value> {
    static KEPT: Mutex<Option<(PathBuf, BTreeMap<String, Value>)>> = Mutex::new(None);
    let Some(packages) = crate::tool_runs::tools::shipped().ok().and_then(|tools| tools.installed_tools(state_root)) else { return BTreeMap::new() };
    super::shipped_recipes::kept(&KEPT, &packages, shipped_schedules_in)
}

/// The account's rules: its own rule rows (`own`: id after the rule kind's prefix, and the row, a row switched off
/// kept so it hides the shipped one), then each shipped rule the account has no row of. A rule switched off
/// (`enabled: false`) is not handed to the trigger rules.
pub fn rules_with_shipped(own: Vec<(String, Value)>, shipped: BTreeMap<String, Value>) -> Vec<(String, Value)> {
    let mut all = own;
    let held: std::collections::BTreeSet<String> = all.iter().map(|(id, _)| id.clone()).collect();
    all.extend(shipped.into_iter().filter(|(id, _)| !held.contains(id)));
    all.retain(|(_, rule)| rule.get("enabled") != Some(&Value::Bool(false)));
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rule_bindings::rules_and_runs::rules_over_records;

    /// A made-up shipped rule: names no feature, kind or tool this crate knows.
    fn made_up_folder(packages: &Path) {
        fs::create_dir_all(packages.join("made-up")).unwrap();
        fs::write(packages.join("made-up").join(&super::super::settings().unwrap().shipped_rules.file), json!({
            "every_account": [
                { "rule_id": "made-up:note-taken", "label": "Hand each note on", "when": { "recorded": "note", "where": [{ "field": "draft", "present": true, "not": true }] },
                  "then": { "workflow_id": "workflow:made-up", "input": { "text": { "fill": { "from": "record", "field": "text" } }, "kept": "yes" } } },
                { "rule_id": "made-up:off", "enabled": false, "when": { "recorded": "note" }, "then": { "tool_id": "tool:made-up" } },
                { "schedule_id": "made-up:daily", "label": "not a rule", "then": { "tool_id": "tool:made-up" }, "every": { "unit": "day" } },
                { "rule_id": "made-up:space", "when": { "space_id": "s", "recorded": "x" }, "then": { "tool_id": "tool:made-up" } }
            ]
        }).to_string()).unwrap();
    }

    fn fires_for(rules: &[(String, Value)], kind: &str, record: Value) -> Vec<Value> {
        let change = json!({ "address": "note:1", "path": [kind], "value": change_of("note:1", kind, &record) });
        rules_over_records("rules", "trigger-rule", rules, &[change], &[]).unwrap().fires
    }

    #[test]
    fn a_made_up_shipped_rule_fires_on_an_account_that_holds_no_rule_row() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path());
        let shipped = shipped_rules_in(packages.path());
        assert_eq!(shipped.keys().collect::<Vec<_>>(), ["made-up:note-taken", "made-up:off"], "schedules and rules about spaces are left out alone");
        let rules = rules_with_shipped(Vec::new(), shipped);
        assert_eq!(rules.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["made-up:note-taken"], "a rule shipped switched off is not run");
        let fires = fires_for(&rules, "note", json!({ "text": "hello" }));
        assert_eq!(fires.len(), 1, "{fires:?}");
        let payload = &fires[0]["payload"];
        assert_eq!(payload["then"], json!({ "workflow_id": "workflow:made-up" }));
        assert_eq!(payload["input"], json!({ "text": "hello", "kept": "yes" }));
        assert_eq!(payload["rule_id"], "made-up:note-taken");
        assert!(fires_for(&rules, "note", json!({ "text": "hello", "draft": 1 })).is_empty(), "a `not` test leaves out what it names");
        assert!(fires_for(&rules, "other", json!({ "text": "hello" })).is_empty(), "another kind of record is not this rule's");
    }

    #[test]
    fn a_rule_an_account_holds_still_reads_the_records_own_fields_of_a_shaped_change() {
        let own = json!({ "id": "mine", "match_condition": { "conditions": [{ "$bind": { "select": { "from": "change", "path": "stage" }, "transform": [{ "op": "op:core.equals", "args": { "value": "won" } }] } }] },
            "dispatch": { "target": "workflow:start", "output_template": { "rule_id": "mine", "then": { "workflow_id": "workflow:made-up" }, "input": { "stage": { "$bind": { "select": { "from": "change", "path": "stage" } } } } } } });
        let fires = fires_for(&[("mine".into(), own)], "note", json!({ "stage": "won" }));
        assert_eq!(fires.len(), 1, "{fires:?}");
        assert_eq!(fires[0]["payload"]["input"], json!({ "stage": "won" }));
    }

    #[test]
    fn schedules_are_handed_to_the_wake_as_written_and_two_folders_shipping_one_refuse_both() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path());
        let found = shipped_schedules_in(packages.path());
        assert_eq!(found.keys().collect::<Vec<_>>(), ["made-up:daily"]);
        assert_eq!(found["made-up:daily"]["every"], json!({ "unit": "day" }));
        fs::create_dir_all(packages.path().join("zz")).unwrap();
        fs::write(packages.path().join("zz").join(&super::super::settings().unwrap().shipped_rules.file), json!({ "every_account": [{ "schedule_id": "made-up:daily", "then": { "tool_id": "tool:x" } }] }).to_string()).unwrap();
        assert!(shipped_schedules_in(packages.path()).is_empty());
    }

    #[test]
    fn a_record_handed_as_its_bare_value_matches_no_rule_written_for_the_change_shape() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path());
        let rules = rules_with_shipped(Vec::new(), shipped_rules_in(packages.path()));
        let bare = json!({ "address": "note:1", "path": ["note"], "value": { "text": "hello" } });
        assert!(rules_over_records("rules", "trigger-rule", &rules, &[bare], &[]).unwrap().fires.is_empty());
    }

    #[test]
    fn the_accounts_own_row_of_a_shipped_rules_id_is_the_rule_and_a_switched_off_one_hides_it() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path());
        let shipped = shipped_rules_in(packages.path());
        let mut own_words = shipped["made-up:note-taken"].clone();
        own_words["dispatch"]["output_template"]["input"] = json!({ "text": "mine" });
        let rules = rules_with_shipped(vec![("made-up:note-taken".into(), own_words)], shipped.clone());
        assert_eq!(rules.len(), 1);
        assert_eq!(fires_for(&rules, "note", json!({ "text": "hello" }))[0]["payload"]["input"], json!({ "text": "mine" }));
        let mut off = shipped["made-up:note-taken"].clone();
        off["enabled"] = json!(false);
        assert!(rules_with_shipped(vec![("made-up:note-taken".into(), off)], shipped).is_empty());
    }

    #[test]
    fn two_folders_shipping_one_rule_refuse_both_and_a_bad_row_leaves_only_itself_out() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path());
        fs::create_dir_all(packages.path().join("zz")).unwrap();
        fs::write(packages.path().join("zz").join(&super::super::settings().unwrap().shipped_rules.file), json!({
            "every_account": [
                { "rule_id": "made-up:note-taken", "when": { "recorded": "note" }, "then": { "tool_id": "tool:x" } },
                { "rule_id": "zz:bad", "when": { "recorded": "note", "where": [{ "field": "a" }] }, "then": { "tool_id": "tool:x" } },
                { "rule_id": "zz:good", "when": { "recorded": "note" }, "then": { "tool_id": "tool:x" } }
            ]
        }).to_string()).unwrap();
        assert_eq!(shipped_rules_in(packages.path()).keys().collect::<Vec<_>>(), ["made-up:off", "zz:good"]);
        assert!(shipped_rules_in(&packages.path().join("absent")).is_empty());
    }
}
