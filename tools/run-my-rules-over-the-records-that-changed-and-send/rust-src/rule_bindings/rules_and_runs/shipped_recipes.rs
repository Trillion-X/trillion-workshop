// src/rule_bindings/rules_and_runs/shipped_recipes.rs
//
// Purpose: The engine definition a workflow runs as, from every form a recipe is kept in: a recipe row whose
// `definition` is an object, or JSON text, or empty beside separate step rows, and the recipes the deploy ships in the
// installed tool folders (settings `shipped_recipes`: `dir`, `rows`, `payload_field`, `id_field`). Ported from Trillion's
// src/workflows.mjs `definitionOf` and `bindingsOf` (ordered steps become an engine definition) and
// tools/workflows/read-data/recipe-rows.mjs (a row holds nested values as JSON text).
//
// Non-Negotiable Invariants:
//   1. A shipped recipe is read, never written (src/records/shipped_defaults.rs invariant 1); a recipe row of the
//      account's own wins over a shipped one of the same id.
//   2. Nothing here names a workflow, a step, a tool or a kind: the rows say them; the field names are DATA.
//   3. A recipe this port cannot turn into a definition is left out with one stderr line and the run says its workflow
//      is not kept; it never stops the others.
//   4. The shipped recipes are kept for the one installed commit served last: a different installed commit replaces
//      the entry, so the kept copy never grows with deploys (the same slot as shipped_rules.rs).
//
// Security Considerations: reading writes nothing; a file over `max_bytes` or unreadable is left out whole.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, fs, io::Read, path::{Path, PathBuf}, sync::Mutex};

fn object(value: &Value) -> bool { value.is_object() }

/// A tool input written with `{ from: path }` (the first value there) or `{ all_from: path }` (every value there), as
/// the engine's bindings of the values at a path (Trillion `bindingsOf`).
fn bindings_of(template: &Value) -> Value {
    match template {
        Value::Array(items) => Value::Array(items.iter().map(bindings_of).collect()),
        Value::Object(fields) => {
            let optional = fields.len() == 2 && fields.get("omit_if_missing") == Some(&Value::Bool(true));
            let alone = fields.len() == 1 || optional;
            for (key, take) in [("from", None), ("all_from", Some("all"))] {
                if let (true, Some(values)) = (alone, fields.get(key).filter(|values| values.is_array())) {
                    let mut binding = json!({ "$kind": "binding", "values": values });
                    if let Some(take) = take { binding["take"] = json!(take); }
                    if optional { binding["omit_if_missing"] = json!(true); }
                    return binding;
                }
            }
            Value::Object(fields.iter().map(|(name, item)| (name.clone(), bindings_of(item))).collect::<Map<_, _>>())
        }
        other => other.clone(),
    }
}

