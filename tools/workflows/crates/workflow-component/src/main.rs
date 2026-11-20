// The workflow engine (workflow-core) as one WebAssembly component the engine runs on any computer.
// In, on standard input: { "input": <the run>, "cause": <the cause the engine handed the run>, "context": <the task's context> }.
// The run is the tool's input: its `definition` (or `definitions`, the first the one to run), handed in by whatever
// started it from where the person keeps their workflows (their own database): in the input, or in the fact that woke
// it (the router's workflow-chosen carries the chosen row's `definition` and `start_at`). This reads no file and no
// store, so no person's workflows depend on a shared folder. Every other field is the workflow's own input; `answers` (by step id),
// `start_at` (a step to start at), `started_at` and `run` are kept with it.
// Out, on standard output: { "result": { "status", "workflow", "run", "steps", "waiting" }, "wake_effects": [...] };
// a walk that failed prints { "error", "result" } and exits 1.
// The engine replays the definition from the start with the answers held. A step whose answer is held is answered with
// it. Every other ask waits: one whose name is a tool id is handed back as a wake effect that runs that tool with the
// step's input and tells its result back as the fact `workflow-step-answered` (wake's `reply`), which runs this again
// with that answer. Any other name is told as the fact `workflow-step-waiting`, carrying what it asks, whom, and the
// envelope its answer is told back in (`told_as`); whatever the person's own wakes do with it (none, one or many) ends by
// telling `workflow-step-answered` with that envelope and the answer. A step that asks `wake:arrive` (the engine's own
// operation) is answered at once and told as the fact it gives ({kind, event_id?, payload}) when the run ends. A step
// inside a loop or a used workflow is waited on under its place in the run, so each item is a step of its own.
// This keeps nothing and names no store or tool:
// it starts what the engine can start and tells everything else. Nothing here knows what a step is for.
use std::{collections::{BTreeMap, BTreeSet}, io::Read, sync::{Arc, Mutex}};
use serde_json::{json, Map, Value};
use workflow_engine::Host;

const ANSWERED: &str = "workflow-step-answered";
const WAITING: &str = "workflow-step-waiting";
/// The engine's own operation for telling a fact: a step that asks it is told as that fact when the run ends.
const TELL: &str = "wake:arrive";
/// The fields of a run that are the run's own, not the workflow's input.
const KEPT: [&str; 8] = ["row", "definition", "definitions", "answers", "start_at", "started_at", "run", "refused"];

struct Held { run: String, answers: BTreeMap<String, Value>, refused: BTreeMap<String, String>, waiting: Mutex<Vec<Value>>, told: Mutex<Vec<(String, Value, Value)>> }

/// The step an ask is answered under: its place in the run (`_runtime_identity`, which the engine makes distinct for
/// each loop iteration and nested workflow, and the same on every replay) when it is nested, else its own step id. So
/// each item of a loop waits, and is answered, as a step of its own.
fn step_of(context: &Value) -> String {
    let own = context["step_id"].as_str();
    let Some(path) = context["_runtime_identity"].as_array().filter(|path| !path.is_empty()) else { return own.unwrap_or_default().to_string() };
    let place = |part: &Value| {
        let text = part.as_str().unwrap_or_default();
        serde_json::from_str::<Value>(text).ok()
            .and_then(|at| at["iteration"].as_str().or(at["action"].as_str()).map(str::to_owned))
            .unwrap_or_else(|| text.to_string())
    };
    let mut parts: Vec<String> = path[..path.len() - 1].iter().map(place).collect();
    parts.push(own.map(str::to_owned).unwrap_or_else(|| place(&path[path.len() - 1])));
    parts.join("/")
}

