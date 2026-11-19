// The workflow engine (workflow-core) as one WebAssembly component the engine runs on any computer.
// In, on standard input: { "input": <the run>, "cause": <the cause the engine handed the run>, "context": <the task's context> }.
// The run is the tool's input. A listed workflow row runs with its id as `row` (the engine's `invoke_with`); its
// definition is that row's `payload.definition` in the workflow rows laid out with this tool (`rows_at`, recipes/*.json),
// and every other field is the workflow's own input. A run may instead carry its `definition` (or `definitions`, the
// first the one to run). `answers` (by step id), `start_at` (a step to start at), `started_at` and `run` are kept with it.
// Out, on standard output: { "result": { "status", "workflow", "run", "steps", "waiting" }, "wake_effects": [...] }.
// The engine replays the definition from the start with the answers held. A step whose answer is held is answered with
// it. Every other ask waits: one whose name is a tool id is handed back as a wake effect that runs that tool with the
// step's input and tells its result back as the fact `workflow-step-answered` (wake's `reply`), which runs this again
// with that answer. Any other name is told as the fact `workflow-step-waiting`, carrying what it asks, whom, and the
// envelope its answer is told back in (`told_as`); whatever the person's own wakes do with it (none, one or many) ends by
// telling `workflow-step-answered` with that envelope and the answer. This keeps nothing and names no store or tool:
// it starts what the engine can start and tells everything else. Nothing here knows what a step is for.
use std::{collections::{BTreeMap, BTreeSet}, io::Read, sync::{Arc, Mutex}};
use serde_json::{json, Map, Value};
use workflow_engine::Host;

const ANSWERED: &str = "workflow-step-answered";
const WAITING: &str = "workflow-step-waiting";
const ROWS_AT: &str = "/opt/workflows/recipes";
/// The fields of a run that are the run's own, not the workflow's input.
const KEPT: [&str; 9] = ["row", "definition", "definitions", "answers", "start_at", "started_at", "run", "refused", "rows_at"];

struct Held { answers: BTreeMap<String, Value>, refused: BTreeMap<String, String>, waiting: Mutex<Vec<Value>> }

#[async_trait::async_trait]
impl Host for Held {
    async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        let context: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
        let step = context["step_id"].as_str().unwrap_or_default().to_string();
        if let Some(why) = self.refused.get(&step) { return Err(why.clone()); }
        if let Some(answer) = self.answers.get(&step) { return Ok(serde_json::to_vec(answer).unwrap()); }
        let input: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        self.waiting.lock().unwrap().push(json!({ "step": step, "for": name, "asks": input }));
        Ok(serde_json::to_vec(&json!({ "$kind": workflow_core::executor::context::NOT_ANSWERED_YET, "step_id": step, "asked": name })).unwrap())
    }
    async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
}

fn fail(why: impl std::fmt::Display) -> ! {
    println!("{}", json!({ "error": why.to_string() }));
    std::process::exit(1);
}

