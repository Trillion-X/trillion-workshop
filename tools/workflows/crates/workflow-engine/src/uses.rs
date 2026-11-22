// crates/workflow-engine/src/uses.rs
//
// Purpose:
//   The definitions a run may reach, as one list the engine's store is filled from: the workflow itself, every workflow in
//   its `uses`, and every workflow in each of those workflows' own `uses`, at any depth. A loop or action step names the
//   workflow it runs by `definition_id`; the engine finds it only in this list, so a body kept in a sub-workflow's own
//   `uses` is found as surely as one in the top workflow's. What a run names but no `uses` holds (`missing`) is read from
//   the person's own workflow rows by whoever starts the run (the workflow component's reader, wf's own stores).
//
// Non-Negotiable Invariants:
//   1. Each id is one definition: the same id given twice with different definitions is refused, naming both places,
//      never quietly one of them.
//   2. Nothing here names a store or a tool: the starter reads what is missing in its own way.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use workflow_core::{CachedDefinitionStore, Definition, DefinitionStore, EntityId, WorkflowResult};

/// The run's definition store, which notes every workflow a step asked for and did not find (`missed`): a run that named
/// one no uses holds (chosen at run time, from its input or a row) answers them, so its starter can read them from the
/// person's own rows and walk the run again (the walk replays from its held answers).
pub struct Noted { inner: Arc<CachedDefinitionStore>, missed: Mutex<BTreeSet<String>> }

impl Noted {
    pub fn new(inner: Arc<CachedDefinitionStore>) -> Self { Self { inner, missed: Mutex::new(BTreeSet::new()) } }

    /// The workflows a step asked for that the store did not hold, in id order.
    pub fn missed(&self) -> Vec<String> { self.missed.lock().unwrap().iter().cloned().collect() }

    fn note<T>(&self, id: &str, found: WorkflowResult<Option<T>>) -> WorkflowResult<Option<T>> {
        if matches!(found, Ok(None)) { self.missed.lock().unwrap().insert(id.to_string()); }
        found
    }
}

impl DefinitionStore for Noted {
    fn get_by_id(&self, id: &str, partition_key: &str) -> WorkflowResult<Option<Definition>> {
        self.note(id, self.inner.get_by_id(id, partition_key))
    }
    fn get_by_id_shared(&self, id: &str, partition_key: &str) -> WorkflowResult<Option<Arc<Definition>>> {
        self.note(id, self.inner.get_by_id_shared(id, partition_key))
    }
    fn get_by_slug(&self, slug: &str, partition_key: &str) -> WorkflowResult<Option<Definition>> {
        self.inner.get_by_slug(slug, partition_key)
    }
    fn get_active(&self, partition_key: &str, kind: Option<&str>) -> WorkflowResult<Vec<Definition>> {
        self.inner.get_active(partition_key, kind)
    }
    fn get_by_trigger(&self, trigger_source: &str, partition_key: &str) -> WorkflowResult<Vec<Definition>> {
        self.inner.get_by_trigger(trigger_source, partition_key)
    }
    fn get_participant_ids(&self, interaction_id: &str, partition_key: &str) -> WorkflowResult<Vec<EntityId>> {
        self.inner.get_participant_ids(interaction_id, partition_key)
    }
}