/// A recipe as the engine definition it runs as (Trillion `definitionOf`): its own `definition` when it holds one (every
/// ask carrying its step id as context), else its ordered `steps` as asks joined by `always` edges, each step's checks
/// a check step after it. Refuses what holds neither.
pub fn definition_of(recipe: &Value) -> Result<Value, String> {
    let id = recipe["id"].as_str().unwrap_or_default();
    let shell = json!({ "id": id, "name": recipe.get("label").filter(|label| label.is_string()).unwrap_or(&json!(id)), "kind": "workflow", "is_active": true, "version": 1 });
    let mut definition = shell.as_object().cloned().unwrap_or_default();
    if let Some(given) = recipe.get("definition").filter(|given| object(given)) {
        let steps = given["steps"].as_array().ok_or("the definition holds no steps")?;
        definition.insert("edges".into(), given.get("edges").cloned().unwrap_or_else(|| json!([])));
        definition.insert("steps".into(), Value::Array(steps.iter().map(|step| {
            let mut step = step.clone();
            if step["kind"] == "ask" {
                let mut context = step["config"].get("context").filter(|context| object(context)).cloned().unwrap_or_else(|| json!({}));
                context["step_id"] = step["id"].clone();
                step["config"]["context"] = context;
            }
            step
        }).collect()));
        return Ok(Value::Object(definition));
    }
    let listed = recipe["steps"].as_array().filter(|steps| !steps.is_empty()).ok_or("the recipe holds neither a definition nor steps")?;
    let (mut steps, mut edges, mut last) = (Vec::new(), Vec::new(), None::<String>);
    for step in listed {
        let step_id = step["id"].as_str().ok_or("a step has no id")?.to_string();
        let checks: Vec<Value> = step["checks"].as_array().into_iter().flatten().map(|check| check["says"].clone()).collect();
        let mut shown = json!({ "step_id": step_id, "title": step.get("title").filter(|title| title.is_string()).unwrap_or(&json!(step_id)), "do": step["do"], "submit": step["submit"], "checks": checks });
        if let Some(policy) = step.get("actor_policy").filter(|policy| !policy.is_null()) { shown["actor_policy"] = policy.clone(); }
        if let Some(pinned) = step["run_tool"].get("pinned").filter(|pinned| !pinned.is_null() && **pinned != Value::Bool(false)) { shown["pinned"] = pinned.clone(); }
        let tool = step["run_tool"].get("tool_id").and_then(Value::as_str);
        let input = if step["run_tool"].is_object() { bindings_of(step["run_tool"].get("input").unwrap_or(&json!({}))) } else { json!({ "do": step["do"], "submit": step["submit"], "checks": shown["checks"] }) };
        steps.push(json!({ "id": step_id, "kind": "ask", "config": { "name": tool.unwrap_or("ai"), "input": input, "context": shown } }));
        if let Some(from) = &last { edges.push(json!({ "from": from, "to": step_id, "kind": "always" })); }
        last = Some(step_id.clone());
        if step["checks"].as_array().is_some_and(|checks| !checks.is_empty()) {
            let check_id = format!("{step_id}#checks");
            steps.push(json!({ "id": check_id, "kind": "check", "config": { "subject": step_id, "rules": step["checks"] } }));
            edges.push(json!({ "from": step_id, "to": check_id, "kind": "always" }));
            last = Some(check_id);
        }
    }
    definition.insert("steps".into(), Value::Array(steps));
    definition.insert("edges".into(), Value::Array(edges));
    Ok(Value::Object(definition))
}

/// A field a row keeps as JSON text, as the value it holds; a value that is not text is itself; empty text is nothing.
pub fn parsed_field(value: &Value) -> Result<Option<Value>, String> {
    match value {
        Value::String(text) if text.trim().is_empty() => Ok(None),
        Value::String(text) => serde_json::from_str(text).map(Some).map_err(|_| "a field holds text that is not JSON".to_string()),
        Value::Null => Ok(None),
        other => Ok(Some(other.clone())),
    }
}