/// The run this pass walks: the one a told answer carries back, with that answer added; else the tool's input, with the
/// fact that woke it (when one did) as `fact` and `fact_id` in the workflow's input.
fn the_run(given: &Value) -> (Map<String, Value>, BTreeMap<String, String>) {
    let detail = &given["cause"]["detail"];
    let mut refused = BTreeMap::new();
    if detail["kind"] == ANSWERED {
        let told = &detail["payload"];
        let mut run = told["run"].as_object().cloned().unwrap_or_else(|| fail("a told answer carries no run"));
        let step = told["step"].as_str().unwrap_or_else(|| fail("a told answer names no step")).to_string();
        if let Some(Value::Object(kept)) = run.get("refused") {
            for (step, why) in kept { refused.insert(step.clone(), why.as_str().unwrap_or_default().to_string()); }
        }
        match told.get("error") {
            Some(why) => {
                let said = told["said"].as_str().map(|said| format!(": {said}")).unwrap_or_default();
                refused.insert(step, format!("{} failed ({}){said}", told["for"].as_str().unwrap_or("its tool"), why.as_str().unwrap_or_default()));
            }
            None => { run.entry("answers").or_insert_with(|| json!({}))[&step] = told["result"].clone(); }
        }
        return (run, refused);
    }
    let input = given["input"].as_object().cloned().unwrap_or_default();
    let mut run: Map<String, Value> = input.iter().filter(|(field, _)| KEPT.contains(&field.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut own: Map<String, Value> = match input.get("input") {
        Some(Value::Object(own)) if !input.contains_key("row") => own.clone(),
        _ => input.iter().filter(|(field, _)| !KEPT.contains(&field.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect(),
    };
    if let Some(fact) = detail["payload"].as_object() {
        own.insert("fact".into(), Value::Object(fact.clone()));
        own.insert("fact_id".into(), detail["event_id"].clone());
        if detail["coalesced"].as_u64().is_some_and(|n| n > 0) {
            own.insert("folded".into(), detail["coalesced"].clone());
            own.insert("last".into(), detail["last"].clone());
        }
    }
    run.insert("input".into(), Value::Object(own));
    if run.get("run").is_none() {
        run.insert("run".into(), given["cause"]["key"].as_str().map(Value::from).unwrap_or_else(|| json!("run")));
    }
    (run, refused)
}

/// The definitions the run walks, the first the one it runs: the run's own, or its listed row's `payload.definition`.
fn definitions_of(run: &Map<String, Value>) -> Vec<Value> {
    if let Some(Value::Array(all)) = run.get("definitions") { if !all.is_empty() { return all.clone(); } }
    if let Some(definition) = run.get("definition").filter(|d| d.is_object()) { return with_used(definition.clone()); }
    let id = run.get("row").and_then(Value::as_str).unwrap_or_else(|| fail("the run names no definition and no workflow row"));
    let at = run.get("rows_at").and_then(Value::as_str).unwrap_or(ROWS_AT);
    let files = std::fs::read_dir(at).unwrap_or_else(|error| fail(format!("the workflow rows at {at} do not read: {error}")));
    let mut names: Vec<_> = files.flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|e| e == "json")).collect();
    names.sort();
    for path in names {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        if !text.contains(&format!("\"{id}\"")) { continue; }
        let Ok(file) = serde_json::from_str::<Value>(&text) else { continue };
        let records = file.get("records").and_then(Value::as_array).cloned().unwrap_or_else(|| file.as_array().cloned().unwrap_or_default());
        for record in records {
            let row = &record["payload"];
            if row["id"] != id { continue; }
            let mut definition = row["definition"].as_object().cloned().unwrap_or_else(|| fail(format!("{id} has no definition in the engine's shape yet")));
            definition.entry("id").or_insert_with(|| json!(id));
            definition.entry("name").or_insert_with(|| row["label"].clone());
            definition.entry("kind").or_insert_with(|| json!("workflow"));
            definition.entry("is_active").or_insert(json!(true));
            definition.entry("version").or_insert(json!(1));
            return with_used(Value::Object(definition));
        }
    }
    fail(format!("no workflow row {id} at {at}"))
}

fn with_used(definition: Value) -> Vec<Value> {
    let mut all = vec![definition.clone()];
    all.extend(definition["uses"].as_array().cloned().unwrap_or_default());
    all
}

/// A definition started at a later step (`start_at`) is the part of it reachable from that step.
fn started_at_step(mut definition: Value, step: &str) -> Value {
    let steps = definition["steps"].as_array().cloned().unwrap_or_default();
    if steps.first().is_some_and(|first| first["id"] == step) { return definition; }
    if !steps.iter().any(|candidate| candidate["id"] == step) { fail(format!("the workflow has no step {step} to start at")); }
    let edges = definition["edges"].as_array().cloned().unwrap_or_default();
    let mut reached = BTreeSet::from([step.to_string()]);
    loop {
        let more: Vec<String> = edges.iter().filter(|edge| edge["from"].as_str().is_some_and(|from| reached.contains(from)))
            .filter_map(|edge| edge["to"].as_str().map(str::to_owned)).filter(|to| !reached.contains(to)).collect();
        if more.is_empty() { break; }
        reached.extend(more);
    }
    let kept = |id: &Value| id.as_str().is_some_and(|id| reached.contains(id));
    definition["steps"] = Value::Array(steps.into_iter().filter(|candidate| kept(&candidate["id"])).collect());
    definition["edges"] = Value::Array(edges.into_iter().filter(|edge| kept(&edge["from"]) && kept(&edge["to"])).collect());
    definition
}

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).unwrap_or_else(|error| fail(error));
    let given: Value = serde_json::from_str(&text).unwrap_or_else(|error| fail(format!("the run is not JSON: {error}")));
    let (mut run, refused) = the_run(&given);
    let mut all = definitions_of(&run);
    if let Some(step) = run.get("start_at").and_then(Value::as_str) { all[0] = started_at_step(all[0].clone(), step); }
    let definitions: Vec<workflow_core::Definition> = all.into_iter()
        .map(|definition| serde_json::from_value(definition).unwrap_or_else(|error| fail(format!("a definition does not decode: {error}")))).collect();
    let id = definitions[0].id.clone();
    let answers: BTreeMap<String, Value> = serde_json::from_value(run.get("answers").cloned().unwrap_or(json!({}))).unwrap_or_default();
    let host = Arc::new(Held { answers, refused: refused.clone(), waiting: Mutex::new(vec![]) });
    // Who the run acts for: the task's actor, else its account; what a step no tool runs names as its answerer.
    let actor = given["context"]["actor"].as_str().or(given["context"]["account_id"].as_str()).or(run.get("actor").and_then(Value::as_str)).unwrap_or("person").to_string();
    run.insert("actor".into(), json!(actor));
    // The product word the engine's bounded answers carry: the run's own, else the task context's; a shared tool names none.
    let product_word = run.get("product_word").and_then(Value::as_str).or(given["context"]["product_word"].as_str()).unwrap_or("workflow").to_string();
    let started = run.get("started_at").and_then(Value::as_str).map(str::to_owned)
        .or_else(|| given["cause"]["at_ms"].as_u64().map(|ms| chrono::DateTime::from_timestamp_millis(ms as i64).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()))
        .unwrap_or_default();
    run.insert("started_at".into(), json!(started));
    let walked = futures::executor::block_on(workflow_engine::run_definition_with_started_at(
        definitions, &id, run.get("input").cloned().unwrap_or(json!({})), &actor, &product_word, &started, host.clone()))
        .unwrap_or_else(|error| fail(error));
    if !refused.is_empty() { run.insert("refused".into(), json!(refused)); }
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run").to_string();
    let steps: BTreeMap<String, Value> = walked["execution_context"]["steps"].as_object()
        .map(|all| all.iter().map(|(k, v)| (k.clone(), json!({ "status": v["status"], "output": v["output"], "error": v["error"] }))).collect()).unwrap_or_default();
    let waiting = host.waiting.lock().unwrap().clone();
    // Each waiting step says how its answer is told back: this run with that step named, under the workflow's id, which
    // the listed row's wake matches.
    let told_as = |step: &Value, name: &Value| json!({ "source": ANSWERED, "event_id": format!("{run_id}:{}", step.as_str().unwrap_or_default()),
        "payload": { "workflow": id, "run": run, "step": step, "for": name } });
    // A name the engine can start (a tool id) is started with a reply; every other ask is told as a fact.
    let effects: Vec<Value> = waiting.iter().map(|w| {
        let told = told_as(&w["step"], &w["for"]);
        if w["for"].as_str().is_some_and(|name| name.starts_with("tool:")) {
            json!({ "wake": { "tool": w["for"], "input": w["asks"], "reply": told } })
        } else {
            json!({ "arrive": { "source": WAITING, "event_id": told["event_id"], "payload": { "workflow": id, "step": w["step"], "for": w["for"], "asks": w["asks"], "told_as": told } } })
        }
    }).collect();
    let waiting: Vec<Value> = waiting.into_iter().map(|mut w| { w["told_as"] = told_as(&w["step"], &w["for"]); w }).collect();
    println!("{}", json!({ "result": { "status": walked["status"], "workflow": id, "run": run_id, "steps": steps, "waiting": waiting }, "wake_effects": effects }));
}