/// The workflow and every workflow in its `uses` at any depth, the workflow first, each id once. Refused, naming both
/// places, when one id is given twice with different definitions.
pub fn with_uses(definition: Value) -> Result<Vec<Value>, String> {
    let mut all: Vec<Value> = Vec::new();
    let mut seen: BTreeMap<String, (String, usize)> = BTreeMap::new();
    let mut todo: Vec<(Value, String)> = vec![(definition, "the run".to_string())];
    while let Some((definition, place)) = todo.pop() {
        let id = definition["id"].as_str().unwrap_or_default().to_string();
        let mut bare = definition.clone();
        if let Some(fields) = bare.as_object_mut() { fields.remove("uses"); }
        if let Some((first, at)) = seen.get(&id) {
            let mut held = all[*at].clone();
            if let Some(fields) = held.as_object_mut() { fields.remove("uses"); }
            if held != bare {
                return Err(format!("{id} is given twice with different definitions: in {first} and in {place}; keep one"));
            }
            continue;
        }
        seen.insert(id.clone(), (place, all.len()));
        let inner = format!("{id}'s uses");
        let used = definition["uses"].as_array().cloned().unwrap_or_default();
        all.push(definition);
        // Reversed onto the stack, so the uses are walked in the order they are written.
        for used in used.into_iter().rev() { todo.push((used, inner.clone())); }
    }
    Ok(all)
}

/// The workflow ids the steps of `all` name by a literal `definition_id` (or list in `definition_refs`) that none of `all`
/// is: what the starter reads from the person's own workflow rows.
pub fn missing(all: &[Value]) -> BTreeSet<String> {
    let have: BTreeSet<&str> = all.iter().filter_map(|definition| definition["id"].as_str()).collect();
    let mut named = BTreeSet::new();
    for definition in all {
        for step in definition["steps"].as_array().into_iter().flatten() {
            if let Some(id) = step["config"]["definition_id"].as_str() { named.insert(id.to_string()); }
            // A family (`prefix*`) names no one workflow: its members are read when a run chooses one (`Noted`).
            for id in step["config"]["definition_refs"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|id| !id.ends_with('*')) {
                named.insert(id.to_string());
            }
        }
    }
    named.into_iter().filter(|id| !id.is_empty() && !have.contains(id.as_str())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn runs(id: &str, body: &str) -> Value {
        json!({ "id": id, "steps": [{ "id": "each", "kind": "loop", "config": { "definition_id": body } }] })
    }

    #[test]
    fn a_body_in_a_sub_workflows_own_uses_is_reached() {
        let mut sub = runs("workflow:sub", "workflow:body");
        sub["uses"] = json!([{ "id": "workflow:body", "steps": [] }]);
        let mut top = runs("workflow:top", "workflow:sub");
        top["uses"] = json!([sub]);
        let all = with_uses(top).unwrap();
        let ids: Vec<&str> = all.iter().map(|d| d["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["workflow:top", "workflow:sub", "workflow:body"]);
        assert!(missing(&all).is_empty());
    }

    #[test]
    fn an_id_no_uses_holds_is_missing_and_a_bound_choice_lists_its_candidates() {
        let mut top = runs("workflow:top", "workflow:row-chosen");
        top["steps"].as_array_mut().unwrap().push(json!({ "id": "pick", "kind": "action",
            "config": { "definition_id": { "$kind": "binding" }, "definition_refs": ["workflow:a", "workflow:top"] } }));
        assert_eq!(missing(&with_uses(top).unwrap()), BTreeSet::from(["workflow:a".to_string(), "workflow:row-chosen".to_string()]));
    }

    #[test]
    fn one_id_with_two_definitions_is_refused_naming_both_places() {
        let mut sub = runs("workflow:sub", "workflow:body");
        sub["uses"] = json!([{ "id": "workflow:body", "steps": [{ "id": "b" }] }]);
        let mut top = runs("workflow:top", "workflow:sub");
        top["uses"] = json!([{ "id": "workflow:body", "steps": [] }, sub]);
        let why = with_uses(top).unwrap_err();
        assert!(why.contains("workflow:body") && why.contains("workflow:top's uses") && why.contains("workflow:sub's uses"), "{why}");
        let mut same = runs("workflow:top", "workflow:sub");
        let mut sub = runs("workflow:sub", "workflow:body");
        sub["uses"] = json!([{ "id": "workflow:body", "steps": [] }]);
        same["uses"] = json!([{ "id": "workflow:body", "steps": [] }, sub]);
        assert_eq!(with_uses(same).unwrap().len(), 3, "the same definition twice is one");
    }
}