#[async_trait::async_trait]
impl Host for Held {
    async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        let context: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
        let step = step_of(&context);
        if let Some(why) = self.refused.get(&step) { return Err(why.clone()); }
        if let Some(answer) = self.answers.get(&step) { return Ok(serde_json::to_vec(answer).unwrap()); }
        let input: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        // A step that asks the engine to tell a fact is answered at once: the fact is told when this run ends, and its
        // answer is held with the run, so a later pass replays it without telling it again.
        if name == TELL {
            let kind = input["kind"].as_str().filter(|kind| !kind.is_empty()).ok_or("a told fact names no kind")?;
            let event_id = input["event_id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{}:{step}", self.run));
            let answer = json!({ "told": true, "kind": kind, "event_id": event_id });
            let fact = json!({ "arrive": { "source": kind, "event_id": event_id, "payload": input.get("payload").cloned().unwrap_or(json!({})) } });
            self.told.lock().unwrap().push((step, answer.clone(), fact));
            return Ok(serde_json::to_vec(&answer).unwrap());
        }
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
        // A fact that chose a workflow (the router's) carries the chosen row's definition and the step to start at; they
        // are the run's, and the rest of the fact is the workflow's input as `fact`.
        let mut fact = fact.clone();
        for field in ["definition", "start_at"] {
            if let Some(value) = fact.remove(field) {
                run.entry(field.to_string()).or_insert(value);
            }
        }
        let fact = &fact;
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

/// The definitions the run walks, the first the one it runs: the ones handed in with it.
fn definitions_of(run: &Map<String, Value>) -> Vec<Value> {
    if let Some(Value::Array(all)) = run.get("definitions") { if !all.is_empty() { return all.clone(); } }
    if let Some(definition) = run.get("definition").filter(|d| d.is_object()) { return with_used(definition.clone()); }
    fail("the run carries no definition: whatever starts it hands in the workflow's definition from where the person keeps it")
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
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run").to_string();
    let host = Arc::new(Held { run: run_id.clone(), answers, refused: refused.clone(), waiting: Mutex::new(vec![]), told: Mutex::new(vec![]) });
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
    // What this pass told is held as answered, so the next pass replays it and tells nothing again.
    let told = host.told.lock().unwrap().clone();
    for (step, answer, _) in &told { run.entry("answers").or_insert_with(|| json!({}))[step] = answer.clone(); }
    let steps: BTreeMap<String, Value> = walked["execution_context"]["steps"].as_object()
        .map(|all| all.iter().map(|(k, v)| (k.clone(), json!({ "status": v["status"], "output": v["output"], "error": v["error"] }))).collect()).unwrap_or_default();
    let waiting = host.waiting.lock().unwrap().clone();
    // Each waiting step says how its answer is told back: this run with that step named, under the workflow's id, which
    // the listed row's wake matches.
    let told_as = |step: &Value, name: &Value| json!({ "source": ANSWERED, "event_id": format!("{run_id}:{}", step.as_str().unwrap_or_default()),
        "payload": { "workflow": id, "run": run, "step": step, "for": name } });
    // A name the engine can start (a tool id) is started with a reply; every other ask is told as a fact.
    let mut effects: Vec<Value> = told.into_iter().map(|(_, _, fact)| fact).collect();
    effects.extend(waiting.iter().map(|w| {
        let told = told_as(&w["step"], &w["for"]);
        if w["for"].as_str().is_some_and(|name| name.starts_with("tool:")) {
            // A step whose input is exactly the door's call shape asks the tool's session one question (wake's `call`).
            match w["asks"].as_object().filter(|asks| asks.len() == 1).and_then(|asks| asks.get("call")) {
                Some(call) => json!({ "wake": { "tool": w["for"], "call": call, "reply": told } }),
                None => json!({ "wake": { "tool": w["for"], "input": w["asks"], "reply": told } }),
            }
        } else {
            json!({ "arrive": { "source": WAITING, "event_id": told["event_id"], "payload": { "workflow": id, "step": w["step"], "for": w["for"], "asks": w["asks"], "told_as": told } } })
        }
    }));
    let waiting: Vec<Value> = waiting.into_iter().map(|mut w| { w["told_as"] = told_as(&w["step"], &w["for"]); w }).collect();
    let result = json!({ "status": walked["status"], "workflow": id, "run": run_id, "steps": steps, "waiting": waiting });
    // A walk that failed is a failed run: it ends with exit 1 and the engine's words, so the wake that started it is
    // marked failed (and tells its failed fact) instead of ran, and whoever waits on its told answer hears the failure.
    if walked["status"] == "failed" {
        let why = walked["error_message"].as_str().unwrap_or("the workflow failed");
        println!("{}", json!({ "error": format!("{id}: {why}"), "result": result }));
        std::process::exit(1);
    }
    println!("{}", json!({ "result": result, "wake_effects": effects }));
}
