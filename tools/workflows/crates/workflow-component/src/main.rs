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
// with that answer. A name the run's own door answers (ask-rights.json `asks`, tools:list) is handed back as the engine's
// door effect, made as the run's own party and told back the same way. Any other name is told as the fact `workflow-step-waiting`, carrying what it asks, whom, and the
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
/// The asks a step may make of its run's own door, as DATA (tools/workflows/ask-rights.json `asks`, fingerprinted with this
/// crate through Cargo.toml's compiled-module source-files): each is handed back as the engine's door effect
/// (trillion-rust src/wake.rs `Effect::Door`), which makes it as the run's party and tells its answer back as a tool's is.
/// `wake:arrive` among them is answered here (`TELL`).
const ASK_RIGHTS: &str = include_str!("../../../ask-rights.json");
/// The most bytes (as JSON) the run may be when a step's answer is held with it: every later envelope carries the whole run
/// (its definition and every held answer), so a step whose answer takes the run past this is refused at that step. The run's
/// input or definition `most_answer_bytes` overrides it.
const MOST_ANSWER_BYTES: usize = 32 * 1024;

/// The bound on one held answer: the run's input's `most_answer_bytes`, else its definition's, else `MOST_ANSWER_BYTES`.
fn most_answer_bytes(run: &Map<String, Value>) -> usize {
    let definition = run.get("definition").or_else(|| run.get("definitions").and_then(|all| all.get(0)));
    run.get("input").and_then(|input| input.get("most_answer_bytes"))
        .or_else(|| definition.and_then(|definition| definition.get("most_answer_bytes")))
        .and_then(Value::as_u64)
        .map_or(MOST_ANSWER_BYTES, |bytes| bytes as usize)
}

/// The names in `ASK_RIGHTS` the door makes for a run: every declared ask but `TELL`.
fn door_asks() -> BTreeSet<String> {
    let rights: Value = serde_json::from_str(ASK_RIGHTS).unwrap_or_else(|error| fail(format!("ask-rights.json does not read: {error}")));
    rights["asks"].as_object().map(|asks| asks.keys().filter(|name| *name != TELL).cloned().collect()).unwrap_or_default()
}