/// A recipe row of an account (`row`) and the rows of its steps (`step_rows`, any order) as a recipe payload for
/// `definition_of`: `definition` read from its text, else the steps in order of `order_field`, each with the fields
/// kept as text (`step_text_fields`) read back (tools/workflows/read-data/recipe-rows.mjs `recipeFromRows`).
pub fn payload_from_rows(id: &str, row: &Value, step_rows: &[Value], order_field: &str, step_id_field: &str, step_text_fields: &[String], definition_field: &str) -> Result<Value, String> {
    let mut payload = json!({ "id": id, "label": row.get("title").or_else(|| row.get("label")).cloned().unwrap_or(Value::Null) });
    if let Some(definition) = parsed_field(row.get(definition_field).unwrap_or(&Value::Null))?.filter(|definition| object(definition)) {
        payload["definition"] = definition;
        return Ok(payload);
    }
    let mut ordered: Vec<&Value> = step_rows.iter().collect();
    ordered.sort_by(|a, b| a[order_field].as_f64().partial_cmp(&b[order_field].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
    let mut steps = Vec::new();
    for step in ordered {
        let mut made = json!({ "id": step[step_id_field], "title": step["title"], "do": step["do"] });
        for field in step_text_fields {
            if let Some(value) = parsed_field(step.get(field).unwrap_or(&Value::Null))? { made[field.as_str()] = value; }
        }
        steps.push(made);
    }
    if steps.is_empty() { return Err("the recipe row has no definition and no step rows".into()); }
    payload["steps"] = Value::Array(steps);
    Ok(payload)
}

/// Every recipe payload the tool folders under `packages` ship, by id, in folder then file name order; a later one of
/// the same id is left out, with one stderr line, so a reader never gets one of two at random.
pub fn shipped_recipes_in(packages: &Path) -> BTreeMap<String, Value> {
    let Ok(settings) = super::settings() else { return BTreeMap::new() };
    let shipped = &settings.shipped_recipes;
    let Ok(folders) = fs::read_dir(packages) else { return BTreeMap::new() };
    let mut names: Vec<_> = folders.filter_map(Result::ok).filter(|entry| entry.path().is_dir()).map(|entry| entry.file_name()).collect();
    names.sort();
    let mut found = BTreeMap::<String, Value>::new();
    let mut twice = Vec::new();
    for name in names {
        let Ok(files) = fs::read_dir(packages.join(&name).join(&shipped.dir)) else { continue };
        let mut files: Vec<PathBuf> = files.filter_map(Result::ok).map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "json")).collect();
        files.sort();
        for path in files {
            let mut bytes = Vec::new();
            let read = fs::File::open(&path).and_then(|file| file.take(shipped.max_bytes + 1).read_to_end(&mut bytes)).ok()
                .filter(|n| (*n as u64) <= shipped.max_bytes)
                .and_then(|_| serde_json::from_slice::<Value>(&bytes).ok());
            let Some(document) = read else { crate::quiet_eprintln!("shipped-recipes unreadable folder={}", name.to_string_lossy()); continue };
            for row in document.get(&shipped.rows).and_then(Value::as_array).into_iter().flatten() {
                let payload = &row[shipped.payload_field.as_str()];
                let Some(id) = payload.get(&shipped.id_field).and_then(Value::as_str) else { continue };
                if found.insert(id.to_string(), payload.clone()).is_some() { twice.push(id.to_string()); }
            }
        }
    }
    for id in twice {
        crate::quiet_eprintln!("shipped-recipes twice recipe={id}");
        found.remove(&id);
    }
    found
}

static KEPT: Mutex<Option<(PathBuf, BTreeMap<String, Value>)>> = Mutex::new(None);

/// The shipped recipes of the installed commit now, read once for it (one slot: a different commit replaces it).
pub fn shipped_recipes(state_root: &Path) -> BTreeMap<String, Value> {
    let Some(packages) = crate::tool_runs::tools::shipped().ok().and_then(|tools| tools.installed_tools(state_root)) else { return BTreeMap::new() };
    kept(&KEPT, &packages, shipped_recipes_in)
}