/// The effect one waiting step is handed out as, told back as `told`: a tool id starts that tool (a step whose input is
/// exactly the door's call shape asks the tool's session one question, wake's `call`); a name the run's door answers is
/// the engine's door effect; any other ask is told as the fact `workflow-step-waiting` for whoever answers it.
fn effect_of(waiting: &Value, told: Value, doors: &BTreeSet<String>, workflow: &str) -> Value {
    let name = waiting["for"].as_str().unwrap_or_default();
    if name.starts_with("tool:") {
        return match waiting["asks"].as_object().filter(|asks| asks.len() == 1).and_then(|asks| asks.get("call")) {
            Some(call) => json!({ "wake": { "tool": name, "call": call, "reply": told } }),
            None => json!({ "wake": { "tool": name, "input": waiting["asks"], "reply": told } }),
        };
    }
    if doors.contains(name) {
        return json!({ "door": { "name": name, "input": waiting["asks"], "reply": told } });
    }
    json!({ "arrive": { "source": WAITING, "event_id": told["event_id"], "payload": { "workflow": workflow, "step": waiting["step"], "for": name, "asks": waiting["asks"], "told_as": told } } })
}

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
    // This run holds no store, so a read step is refused in plain words (its declared fallback answers, else it fails):
    // never an empty answer that a check could take for a row. A workflow reads through a step that names its reader.
    async fn read(&self, from: &str) -> Result<Vec<u8>, String> {
        Err(format!("this run reads no store, so {from} was not read: read it in a step that names the tool that reads it"))
    }
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
            None => {
                // The envelope every later step carries is the whole run, so the bound counts the run with this answer held.
                let most = most_answer_bytes(&run);
                let mut held = run.clone();
                held.entry("answers").or_insert_with(|| json!({}))[&step] = told["result"].clone();
                let bytes = Value::Object(held.clone()).to_string().len();
                if bytes > most {
                    refused.insert(step, format!("the run would carry {bytes} bytes with this step's answer; filter the answer to what the next step needs (at most {most} bytes are carried)"));
                } else {
                    run = held;
                }
            }
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
        // are the run's. Its `input` (the person's own settings for that workflow, from their row's condition) is spread
        // into the workflow's input, and the rest of the fact is the workflow's input as `fact`.
        let mut fact = fact.clone();
        for field in ["definition", "start_at"] {
            if let Some(value) = fact.remove(field) {
                run.entry(field.to_string()).or_insert(value);
            }
        }
        if let Some(Value::Object(settings)) = fact.remove("input") {
            for (field, value) in settings { own.insert(field, value); }
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
    // A name the engine can start (a tool id) or make (a door ask) is handed back with a reply; every other ask is told as
    // a fact.
    // One waiting step is handed out per pass, the first the walk reached. The run is carried in each answer's envelope
    // and kept nowhere else, so two steps handed out together would each come back with the run as it stood before
    // either answered, and the second answer back would lose the first. The next pass hands out the next one.
    let mut effects: Vec<Value> = told.into_iter().map(|(_, _, fact)| fact).collect();
    let doors = door_asks();
    effects.extend(waiting.iter().take(1).map(|w| effect_of(w, told_as(&w["step"], &w["for"]), &doors, &id)));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn held() -> Arc<Held> {
        Arc::new(Held { run: "r".into(), answers: BTreeMap::new(), refused: BTreeMap::new(), waiting: Mutex::new(vec![]), told: Mutex::new(vec![]) })
    }

    // A check that a row exists can never pass on a row this run could not read: the read is refused, and the walk fails.
    #[test]
    fn a_read_of_a_missing_row_fails_the_run_in_plain_words() {
        let refused = futures::executor::block_on(held().read("row:missing")).unwrap_err();
        assert!(refused.contains("reads no store") && refused.contains("row:missing"), "{refused}");
        let definition: workflow_core::Definition = serde_json::from_value(json!({ "id": "check", "name": "check", "kind": "workflow",
            "is_active": true, "version": 1, "edges": [], "steps": [{ "id": "exists", "kind": "read", "config": { "from": "row:missing" } }] })).unwrap();
        let walked = futures::executor::block_on(workflow_engine::run_definition_with_started_at(
            vec![definition], "check", json!({}), "someone", "workflow", "2026-11-19T00:00:00Z", held())).unwrap();
        assert_eq!(walked["status"], "failed", "{walked}");
        assert!(walked["error_message"].as_str().unwrap_or_default().contains("reads no store"), "{walked}");
    }

    // Two steps waiting at once are handed out one per pass, so the second answer back carries the first.
    #[test]
    fn steps_waiting_together_are_handed_out_one_per_pass() {
        let loop_of_two = json!({ "id": "two", "name": "two", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "each", "kind": "loop", "config": { "source": { "$kind": "binding", "select": { "from": "input", "path": "items" } },
                "item_var": "item", "definition_id": "one", "parallel": true } }], "edges": [],
            "uses": [{ "id": "one", "name": "one", "kind": "workflow", "is_active": true, "version": 1, "edges": [],
                "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "tool:x", "context": { "step_id": "ask" },
                    "input": { "item": { "$kind": "binding", "select": { "from": "loop", "path": "item" } } } } }] }] });
        let pass = |answers: Value| {
            let given = json!({ "input": { "definition": loop_of_two, "items": ["a", "b"], "answers": answers }, "cause": { "key": "k" }, "context": {} });
            let (run, refused) = the_run(&given);
            let mut all = definitions_of(&run);
            let definitions: Vec<workflow_core::Definition> = all.drain(..).map(|d| serde_json::from_value(d).unwrap()).collect();
            let host = Arc::new(Held { run: "k".into(), answers: serde_json::from_value(run["answers"].clone()).unwrap_or_default(), refused, waiting: Mutex::new(vec![]), told: Mutex::new(vec![]) });
            futures::executor::block_on(workflow_engine::run_definition_with_started_at(definitions, "two", run["input"].clone(), "someone", "workflow", "2026-11-20T00:00:00Z", host.clone())).unwrap();
            let waiting = host.waiting.lock().unwrap().clone();
            waiting
        };
        assert_eq!(pass(json!({})).len(), 2, "the walk reaches both items");
        assert_eq!(pass(json!({ "each_iter_0/ask": 1 })).len(), 1, "an answered item stops waiting");
        assert!(pass(json!({ "each_iter_0/ask": 1, "each_iter_1/ask": 2 })).is_empty());
    }

    // A step's answer that takes the run (its definition and every held answer) past its bound is refused at that step in
    // plain words and is not held, so no later envelope carries it; an answer within the bound is held as before.
    fn told_answer(run: Value, result: Value) -> Value {
        json!({ "input": { "definition": {}, "answers": {} }, "cause": { "key": "k", "detail": { "kind": ANSWERED, "payload": {
            "workflow": "w", "run": run, "step": "fetch", "for": "tool:run-a-composio-action", "result": result } } }, "context": {} })
    }

    #[test]
    fn a_held_answer_over_its_bound_is_refused_at_its_step_and_not_carried() {
        let big = json!({ "text": "x".repeat(MOST_ANSWER_BYTES) });
        let (run, refused) = the_run(&told_answer(json!({ "input": {} }), big));
        assert!(refused["fetch"].contains("filter the answer to what the next step needs"), "{refused:?}");
        assert!(run.get("answers").is_none_or(|answers| answers.get("fetch").is_none()), "{run:?}");
    }

    // Each answer is within the bound on its own, but the run with all of them is not: the last one is refused, so the
    // envelope never carries more than the bound.
    #[test]
    fn many_small_answers_together_past_the_bound_refuse_the_step_that_takes_the_run_over() {
        let small = json!({ "text": "y".repeat(300) });
        let run = json!({ "input": { "most_answer_bytes": 1000 }, "answers": { "one": small.clone(), "two": small.clone() } });
        let (held, refused) = the_run(&told_answer(run.clone(), small.clone()));
        assert!(refused["fetch"].contains("the run would carry") && refused["fetch"].contains("at most 1000 bytes"), "{refused:?}");
        assert!(held.get("answers").is_some_and(|answers| answers.get("fetch").is_none()), "{held:?}");
        let (held, refused) = the_run(&told_answer(json!({ "input": { "most_answer_bytes": 2000 }, "answers": { "one": small.clone(), "two": small.clone() } }), small));
        assert!(refused.is_empty(), "{refused:?}");
        assert!(held["answers"]["fetch"].is_object(), "{held:?}");
    }

    #[test]
    fn an_answer_within_its_bound_is_held_with_the_run() {
        let (run, refused) = the_run(&told_answer(json!({ "input": {} }), json!({ "rows": [1, 2] })));
        assert!(refused.is_empty(), "{refused:?}");
        assert_eq!(run["answers"]["fetch"], json!({ "rows": [1, 2] }));
    }

    #[test]
    fn the_bound_is_read_from_the_run_input_or_its_definition_when_given() {
        let small = json!({ "rows": "0123456789012345678901234567890123456789" });
        let by_input = the_run(&told_answer(json!({ "input": { "most_answer_bytes": 10 } }), small.clone())).1;
        assert!(by_input["fetch"].contains("at most 10 bytes"), "{by_input:?}");
        let by_definition = the_run(&told_answer(json!({ "input": {}, "definition": { "most_answer_bytes": 10 } }), small)).1;
        assert!(by_definition["fetch"].contains("at most 10 bytes"), "{by_definition:?}");
    }

    // A step that asks a door operation the run's door answers (tools:list) is handed back as the door effect with its
    // reply, never told as a person's ask; a tool id still starts the tool, and any other name still waits for its answerer.
    #[test]
    fn a_door_ask_is_handed_back_as_the_door_effect_not_a_persons_ask() {
        let doors = door_asks();
        assert!(doors.contains("tools:list") && !doors.contains(TELL), "{doors:?}");
        let told = json!({ "source": ANSWERED, "event_id": "r:read" });
        let waiting = |name: &str| json!({ "step": "read", "for": name, "asks": { "tool": "tool:x" } });
        assert_eq!(effect_of(&waiting("tools:list"), told.clone(), &doors, "w"),
            json!({ "door": { "name": "tools:list", "input": { "tool": "tool:x" }, "reply": told } }));
        assert_eq!(effect_of(&waiting("tool:x"), told.clone(), &doors, "w")["wake"]["tool"], "tool:x");
        assert_eq!(effect_of(&waiting("anyone"), told.clone(), &doors, "w")["arrive"]["source"], WAITING);
    }

    // Each loop item waits under its own place in the run, and a top-level step under its own id.
    #[test]
    fn a_nested_ask_waits_under_its_place_in_the_run() {
        let nested = json!({ "step_id": "tell", "_runtime_identity": [json!({ "iteration": "each_iter_1", "definition_id": "x" }).to_string(), "tell"] });
        assert_eq!(step_of(&nested), "each_iter_1/tell");
        assert_eq!(step_of(&json!({ "step_id": "pick" })), "pick");
    }
}