/// `read(packages)` kept in `slot` against the resolved path of `packages`: asked again for the same commit it is not
/// read again, for another it is read and replaces the one kept (invariant 4).
pub fn kept<T: Clone>(slot: &Mutex<Option<(PathBuf, T)>>, packages: &Path, read: impl Fn(&Path) -> T) -> T {
    let Ok(commit) = fs::canonicalize(packages) else { return read(packages) };
    let Ok(mut held) = slot.lock() else { return read(packages) };
    match held.as_ref() {
        Some((known, value)) if *known == commit => value.clone(),
        _ => { let value = read(packages); *held = Some((commit, value.clone())); value }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn made_up_folder(packages: &Path, dir: &str, recipes: Value) {
        let folder = packages.join("made-up").join(&super::super::settings().unwrap().shipped_recipes.dir);
        let _ = dir;
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("all.json"), json!({ "records": recipes }).to_string()).unwrap();
    }

    #[test]
    fn a_made_up_shipped_recipe_of_steps_or_of_a_definition_becomes_an_engine_definition() {
        let packages = tempfile::tempdir().unwrap();
        made_up_folder(packages.path(), "", json!([
            { "payload": { "id": "workflow:by-steps", "label": "By steps", "steps": [
                { "id": "one", "do": "say hello", "submit": { "type": "object" }, "checks": [{ "kind": "present", "says": "it said it" }] },
                { "id": "two", "do": "say bye", "run_tool": { "tool_id": "tool:made-up", "input": { "text": { "from": ["steps", "one", "text"] } } } } ] } },
            { "payload": { "id": "workflow:by-definition", "definition": { "steps": [{ "id": "a", "kind": "ask", "config": { "name": "ai" } }], "edges": [] } } },
            { "payload": { "id": "workflow:empty" } } ]));
        let found = shipped_recipes_in(packages.path());
        let steps = definition_of(&found["workflow:by-steps"]).unwrap();
        let ids: Vec<&str> = steps["steps"].as_array().unwrap().iter().map(|step| step["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["one", "one#checks", "two"]);
        assert_eq!(steps["steps"][2]["config"]["name"], "tool:made-up");
        assert_eq!(steps["steps"][2]["config"]["input"]["text"], json!({ "$kind": "binding", "values": ["steps", "one", "text"] }));
        assert_eq!(steps["edges"].as_array().unwrap().len(), 2);
        let given = definition_of(&found["workflow:by-definition"]).unwrap();
        assert_eq!(given["steps"][0]["config"]["context"]["step_id"], "a");
        assert!(definition_of(&found["workflow:empty"]).is_err());
    }

    #[test]
    fn a_recipe_row_kept_as_text_or_empty_beside_step_rows_is_read_back() {
        let text = json!({ "definition": "{\"steps\":[{\"id\":\"a\",\"kind\":\"ask\",\"config\":{\"name\":\"ai\"}}],\"edges\":[]}" });
        let payload = payload_from_rows("workflow:t", &text, &[], "position", "step", &[], "definition").unwrap();
        assert_eq!(definition_of(&payload).unwrap()["steps"][0]["id"], "a");
        let empty = json!({ "definition": "", "title": "T" });
        let rows = [json!({ "step": "second", "position": 2, "do": "b", "submit": "{\"type\":\"object\"}" }), json!({ "step": "first", "position": 1, "do": "a", "submit": "{}" })];
        let fields = vec!["submit".to_string(), "checks".to_string()];
        let payload = payload_from_rows("workflow:t", &empty, &rows, "position", "step", &fields, "definition").unwrap();
        let steps = definition_of(&payload).unwrap();
        assert_eq!(steps["steps"][0]["id"], "first");
        assert_eq!(steps["steps"][1]["config"]["context"]["submit"], json!({ "type": "object" }));
        assert!(payload_from_rows("workflow:t", &empty, &[], "position", "step", &fields, "definition").is_err());
        assert!(payload_from_rows("workflow:t", &json!({ "definition": "{not json" }), &[], "position", "step", &fields, "definition").is_err());
    }

    #[test]
    fn two_installed_commits_leave_one_kept_entry() {
        let slot = Mutex::new(None::<(PathBuf, u32)>);
        let (one, two) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let reads = Cell::new(0);
        let read = |_: &Path| { reads.set(reads.get() + 1); reads.get() };
        assert_eq!(kept(&slot, one.path(), read), 1);
        assert_eq!(kept(&slot, one.path(), read), 1, "the same commit is not read again");
        assert_eq!(kept(&slot, two.path(), read), 2);
        assert_eq!(kept(&slot, two.path(), read), 2);
        assert_eq!(slot.lock().unwrap().as_ref().map(|(path, _)| path.clone()), fs::canonicalize(two.path()).ok(), "one entry, the commit served last");
    }
}
