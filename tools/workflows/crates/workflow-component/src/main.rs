// The workflow engine (workflow-core) as one WebAssembly component the engine runs on any computer.
// In, on standard input: { "input": <the run>, "cause": <the cause the engine handed the run>, "context": <the task's context> }.
// The run is the tool's input: its `definition` (or `definitions`, the first the one to run), handed in by whatever
// started it from where the person keeps their workflows (their own database): in the input, or in the fact that woke
// it (the router's workflow-chosen carries the chosen row's `definition` and `start_at`). This reads no file and no
// store, so no person's workflows depend on a shared folder. A run named only by its recipe id (`recipe`, or the listed
// row's id `row` the engine hands a listed workflow's run) reads its definition first, through the step the run is
// handed as `read_definition` {tool, input, recipe_at, definition_at, version_at?, step?} (a row source's `listed_input`
// declares it once, trillion-rust catalog.rs): its answer is used for that pass alone and never carried, so a definition
// of any size (x-mode's is 655 KB) never rides in an envelope or the wake book, and each pass reads it again. The first
// read pins it: the BLAKE3 of the definition (and its version, when the reader names one) is held as that step's answer,
// and a later read that differs fails the run, naming the change, unless the run says `definition_may_move`. Every other field is the workflow's own input; `answers` (by step id),
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
/// The fields of an ask's input that hold words for whoever answers it, as DATA (tools/workflows/ask-words.json `keys`,
/// fingerprinted like `ASK_RIGHTS`): a {key} in them is filled before the ask goes out (`fill_ask_words`).
const ASK_WORDS: &str = include_str!("../../../ask-words.json");
/// How a run's end is recorded when the run names no `on_end` of its own (tools/workflows/run-end.json, fingerprinted like
/// `ASK_RIGHTS`): the recorder every pass that ends a run asks, whichever wake drove it (`end_effect`).
const RUN_END: &str = include_str!("../../../run-end.json");
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

/// The fields `ASK_WORDS` names.
fn words_keys() -> BTreeSet<String> {
    let words: Value = serde_json::from_str(ASK_WORDS).unwrap_or_else(|error| fail(format!("ask-words.json does not read: {error}")));
    words["keys"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// An ask's input with each {key} in a text under a words field (at any depth) filled from the ask's own input, else the
/// run input's, else an earlier step's answer (`answers`, by step id): a text as it is, any other value as its JSON. A key
/// is a name ([a-z_][a-z0-9_-]*, as step ids are) with dotted parts after it (`{read-hosts.hosts}`, `{store.credential_name}`), read the way
/// a reader's paths are (at_path). `{{` is a literal brace. A {key} none of them holds is listed, and the ask that names it
/// is refused in words (Held::ask), never sent with a literal brace. Nothing outside a words field is touched.
fn fill_ask_words(asks: &Value, run_input: &Value, answers: &Value, keys: &BTreeSet<String>) -> (Value, Vec<String>) {
    fn value_of(holders: [&Value; 3], key: &str) -> Option<String> {
        holders.into_iter().find_map(|holder| at_path(holder, key).filter(|value| !value.is_null()))
            .map(|value| value.as_str().map_or_else(|| value.to_string(), str::to_owned))
    }
    fn filled(text: &str, holders: [&Value; 3], unfilled: &mut BTreeSet<String>) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            if after.starts_with('{') { out.push('{'); rest = &after[1..]; continue; }
            let first = after.find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')).unwrap_or(after.len());
            let mut name_end = first;
            while after[name_end..].starts_with('.') {
                let part = after[name_end + 1..].find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'))
                    .unwrap_or(after.len() - name_end - 1);
                if part == 0 { break; }
                name_end += 1 + part;
            }
            let name = &after[..name_end];
            let named = name.starts_with(|c: char| c.is_ascii_lowercase() || c == '_') && after[name_end..].starts_with('}');
            if !named { out.push('{'); rest = after; continue; }
            match value_of(holders, name) {
                Some(value) => out.push_str(&value),
                None => { unfilled.insert(name.to_string()); out.push_str(&rest[open..open + name_end + 2]); }
            }
            rest = &after[name_end + 1..];
        }
        out.push_str(rest);
        out
    }
    fn walk(value: &Value, words: bool, holders: [&Value; 3], keys: &BTreeSet<String>, unfilled: &mut BTreeSet<String>) -> Value {
        match value {
            Value::Object(fields) => Value::Object(fields.iter()
                .map(|(field, inner)| (field.clone(), walk(inner, words || keys.contains(field), holders, keys, unfilled))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(|inner| walk(inner, words, holders, keys, unfilled)).collect()),
            Value::String(text) if words => Value::String(filled(text, holders, unfilled)),
            other => other.clone(),
        }
    }
    let mut unfilled = BTreeSet::new();
    let filled = walk(asks, false, [asks, run_input, answers], keys, &mut unfilled);
    (filled, unfilled.into_iter().collect())
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
    let mut payload = json!({ "workflow": workflow, "step": waiting["step"], "for": name, "asks": waiting["asks"], "told_as": told });
    if let Some(unfilled) = waiting.get("unfilled") { payload["unfilled"] = unfilled.clone(); }
    if let Some(by) = waiting.get("started_by") { payload["started_by"] = by.clone(); }
    json!({ "arrive": { "source": WAITING, "event_id": told["event_id"], "payload": payload } })
}

/// The fields of a run that are the run's own, not the workflow's input.
/// `fill_input` is the reader of what a bare start leaves out (workflow_engine::fill_input), and `filled_from` what it filled.
/// `uses_missing` lists the workflows the run names that no `uses` holds, which its reader reads too.
/// `on_end` is the run's end recorder (`end_effect`), and `ended` the failure a run is telling it before it fails.
const KEPT: [&str; 17] = ["row", "definition", "definitions", "answers", "start_at", "started_at", "run", "refused", "recipe",
    "read_definition", "definition_may_move", "started_by", "fill_input", "filled_from", "uses_missing", "on_end", "ended"];

/// The step a definition is read under when its reader names none.
const READ_STEP: &str = "read-definition";
/// The step a failing run tells its `on_end` recorder under, before it fails.
const END_STEP: &str = "record-the-end";
/// Where this pass holds the reader's answer it was told: taken out before anything is carried.
const READ: &str = "definition_read";

/// The recipe id a run is named by when it carries no definition: its `recipe`, else the listed row's id `row`.
fn recipe_of(run: &Map<String, Value>) -> Option<String> {
    run.get("recipe").or_else(|| run.get("row")).and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned)
}

/// The step the run's reader answers under (`read_definition.step`, else `READ_STEP`), when the run names a reader.
fn reader_step(run: &Map<String, Value>) -> Option<String> {
    let reader = run.get("read_definition").filter(|reader| reader.is_object())?;
    Some(reader["step"].as_str().filter(|step| !step.is_empty()).unwrap_or(READ_STEP).to_string())
}

/// The step the run's `fill_input` reader answers under, when the run names one.
fn fill_step(run: &Map<String, Value>) -> Option<String> {
    run.get("fill_input").filter(|reader| reader.is_object()).map(workflow_engine::fill_input::step)
}

/// The reader step a start must hand out before anything walks, when its input leaves out what its `fill_input` reader
/// fills (a bare start with no store): (workflow, step, tool, asks). The reader is scoped by what the task's context says
/// (`account`: the signed-in account the run is for). A reader whose tool failed fails the run in its words.
fn pending_fill(run: &Map<String, Value>, refused: &BTreeMap<String, String>, context: &Value) -> Result<Option<(String, String, String, Value)>, String> {
    let Some(step) = fill_step(run) else { return Ok(None) };
    let reader = &run["fill_input"];
    if !workflow_engine::fill_input::wanted(reader, run.get("input").unwrap_or(&Value::Null)) { return Ok(None); }
    if let Some(why) = refused.get(&step) { return Err(format!("the input was not filled: {why}")); }
    let workflow = recipe_of(run).or_else(|| run.get("definition").and_then(|d| d["id"].as_str()).map(str::to_owned)).unwrap_or_else(|| "workflow".into());
    let (tool, asks) = workflow_engine::fill_input::ask(reader, &json!({ "account": context["account_id"], "input": run.get("input") }))?;
    Ok(Some((workflow, step, tool, asks)))
}

/// Hands out the one step a pass waits on before anything walks (a reader's), told back to this run under `step`.
fn hand_out(run: &Map<String, Value>, workflow: &str, step: &str, tool: &str, asks: Value) {
    println!("{}", handed_out(run, workflow, step, tool, asks));
}

/// What `hand_out` prints: the paused pass with its one waiting step and the effect that runs it.
fn handed_out(run: &Map<String, Value>, workflow: &str, step: &str, tool: &str, asks: Value) -> Value {
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run").to_string();
    let told = json!({ "source": ANSWERED, "event_id": format!("{run_id}:{step}"),
        "payload": { "workflow": workflow, "run": run, "step": step, "for": tool } });
    let waiting = json!({ "step": step, "for": tool, "asks": asks });
    let effect = effect_of(&waiting, told.clone(), &door_asks(), workflow);
    let mut shown = waiting.clone();
    shown["told_as"] = told;
    json!({ "result": { "status": "paused", "workflow": workflow, "run": run_id, "steps": {}, "waiting": [shown] }, "wake_effects": [effect] })
}

/// The one run of the run's `on_end` tool its end asks for, `{tool, input, with?}`: its input with each value `with` names
/// ({path in the input: run, status, workflow or why}) set where it says, so the place that keeps the run's row (the
/// wf_runs row its reader wrote at the start) learns how it ended. None while the run is paused, or when it names none.
fn end_effect(run: &Map<String, Value>, status: &str, workflow: &str, why: Option<&str>) -> Option<Value> {
    if status == "paused" { return None; }
    let own = run.get("on_end").filter(|recorder| recorder["tool"].as_str().is_some_and(|tool| !tool.is_empty())).cloned();
    // The run's own definition reader names the database its row was written in; with no own recorder, the DATA one
    // records there. A run with neither records nothing (no store is named in code).
    let database = run.get("read_definition").and_then(|reader| reader["input"]["database"].as_str()).filter(|d| !d.is_empty());
    let recorder = match own {
        Some(recorder) => recorder,
        None => {
            database?;
            let data: Value = serde_json::from_str(RUN_END).unwrap_or_else(|error| fail(format!("run-end.json does not read: {error}")));
            data["recorder"].clone()
        }
    };
    // A run that ends well has no why: a recorder reads it through `with_if_given`, which sets null in its place.
    let known = json!({ "run": run.get("run").cloned().unwrap_or(json!("run")), "status": status, "workflow": workflow, "why": why,
        "database": database });
    let (tool, input) = workflow_engine::fill_input::ask(&recorder, &known).ok()?;
    Some(json!({ "wake": { "tool": tool, "input": input } }))
}

/// A run that fails tells its `on_end` recorder first, so its row says failed and why: the recorder is the one step handed
/// out (`END_STEP`), with the failure held as `ended`, and the pass its answer starts fails with those words (the_run). A
/// run that names no recorder, or has told it already, fails at once. Before this, a run whose read was refused or too
/// large ended with exit 1 and its wf_runs row said started for ever (School's run at 10:11 PM CST Nov 21 2026).
fn end_failed(run: Map<String, Value>, workflow: &str, why: String) -> ! {
    match ending(run, workflow, &why) {
        Some(out) => { println!("{out}"); std::process::exit(0) }
        None => fail(why),
    }
}

/// The pass a failing run prints to tell its recorder (`end_failed`), or None when it names none or has told it already.
fn ending(mut run: Map<String, Value>, workflow: &str, why: &str) -> Option<Value> {
    if run.get("ended").is_some() { return None; }
    let effect = end_effect(&run, "failed", workflow, Some(why))?;
    run.insert("ended".into(), json!(why));
    let tool = effect["wake"]["tool"].as_str().unwrap_or_default().to_string();
    Some(handed_out(&run, workflow, END_STEP, &tool, effect["wake"]["input"].clone()))
}

/// The recorder a run that ended well (completed or skipped) asks, with a reply: its answer comes back to the run under
/// `END_STEP` with `ended_as` held, so a record that failed fails the run in its words instead of vanishing (Nov 22 2026,
/// 4:22 AM CST: a resumed run's end effect, sent with no reply, never landed and nothing said so).
fn end_told(run: &Map<String, Value>, status: &str, workflow: &str, why: Option<&str>, doors: &BTreeSet<String>) -> Option<Value> {
    let effect = end_effect(run, status, workflow, why)?;
    let mut carried = run.clone();
    carried.insert("ended_as".into(), json!(status));
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run");
    let tool = effect["wake"]["tool"].clone();
    let told = json!({ "source": ANSWERED, "event_id": format!("{run_id}:{END_STEP}"),
        "payload": { "workflow": workflow, "run": carried, "step": END_STEP, "for": tool } });
    Some(effect_of(&json!({ "step": END_STEP, "for": tool, "asks": effect["wake"]["input"] }), told, doors, workflow))
}

/// What the pass the recorder's answer starts prints, for a run that ended well: its end, once more, when the record was
/// kept; the run's failure, in words, when it was not.
fn after_end(run: &Map<String, Value>, told: &Value) -> Result<Value, String> {
    let status = run.get("ended_as").and_then(Value::as_str).unwrap_or("completed");
    let workflow = told["workflow"].as_str().unwrap_or("the workflow");
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run");
    match told.get("error") {
        Some(error) => {
            let said = told["said"].as_str().map(|said| format!(": {said}")).unwrap_or_default();
            Err(format!("{workflow} {status}, but its end was not recorded ({}{said})", error.as_str().unwrap_or_default()))
        }
        None => Ok(json!({ "result": { "status": status, "workflow": workflow, "run": run_id, "steps": {}, "recorded": true } })),
    }
}

/// The words a run fails with when its recorder's answer comes back (`END_STEP`): the failure it held, and the recorder's
/// own error when it could not record it.
fn ended_why(run: &Map<String, Value>, told: &Value) -> String {
    let why = run.get("ended").and_then(Value::as_str).unwrap_or("the workflow failed").to_string();
    match told.get("error") {
        Some(error) => format!("{why} (its end was not recorded: {})", error.as_str().unwrap_or_default()),
        None => why,
    }
}

/// Whether the run was handed its definitions themselves.
fn carries_definition(run: &Map<String, Value>) -> bool {
    run.get("definition").is_some_and(Value::is_object) || run.get("definitions").and_then(Value::as_array).is_some_and(|all| !all.is_empty())
}

/// The value at a dotted path (`rows.0.definition`): a part that is a number indexes an array.
fn at_path<'v>(value: &'v Value, path: &str) -> Option<&'v Value> {
    path.split('.').filter(|part| !part.is_empty()).try_fold(value, |at, part| match (at, part.parse::<usize>()) {
        (Value::Array(items), Ok(index)) => items.get(index),
        (Value::Object(fields), _) => fields.get(part),
        _ => None,
    })
}

/// `value` with `put` set at a dotted path (`params.0`), making the objects and arrays on the way.
fn set_at(value: &mut Value, path: &str, put: Value) {
    let parts: Vec<&str> = path.split('.').filter(|part| !part.is_empty()).collect();
    let mut at = value;
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        at = match part.parse::<usize>() {
            Ok(position) => {
                if !at.is_array() { *at = json!([]); }
                let items = at.as_array_mut().unwrap();
                while items.len() <= position { items.push(Value::Null); }
                &mut items[position]
            }
            Err(_) => {
                if !at.is_object() { *at = json!({}); }
                at.as_object_mut().unwrap().entry(part.to_string()).or_insert(Value::Null)
            }
        };
        if last { *at = put; return; }
    }
}

/// The ask the reader is handed: its input with the recipe id at `recipe_at`, the workflows the run names that no `uses`
/// holds at `uses_ids_at` (the run's `uses_missing`, empty until the definition is first read), and each of the run's
/// values its `with` names ({path in the reader's input: dotted path in the run}, such as the chosen condition or the
/// run's id) set where it says.
fn reader_ask(reader: &Value, recipe: &str, run: &Map<String, Value>) -> Value {
    let mut input = reader.get("input").cloned().unwrap_or(json!({}));
    if let Some(path) = reader["recipe_at"].as_str() { set_at(&mut input, path, json!(recipe)); }
    if let Some(path) = reader["uses_ids_at"].as_str() { set_at(&mut input, path, run.get("uses_missing").cloned().unwrap_or(json!([]))); }
    let run = Value::Object(run.clone());
    for (to, from) in reader["with"].as_object().into_iter().flatten() {
        let value = from.as_str().and_then(|from| at_path(&run, from)).cloned().unwrap_or(Value::Null);
        set_at(&mut input, to, value);
    }
    input
}

/// Why the reader's answer says the run is not to run (a text, or true, at the reader's `skip_at`), such as its row being
/// switched off between the choosing and the start: the run then ends skipped, with no step run.
fn skipped_by(reader: &Value, answer: &Value) -> Option<String> {
    match reader["skip_at"].as_str().and_then(|path| at_path(answer, path)) {
        Some(Value::String(why)) if !why.is_empty() => Some(why.clone()),
        Some(Value::Bool(true)) => Some("skipped".to_string()),
        _ => None,
    }
}

/// The definition the reader answered, held to the run's pin: the first read holds the BLAKE3 of its JSON (and its version,
/// when the reader names `version_at`) as the reader step's answer; a later read that differs is refused in words, unless
/// the run says `definition_may_move`, when the pin moves with it.
fn pinned_definition(run: &mut Map<String, Value>, recipe: &str, step: &str, answer: &Value) -> Result<Value, String> {
    let reader = run.get("read_definition").cloned().unwrap_or(Value::Null);
    let definition_at = reader["definition_at"].as_str().unwrap_or("definition");
    let definition = at_path(answer, definition_at).filter(|definition| definition.is_object()).cloned()
        .ok_or_else(|| format!("no definition of {recipe} was read: its reader answered nothing at {definition_at} (is there a row for {recipe}?)"))?;
    let version = reader["version_at"].as_str().and_then(|path| at_path(answer, path)).cloned().unwrap_or(Value::Null);
    let pin = json!({ "blake3": blake3::hash(definition.to_string().as_bytes()).to_hex().to_string(), "version": version });
    let may_move = run.get("definition_may_move") == Some(&Value::Bool(true));
    let answers = run.entry("answers").or_insert_with(|| json!({}));
    let held = answers.get(step).filter(|held| held.get("blake3").is_some()).cloned();
    match held {
        Some(held) if held["blake3"] != pin["blake3"] && !may_move => Err(format!(
            "the workflow's definition changed while it ran (recipe {recipe}): it started on {} (version {}) and reads {} (version {}) now",
            held["blake3"].as_str().unwrap_or_default(), held["version"], pin["blake3"].as_str().unwrap_or_default(), pin["version"])),
        _ => { answers[step] = pin; Ok(named(definition, recipe)) }
    }
}

/// A row's definition with the row's own id: a person's row keeps its id in the recipe column, so most definitions hold
/// no `id` (582 of 797 rows on Nov 21 2026) and no `name`; both are filled from the recipe id when absent, after the pin is
/// taken, so the pin stays the BLAKE3 of the row as read. 10:24 PM CST Nov 21 2026: every answered step on the Mac failed
/// "a definition does not decode: missing field `id`".
fn named(mut definition: Value, id: &str) -> Value {
    if !definition["id"].as_str().is_some_and(|own| !own.is_empty()) { definition["id"] = json!(id); }
    if !definition["name"].is_string() { definition["name"] = json!(id); }
    definition
}

struct Held { run: String, answers: BTreeMap<String, Value>, refused: BTreeMap<String, String>, waiting: Mutex<Vec<Value>>, told: Mutex<Vec<(String, Value, Value)>>,
    /// The run's own input, which an ask's words are filled from after the ask's own input (`fill_ask_words`).
    run_input: Value, words: BTreeSet<String> }

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
        // The engine starts runs itself (a fact, a schedule, the router), so no hand harness fills an ask's {key} words.
        let answers = Value::Object(self.answers.iter().map(|(step, answer)| (step.clone(), answer.clone())).collect());
        let (input, unfilled) = fill_ask_words(&input, &self.run_input, &answers, &self.words);
        if !unfilled.is_empty() {
            return Err(format!("step {step}'s words name {}, which neither its input, the run's input nor an earlier step's answer holds \
                (write {{{{ for a literal brace)", unfilled.iter().map(|key| format!("{{{key}}}")).collect::<Vec<_>>().join(", ")));
        }
        let waiting = json!({ "step": step, "for": name, "asks": input });
        self.waiting.lock().unwrap().push(waiting);
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
        if step == END_STEP {
            if run.contains_key("ended_as") {
                match after_end(&run, told) {
                    Ok(out) => { println!("{out}"); std::process::exit(0) }
                    Err(why) => fail(why),
                }
            }
            fail(ended_why(&run, told));
        }
        // What the input left out is filled from the reader's answer (workflow_engine::fill_input), which is never held:
        // the filled fields are the run's input from here on, and `filled_from` says which row each came from.
        if told.get("error").is_none() && fill_step(&run).as_deref() == Some(step.as_str()) {
            let reader = run["fill_input"].clone();
            let input = run.entry("input").or_insert_with(|| json!({}));
            let filled = workflow_engine::fill_input::apply(&reader, input, &told["result"]).unwrap_or_else(|why| fail(why));
            let kept = run.entry("filled_from").or_insert_with(|| json!({}));
            for (field, from) in filled { kept[field] = from; }
            return (run, refused);
        }
        // The reader's answer (the definition, of any size) is for this pass alone: never held, never carried, never
        // counted against the bound; only the pin it makes is held (`pinned_definition`).
        if told.get("error").is_none() && reader_step(&run).as_deref() == Some(step.as_str()) {
            run.insert(READ.into(), told["result"].clone());
            return (run, refused);
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
        // A fact that starts a run by its recipe (`recipe`) may say who started it (`started_by`): the run keeps it, and
        // every step it hands out says it, so whoever answers can check the holder. A router's fact names none, and the
        // run then has none (never the account in its place).
        for field in ["definition", "start_at", "recipe", "started_by"] {
            if let Some(value) = fact.remove(field) {
                run.entry(field.to_string()).or_insert(value);
            }
        }
        // A run that names a reader reads its row when it starts, never the copy the fact carries: a row switched off or
        // changed between the choosing and the start (4:48-3:54 PM CST Nov 21 2026: a run chosen before
        // workflow:publish-each-clip-that-clears-its-gates was switched off and fixed still ran its old definition) runs
        // as the row is now. The fact's `workflow` names the recipe.
        if run.get("read_definition").is_some_and(Value::is_object) {
            if !run.contains_key("recipe") {
                if let Some(workflow) = fact.get("workflow").filter(|workflow| workflow.is_string()) { run.insert("recipe".into(), workflow.clone()); }
            }
            if run.contains_key("recipe") { run.remove("definition"); run.remove("definitions"); }
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
    // A wake's switch that hands in neither (its input lost, or never given) is named, with what it needs.
    fail("the run carries no definition and names no recipe: whatever starts it hands in the workflow's definition, or its `recipe` with \
          `read_definition` (the reader of the row the person keeps it in); a wake's switch gives them as its input")
}

/// The workflow and every workflow in its `uses` at any depth (workflow_engine::uses), so a body kept in a sub-workflow's
/// own uses is found; one id with two definitions fails the run naming both places.
fn with_used(definition: Value) -> Vec<Value> {
    workflow_engine::uses::with_uses(definition).unwrap_or_else(|why| fail(why))
}

/// The workflows the reader's answer holds besides the run's own (rows at `uses_at`, each its id at `uses_id_at`, default
/// `recipe`, and its definition at `uses_definition_at`, default `definition`), each held to the run's pin as its
/// definition is (`held`: the pins of the uses read before): a later read that differs fails the run unless it says
/// `definition_may_move`. Their pins are added to the reader step's held answer.
fn read_uses(run: &mut Map<String, Value>, step: &str, answer: &Value, held: &Value) -> Result<Vec<Value>, String> {
    let reader = run.get("read_definition").cloned().unwrap_or(Value::Null);
    let Some(rows) = reader["uses_at"].as_str().and_then(|path| at_path(answer, path)).and_then(Value::as_array).cloned() else { return Ok(vec![]) };
    let id_at = reader["uses_id_at"].as_str().unwrap_or("recipe");
    let definition_at = reader["uses_definition_at"].as_str().unwrap_or("definition");
    let may_move = run.get("definition_may_move") == Some(&Value::Bool(true));
    let mut read = vec![];
    let mut pins = Map::new();
    for row in rows {
        let (Some(id), Some(definition)) = (at_path(&row, id_at).and_then(Value::as_str), at_path(&row, definition_at).filter(|d| d.is_object())) else { continue };
        let mut definition = definition.clone();
        if definition.get("id").is_none() { definition["id"] = json!(id); }
        let pin = blake3::hash(definition.to_string().as_bytes()).to_hex().to_string();
        let definition = named(definition, id);
        if let Some(before) = held.get(id).and_then(Value::as_str).filter(|before| *before != pin && !may_move) {
            return Err(format!("the workflow {id} that this run uses changed while it ran: it started on {before} and reads {pin} now"));
        }
        pins.insert(id.to_string(), json!(pin));
        read.push(definition);
    }
    if let Some(answers) = run.get_mut("answers").and_then(|answers| answers.get_mut(step)) { answers["uses"] = Value::Object(pins); }
    Ok(read)
}

/// The definitions a read run walks: the one its reader answered (held to its pin), every workflow in its uses at any
/// depth, and the workflows from the person's rows its walks have reached so far (`uses_missing`), read by the same reader
/// in the same ask. A workflow the run names that nothing holds is read only once a walk reaches it (missed_to_read), so a
/// run that uses many large rows never asks for them all in one answer. A workflow no place holds is left to the step that
/// names it, which fails naming where it looked.
fn read_definitions(run: &mut Map<String, Value>, recipe: &str, step: &str, answer: &Value) -> Result<Option<Vec<Value>>, String> {
    let held_uses = run.get("answers").and_then(|answers| answers.get(step)).map(|held| held["uses"].clone()).unwrap_or(Value::Null);
    let mut definition = pinned_definition(run, recipe, step, answer)?;
    let read = read_uses(run, step, answer, &held_uses)?;
    let own: BTreeSet<String> = workflow_engine::uses::with_uses(definition.clone())?.iter().filter_map(|d| d["id"].as_str().map(str::to_owned)).collect();
    if !definition["uses"].is_array() { definition["uses"] = json!([]); }
    for used in read.into_iter().filter(|d| !d["id"].as_str().is_some_and(|id| own.contains(id))) {
        definition["uses"].as_array_mut().unwrap().push(used);
    }
    Ok(Some(workflow_engine::uses::with_uses(definition)?))
}

/// Whether a failed walk missed workflows (the engine's `definitions_missed`) that the run's reader has not been asked for
/// yet and can read (`uses_ids_at`): they are added to `uses_missing`, so the next ask reads them with the definition.
fn missed_to_read(run: &mut Map<String, Value>, walked: &Value) -> bool {
    let readable = recipe_of(run).is_some() && run.get("read_definition").is_some_and(|reader| reader["uses_ids_at"].is_string());
    let missed: BTreeSet<String> = walked["definitions_missed"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    let asked: BTreeSet<String> = run.get("uses_missing").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    if !readable || missed.is_subset(&asked) { return false; }
    run.insert("uses_missing".into(), json!(asked.union(&missed).collect::<Vec<_>>()));
    true
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
    // A start that leaves out what its `fill_input` reader fills reads it first, from the row the person keeps for their
    // account; a caller's own value always wins.
    if let Some((workflow, step, tool, asks)) = pending_fill(&run, &refused, &given["context"]).unwrap_or_else(|why| fail(why)) {
        hand_out(&run, &workflow, &step, &tool, asks);
        return;
    }
    let mut all = match (carries_definition(&run), recipe_of(&run)) {
        (false, Some(recipe)) => {
            let step = reader_step(&run).unwrap_or_else(|| fail(format!(
                "{recipe} was named with no definition: hand in definition, or read_definition with a recipe")));
            if let Some(why) = refused.get(&step) {
                let asked = run.get("uses_missing").and_then(Value::as_array).map(|ids| ids.len()).unwrap_or(0);
                let with = if asked > 0 { format!(" with the {asked} workflows it uses") } else { String::new() };
                end_failed(run.clone(), &recipe, format!("the definition of {recipe}{with} was not read: {why}"));
            }
            // A caller that read it itself hands the reader's answer as the step's answer; it is used, never held.
            let given_read = run.get("answers").and_then(|answers| answers.get(&step))
                .filter(|answer| answer.get("blake3").is_none()).cloned();
            if given_read.is_some() { run["answers"].as_object_mut().unwrap().remove(&step); }
            match run.remove(READ).or(given_read) {
                Some(answer) if skipped_by(&run["read_definition"], &answer).is_some() => {
                    let why = skipped_by(&run["read_definition"], &answer).unwrap_or_default();
                    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run").to_string();
                    let effects: Vec<Value> = end_told(&run, "skipped", &recipe, Some(&why), &door_asks()).into_iter().collect();
                    println!("{}", json!({ "result": { "status": "skipped", "why": why, "workflow": recipe, "run": run_id, "steps": {} }, "wake_effects": effects }));
                    return;
                }
                Some(answer) => match read_definitions(&mut run, &recipe, &step, &answer).unwrap_or_else(|why| end_failed(run.clone(), &recipe, why)) {
                    Some(all) => all,
                    None => {
                        let reader = run["read_definition"].clone();
                        let tool = reader["tool"].as_str().unwrap_or_default().to_string();
                        hand_out(&run, &recipe, &step, &tool, reader_ask(&reader, &recipe, &run));
                        return;
                    }
                },
                None => {
                    // Nothing walks until the definition is read: the reader is the one step handed out this pass.
                    let reader = run["read_definition"].clone();
                    let tool = reader["tool"].as_str().unwrap_or_default().to_string();
                    hand_out(&run, &recipe, &step, &tool, reader_ask(&reader, &recipe, &run));
                    return;
                }
            }
        }
        _ => definitions_of(&run),
    };
    if let Some(step) = run.get("start_at").and_then(Value::as_str) { all[0] = started_at_step(all[0].clone(), step); }
    let definitions: Vec<workflow_core::Definition> = all.into_iter()
        .map(|definition| {
            let id = definition["id"].as_str().map(str::to_owned).or_else(|| recipe_of(&run)).unwrap_or_else(|| "the workflow".into());
            serde_json::from_value(definition).unwrap_or_else(|error| fail(format!("the definition of {id} does not decode: {error}")))
        }).collect();
    let id = definitions[0].id.clone();
    let answers: BTreeMap<String, Value> = serde_json::from_value(run.get("answers").cloned().unwrap_or(json!({}))).unwrap_or_default();
    let run_id = run.get("run").and_then(Value::as_str).unwrap_or("run").to_string();
    let host = Arc::new(Held { run: run_id.clone(), answers, refused: refused.clone(), waiting: Mutex::new(vec![]), told: Mutex::new(vec![]),
        run_input: run.get("input").cloned().unwrap_or(json!({})), words: words_keys() });
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
    // A walk that reached a workflow nothing held (one the run uses, or a family member a step chose at run time) reads it
    // with the definition, by the same reader, and walks again from the held answers: whatever this pass reached, failed or
    // routed is let go and walked again with it, so nothing it told or handed out is kept. Only the workflows a walk
    // reaches are read, never every one its uses name, so one read stays under the engine's answer bound (School's run at
    // 10:11 PM CST Nov 21 2026 asked for all 8 of its used rows at once: 142,901 bytes, over the 131,072 an answer may be).
    if missed_to_read(&mut run, &walked) {
        let recipe = recipe_of(&run).unwrap_or_else(|| id.clone());
        let reader = run["read_definition"].clone();
        let tool = reader["tool"].as_str().unwrap_or_default().to_string();
        let step = reader_step(&run).unwrap_or_else(|| READ_STEP.to_string());
        hand_out(&run, &recipe, &step, &tool, reader_ask(&reader, &recipe, &run));
        return;
    }
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
    // Who started the run, when its starting fact said so, goes with every step it hands out.
    let started_by = run.get("started_by").cloned();
    let waiting: Vec<Value> = waiting.into_iter().map(|mut w| { if let Some(by) = &started_by { w["started_by"] = by.clone(); } w }).collect();
    let mut effects: Vec<Value> = told.into_iter().map(|(_, _, fact)| fact).collect();
    let doors = door_asks();
    effects.extend(waiting.iter().take(1).map(|w| effect_of(w, told_as(&w["step"], &w["for"]), &doors, &id)));
    let waiting: Vec<Value> = waiting.into_iter().map(|mut w| { w["told_as"] = told_as(&w["step"], &w["for"]); w }).collect();
    let mut result = json!({ "status": walked["status"], "workflow": id, "run": run_id, "steps": steps, "waiting": waiting });
    if let Some(filled) = run.get("filled_from") { result["filled_from"] = filled.clone(); }
    // A walk that failed is a failed run: it ends with exit 1 and the engine's words, so the wake that started it is
    // marked failed (and tells its failed fact) instead of ran, and whoever waits on its told answer hears the failure.
    if walked["status"] == "failed" {
        let why = walked["error_message"].as_str().unwrap_or("the workflow failed");
        if run.get("ended").is_none() && end_effect(&run, "failed", &id, None).is_some() { end_failed(run, &id, format!("{id}: {why}")); }
        println!("{}", json!({ "error": format!("{id}: {why}"), "result": result }));
        std::process::exit(1);
    }
    effects.extend(end_told(&run, walked["status"].as_str().unwrap_or_default(), &id, None, &doors));
    println!("{}", json!({ "result": result, "wake_effects": effects }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held() -> Arc<Held> {
        Arc::new(Held { run: "r".into(), answers: BTreeMap::new(), refused: BTreeMap::new(), waiting: Mutex::new(vec![]), told: Mutex::new(vec![]),
            run_input: json!({}), words: words_keys() })
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
            let host = Arc::new(Held { run: "k".into(), answers: serde_json::from_value(run["answers"].clone()).unwrap_or_default(), refused, waiting: Mutex::new(vec![]), told: Mutex::new(vec![]),
                run_input: run["input"].clone(), words: words_keys() });
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

    // Nov 21 2026: give-paid-buyers-access asked with the literal {people}, handle-every-inbox-daily with {connection_id}.
    #[test]
    fn an_asks_words_are_filled_from_its_own_input_then_the_runs() {
        let keys = words_keys();
        let run_input = json!({ "people": ["ana", "bo"], "connection_id": "ca_1", "name": "from the run" });
        let asks = json!({ "name": "from the step", "do": "Give {people} access through {connection_id} as {name}; {missing} too",
            "sql": "select '{people}' as kept, json_build_object('a', 1)", "nested": { "question": "{connection_id}?", "rows": "{people}" },
            "steps": [{ "prompt": "{name} {0} {Name} {} {people" }] });
        let (filled, unfilled) = fill_ask_words(&asks, &run_input, &json!({}), &keys);
        assert_eq!(filled["do"], "Give [\"ana\",\"bo\"] access through ca_1 as from the step; {missing} too",
            "a key from the run input, a key from the step input winning over the run's, a value that is not text as its JSON");
        assert_eq!(unfilled, vec!["missing".to_string()]);
        assert_eq!(filled["sql"], asks["sql"], "a field that is not a words field is never touched");
        assert_eq!(filled["nested"]["question"], "ca_1?", "a words field at any depth is filled");
        assert_eq!(filled["nested"]["rows"], "{people}");
        assert_eq!(filled["steps"][0]["prompt"], "from the step {0} {Name} {} {people", "only {{key}} with key [a-z_][a-z_0-9]* is a name");
    }

    // An earlier step's answer fills a dotted key, and `{{` is a literal brace.
    #[test]
    fn an_asks_words_read_earlier_answers_and_escape_a_brace() {
        let answers = json!({ "read-hosts": { "hosts": ["mac", "always-on"] } });
        let asks = json!({ "do": "Copy {name} to {read-hosts.hosts}; write {{name} for the key itself; {store.credential_name}" });
        let (filled, unfilled) = fill_ask_words(&asks, &json!({ "name": "stripe-key", "store": { "credential_name": "runs" } }), &answers, &words_keys());
        assert_eq!(filled["do"], "Copy stripe-key to [\"mac\",\"always-on\"]; write {name} for the key itself; runs");
        assert!(unfilled.is_empty(), "{unfilled:?}");
    }

    // The whole way out: a run the engine started holds its input; an ask whose words are all filled goes out filled, and
    // one that names a key nothing holds is refused in words, never sent with a literal brace (Nov 22 2026: 8 recipes, 16
    // steps went out unfilled).
    #[test]
    fn an_ask_naming_a_key_nothing_holds_is_refused_in_words() {
        let walk = |words: &str| {
            let definition = json!({ "id": "give", "name": "give", "kind": "workflow", "is_active": true, "version": 1, "edges": [],
                "steps": [{ "id": "ask", "kind": "ask", "config": { "name": "ai", "context": { "step_id": "ask" },
                    "input": { "do": words, "sql": "{people}" } } }] });
            let given = json!({ "input": { "definition": definition, "people": "ana" }, "cause": { "key": "k" }, "context": {} });
            let (run, refused) = the_run(&given);
            let definitions: Vec<workflow_core::Definition> = definitions_of(&run).into_iter().map(|d| serde_json::from_value(d).unwrap()).collect();
            let host = Arc::new(Held { run: "k".into(), answers: BTreeMap::new(), refused, waiting: Mutex::new(vec![]), told: Mutex::new(vec![]),
                run_input: run["input"].clone(), words: words_keys() });
            let walked = futures::executor::block_on(workflow_engine::run_definition_with_started_at(definitions, "give", run["input"].clone(), "someone", "workflow", "2026-11-21T00:00:00Z", host.clone())).unwrap();
            let waiting = host.waiting.lock().unwrap().clone();
            (walked, waiting)
        };
        let (_, waiting) = walk("Give {people} access");
        let fact = effect_of(&waiting[0], json!({ "event_id": "k:ask" }), &door_asks(), "give");
        assert_eq!(fact["arrive"]["payload"]["asks"], json!({ "do": "Give ana access", "sql": "{people}" }));
        let (walked, waiting) = walk("Give {people} access ({why})");
        assert!(waiting.is_empty(), "nothing goes out");
        assert_eq!(walked["status"], "failed", "{walked}");
        let why = walked["error_message"].as_str().unwrap_or_default();
        assert!(why.contains("{why}") && why.contains("neither its input"), "{why}");
    }

    fn reader() -> Value {
        json!({ "tool": "tool:reader", "input": { "credential_name": "rows-connection", "sql": "select definition from workflow_recipes where recipe = $1", "params": [] },
            "recipe_at": "params.0", "definition_at": "rows.0.definition", "version_at": "rows.0.kept_at" })
    }

    fn one_step(id: &str, ask: &str) -> Value {
        json!({ "id": id, "name": id, "kind": "workflow", "is_active": true, "version": 1, "edges": [],
            "steps": [{ "id": "say", "kind": "ask", "config": { "name": ask, "context": { "step_id": "say" }, "input": {} } }] })
    }

    fn read_answer(definition: Value, kept_at: &str) -> Value { json!({ "rows": [{ "definition": definition, "kept_at": kept_at }] }) }

    // The reader is handed the recipe id where it asks for it, and a listed row's id reads the same way.
    #[test]
    fn a_run_named_by_its_recipe_or_listed_row_asks_its_reader_with_that_id() {
        let asks = reader_ask(&reader(), "workflow:x", &Map::new());
        assert_eq!(asks["params"], json!(["workflow:x"]));
        assert_eq!(asks["credential_name"], "rows-connection");
        let mut by_row = Map::new();
        by_row.insert("row".into(), json!("workflow:x"));
        assert_eq!(recipe_of(&by_row).as_deref(), Some("workflow:x"));
        by_row.insert("read_definition".into(), reader());
        assert_eq!(reader_step(&by_row).as_deref(), Some(READ_STEP));
        assert!(!carries_definition(&by_row));
    }

    // A told reader answer is used for its pass alone: not held, not counted, whatever its size; only its pin is held, and
    // the run it hands on carries no definition.
    #[test]
    fn the_readers_answer_is_never_carried_and_only_its_pin_is_held() {
        let big = { let mut definition = one_step("workflow:x", "tool:x"); definition["filler"] = json!("x".repeat(700 * 1024)); definition };
        let run = json!({ "recipe": "workflow:x", "read_definition": reader(), "input": {}, "answers": {} });
        let given = json!({ "input": {}, "cause": { "key": "k", "detail": { "kind": ANSWERED, "payload": {
            "workflow": "workflow:x", "run": run, "step": READ_STEP, "for": "tool:reader", "result": read_answer(big.clone(), "2026-11-21") } } }, "context": {} });
        let (mut run, refused) = the_run(&given);
        assert!(refused.is_empty(), "{refused:?}");
        assert!(run["answers"].get(READ_STEP).is_none(), "the answer is not held");
        let answer = run.remove(READ).expect("the answer is this pass's");
        let definition = pinned_definition(&mut run, "workflow:x", READ_STEP, &answer).unwrap();
        assert_eq!(definition, big);
        let carried = Value::Object(run.clone()).to_string();
        assert!(carried.len() < 1024, "the run carries the pin, not the definition: {} bytes", carried.len());
        assert_eq!(run["answers"][READ_STEP]["version"], "2026-11-21");
        assert_eq!(run["answers"][READ_STEP]["blake3"].as_str().unwrap().len(), 64);
    }

    // A row keeps its id in the recipe column, so its definition (and a used row's) may hold no id and no name: the run takes
    // both from the recipe, decodes and walks, and the pin is the row as read (10:24 PM CST Nov 21 2026: every answered step
    // on the Mac failed "missing field `id`").
    #[test]
    fn a_row_whose_definition_holds_no_id_is_named_by_its_recipe() {
        let bare = |ask: &str| { let mut d = one_step("x", ask); d.as_object_mut().unwrap().remove("id"); d.as_object_mut().unwrap().remove("name"); d };
        let mut run = Map::new();
        run.insert("read_definition".into(), reader());
        let definition = pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(bare("tool:x"), "v1")).unwrap();
        assert_eq!((definition["id"].as_str(), definition["name"].as_str()), (Some("workflow:x"), Some("workflow:x")));
        assert_eq!(run["answers"][READ_STEP]["blake3"], json!(blake3::hash(bare("tool:x").to_string().as_bytes()).to_hex().to_string()));
        let decoded: workflow_core::Definition = serde_json::from_value(definition).expect("decodes");
        assert_eq!(decoded.id.to_string(), "workflow:x");
        let mut used_run = Map::new();
        let mut uses_reader = reader();
        uses_reader["uses_at"] = json!("rows");
        used_run.insert("read_definition".into(), uses_reader);
        let used = read_uses(&mut used_run, READ_STEP, &json!({ "rows": [{ "recipe": "workflow:used", "definition": bare("tool:y") }] }), &Value::Null).unwrap();
        let decoded: workflow_core::Definition = serde_json::from_value(used[0].clone()).expect("a used row decodes too");
        assert_eq!(decoded.name, "workflow:used");
    }

    // A definition that changed while the run ran fails it in words, unless the run says it may move; the same one again
    // passes.
    #[test]
    fn a_definition_changed_mid_run_fails_the_run_unless_it_may_move() {
        let mut run = Map::new();
        run.insert("read_definition".into(), reader());
        pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(one_step("workflow:x", "tool:x"), "v1")).unwrap();
        assert!(pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(one_step("workflow:x", "tool:x"), "v1")).is_ok(), "the same one again");
        let changed = pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(one_step("workflow:x", "tool:y"), "v2")).unwrap_err();
        assert!(changed.contains("the workflow's definition changed while it ran (recipe workflow:x)"), "{changed}");
        run.insert("definition_may_move".into(), json!(true));
        assert!(pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(one_step("workflow:x", "tool:y"), "v2")).is_ok());
        assert_eq!(run["answers"][READ_STEP]["version"], "v2", "the pin moved with it");
    }

    // A wake copy woken by a row change (3:54 PM CST Nov 21 2026: a-row-changed/answer-finished-tasks lost its switch input and
    // failed every run) is switched with the recipe, its reader and its own settings: the run reads the row, carrying no
    // definition, and the row change and the settings are the workflow's input.
    #[test]
    fn a_run_woken_by_a_row_change_reads_its_recipe_through_the_switchs_reader() {
        let given = json!({ "input": { "database": "own", "recipe": "workflow:answer-a-finished-step-back", "read_definition": reader() },
            "cause": { "key": "k", "detail": { "kind": "something-changed", "event_id": "where::something-changed@own:1:2",
                "payload": { "place": "calendar_tasks", "key": "own:1:2", "change": "changed" } } }, "context": {} });
        let (run, refused) = the_run(&given);
        assert!(refused.is_empty(), "{refused:?}");
        assert!(!carries_definition(&run));
        assert_eq!(recipe_of(&run).as_deref(), Some("workflow:answer-a-finished-step-back"));
        assert_eq!(reader_step(&run).as_deref(), Some(READ_STEP));
        assert_eq!(run["input"]["database"], "own");
        assert_eq!(run["input"]["fact"]["place"], "calendar_tasks");
        assert!(run["input"].get("recipe").is_none() && run["input"].get("read_definition").is_none(), "the run's own fields are not the workflow's input");
        assert_eq!(reader_ask(&run["read_definition"], recipe_of(&run).as_deref().unwrap(), &run)["params"], json!(["workflow:answer-a-finished-step-back"]));
    }

    // A run chosen from a fact reads its row at start: the definition the fact carries is dropped and the fact's workflow
    // is the recipe, so an edit between the choosing and the start runs the row as it is now; the reader is handed the
    // chosen condition and the run's id, where its `with` says.
    #[test]
    fn a_chosen_run_that_names_a_reader_reads_its_row_at_start_not_the_carried_copy() {
        let mut read = reader();
        read["with"] = json!({ "params.1": "input.fact.condition", "params.2": "run" });
        let carried = one_step("workflow:clip", "tool:old");
        let given = json!({ "input": { "read_definition": read },
            "cause": { "key": "k1", "detail": { "kind": "workflow-chosen-from-rows", "event_id": "e",
                "payload": { "workflow": "workflow:clip", "condition": "a clip clears its gates", "definition": carried } } }, "context": {} });
        let (run, _) = the_run(&given);
        assert!(!carries_definition(&run), "the carried copy is dropped");
        assert_eq!(recipe_of(&run).as_deref(), Some("workflow:clip"));
        assert_eq!(reader_ask(&run["read_definition"], "workflow:clip", &run)["params"], json!(["workflow:clip", "a clip clears its gates", "k1"]));
        let mut run = run;
        let now = pinned_definition(&mut run, "workflow:clip", READ_STEP, &read_answer(one_step("workflow:clip", "tool:new"), "v2")).unwrap();
        assert_eq!(now["steps"][0]["config"]["name"], "tool:new", "the row as it is now runs");
    }

    // A row switched off between the choosing and the start: the reader says so at its skip_at, and the run is skipped.
    #[test]
    fn a_row_switched_off_before_the_start_skips_the_run() {
        let mut read = reader();
        read["skip_at"] = json!("rows.0.skipped");
        assert_eq!(skipped_by(&read, &json!({ "rows": [{ "definition": null, "skipped": "switched off" }] })).as_deref(), Some("switched off"));
        assert_eq!(skipped_by(&read, &json!({ "rows": [{ "definition": {}, "skipped": null }] })), None);
        assert_eq!(skipped_by(&reader(), &json!({ "rows": [{ "skipped": "switched off" }] })), None, "a reader with no skip_at never skips");
    }

    // A run whose switch names no reader keeps the definition its fact carries, as before.
    #[test]
    fn a_chosen_run_with_no_reader_keeps_the_carried_definition() {
        let given = json!({ "input": {}, "cause": { "key": "k", "detail": { "kind": "workflow-chosen-from-rows", "event_id": "e",
            "payload": { "workflow": "workflow:clip", "definition": one_step("workflow:clip", "tool:x") } } }, "context": {} });
        let (run, _) = the_run(&given);
        assert!(carries_definition(&run));
    }

    // A reader that found no row fails the run, naming the recipe.
    #[test]
    fn a_missing_row_fails_naming_the_recipe() {
        let mut run = Map::new();
        run.insert("read_definition".into(), reader());
        let missing = pinned_definition(&mut run, "workflow:gone", READ_STEP, &json!({ "rows": [] })).unwrap_err();
        assert!(missing.contains("no definition of workflow:gone was read") && missing.contains("rows.0.definition"), "{missing}");
    }

    // The size guard counts the pin and the held answers only: a held step answer is still refused past the bound, with the
    // reader's pin among the run's answers.
    #[test]
    fn the_size_guard_counts_the_pin_not_the_definition() {
        let mut run = Map::new();
        run.insert("read_definition".into(), reader());
        run.insert("recipe".into(), json!("workflow:x"));
        run.insert("input".into(), json!({ "most_answer_bytes": 1000 }));
        pinned_definition(&mut run, "workflow:x", READ_STEP, &read_answer(one_step("workflow:x", "tool:x"), "v1")).unwrap();
        let (held, refused) = the_run(&told_answer(Value::Object(run.clone()), json!({ "text": "y".repeat(300) })));
        assert!(refused.is_empty() && held["answers"]["fetch"].is_object(), "{refused:?}");
        let (_, refused) = the_run(&told_answer(Value::Object(run), json!({ "text": "y".repeat(1200) })));
        assert!(refused["fetch"].contains("at most 1000 bytes"), "{refused:?}");
    }

    // A fact that starts a run by its recipe says who started it: the run keeps it and every handed-out step says it; a
    // router's fact names none, and the run has none.
    #[test]
    fn who_started_a_run_goes_with_it_and_a_routers_run_has_none() {
        let fact = |payload: Value| json!({ "input": {}, "cause": { "key": "k", "detail": { "kind": "workflow-chosen-from-rows", "event_id": "e1", "payload": payload } }, "context": {} });
        let (run, _) = the_run(&fact(json!({ "recipe": "workflow:x", "started_by": "person:ana", "input": { "a": 1 } })));
        assert_eq!(run["started_by"], "person:ana");
        assert_eq!(run["recipe"], "workflow:x");
        assert!(run["input"]["fact"].get("started_by").is_none(), "it is the run's, not the workflow's input");
        let (routed, _) = the_run(&fact(json!({ "workflow": "workflow:x", "condition": "c" })));
        assert!(routed.get("started_by").is_none());
        let waiting = json!({ "step": "ask", "for": "person", "asks": {}, "started_by": "person:ana" });
        assert_eq!(effect_of(&waiting, json!({ "event_id": "k:ask" }), &door_asks(), "workflow:x")["arrive"]["payload"]["started_by"], "person:ana");
    }

    fn filler() -> Value {
        json!({ "tool": "tool:reader", "input": { "sql": "select id, fills from account_stores where account = $1 and is_default", "params": [] },
            "with": { "params.0": "account" }, "fills_at": "rows.0.fills", "from_at": "rows.0.id", "fills_absent": ["store", "uses_store"] })
    }

    fn fills_answer() -> Value {
        json!({ "rows": [{ "id": "record:account-store:a", "fills": { "store": { "credential_name": "runs" }, "uses_store": { "credential_name": "uses" } } }] })
    }

    // A bare start (no store) hands out its fill reader before anything else, even before its definition is read; the told
    // answer fills the input, says which row in filled_from, and the next step is the definition's reader.
    #[test]
    fn a_bare_start_reads_its_stores_from_the_account_row_first() {
        let given = json!({ "input": { "recipe": "workflow:x", "read_definition": reader(), "fill_input": filler(), "request": "a job" }, "cause": { "key": "k" }, "context": {} });
        let (run, refused) = the_run(&given);
        let (workflow, step, tool, asks) = pending_fill(&run, &refused, &json!({ "account_id": "acct-1" })).unwrap().expect("the fill reader is asked first");
        assert_eq!((workflow.as_str(), step.as_str(), tool.as_str()), ("workflow:x", workflow_engine::fill_input::STEP, "tool:reader"));
        assert_eq!(asks["params"], json!(["acct-1"]), "scoped to the account the run is for");
        let told = json!({ "input": {}, "cause": { "key": "k", "detail": { "kind": ANSWERED, "payload": {
            "workflow": "workflow:x", "run": run, "step": step, "for": tool, "result": fills_answer() } } }, "context": {} });
        let (run, refused) = the_run(&told);
        assert!(refused.is_empty());
        assert_eq!(run["input"], json!({ "request": "a job", "store": { "credential_name": "runs" }, "uses_store": { "credential_name": "uses" } }));
        assert_eq!(run["filled_from"], json!({ "store": "record:account-store:a", "uses_store": "record:account-store:a" }));
        assert!(run.get("answers").and_then(|answers| answers.get(&step)).is_none(), "the reader's answer is not held");
        assert!(pending_fill(&run, &refused, &json!({ "account_id": "acct-1" })).unwrap().is_none(), "filled once, never asked again");
        assert_eq!(reader_step(&run).as_deref(), Some(READ_STEP), "the definition is read next");
    }

    // A caller's own stores always win: nothing is asked, nothing filled.
    #[test]
    fn a_start_that_names_its_stores_is_never_filled() {
        let given = json!({ "input": { "definition": one_step("workflow:x", "tool:x"), "fill_input": filler(),
            "store": { "credential_name": "mine" }, "uses_store": { "credential_name": "mine-too" } }, "cause": { "key": "k" }, "context": {} });
        let (run, refused) = the_run(&given);
        assert!(pending_fill(&run, &refused, &json!({ "account_id": "acct-1" })).unwrap().is_none());
        assert!(run.get("filled_from").is_none());
        assert_eq!(run["input"]["store"], json!({ "credential_name": "mine" }));
    }

    // A fill reader whose tool failed fails the run, naming why, rather than walking with no store.
    #[test]
    fn a_failed_fill_reader_fails_the_run_in_its_words() {
        let given = json!({ "input": { "definition": one_step("workflow:x", "tool:x"), "fill_input": filler() }, "cause": { "key": "k" }, "context": {} });
        let (run, _) = the_run(&given);
        let refused = BTreeMap::from([(workflow_engine::fill_input::STEP.to_string(), "tool:reader failed (no table)".to_string())]);
        let why = pending_fill(&run, &refused, &json!({ "account_id": "acct-1" })).unwrap_err();
        assert!(why.contains("not filled") && why.contains("no table"), "{why}");
    }

    // A body kept in a sub-workflow's own uses is among the definitions the run walks.
    #[test]
    fn a_body_in_a_sub_workflows_uses_is_found() {
        let mut sub = json!({ "id": "workflow:sub", "name": "sub", "kind": "workflow", "is_active": true, "version": 1, "edges": [],
            "steps": [{ "id": "each", "kind": "loop", "config": { "definition_id": "workflow:body", "source": [], "item_var": "x" } }],
            "uses": [one_step("workflow:body", "tool:x")] });
        sub["uses"][0]["name"] = json!("body");
        let mut top = one_step("workflow:top", "tool:y");
        top["uses"] = json!([sub]);
        let given = json!({ "input": { "definition": top }, "cause": { "key": "k" }, "context": {} });
        let (run, _) = the_run(&given);
        let ids: Vec<String> = definitions_of(&run).iter().map(|d| d["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["workflow:top", "workflow:sub", "workflow:body"]);
    }

    fn uses_reader() -> Value {
        let mut reader = reader();
        reader["input"]["sql"] = json!("select recipe, definition, kept_at from workflow_recipes where recipe = $1 or recipe = any($2)");
        reader["uses_ids_at"] = json!("params.1");
        reader["uses_at"] = json!("rows");
        reader
    }

    fn walk_top(all: Vec<Value>, input: Value) -> Value {
        let definitions: Vec<workflow_core::Definition> = all.into_iter().map(|d| serde_json::from_value(d).unwrap()).collect();
        futures::executor::block_on(workflow_engine::run_definition_with_started_at(
            definitions, "workflow:top", input, "someone", "workflow", "2026-11-21T00:00:00Z", held())).unwrap()
    }

    // A workflow the run names that no uses holds (one chosen by a row) is read by the same reader, in the same ask as
    // the definition, once a walk reaches it; it is held to the run's pin like the definition.
    #[test]
    fn a_workflow_named_by_a_row_is_read_with_the_definition() {
        let mut top = one_step("workflow:top", "tool:y");
        top["steps"] = json!([{ "id": "pick", "kind": "action", "config": { "definition_id": "workflow:by-a-row" } }]);
        let mut run = json!({ "recipe": "workflow:top", "read_definition": uses_reader(), "input": {}, "answers": {} }).as_object().unwrap().clone();
        assert_eq!(reader_ask(&run["read_definition"].clone(), "workflow:top", &run)["params"], json!(["workflow:top", []]));
        let first = json!({ "rows": [{ "recipe": "workflow:top", "definition": top, "kept_at": "v1" }] });
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &first).unwrap().expect("walks with what it holds");
        assert!(missed_to_read(&mut run, &walk_top(all, json!({}))), "the walk reached it, so it is asked for");
        assert_eq!(run["uses_missing"], json!(["workflow:by-a-row"]));
        assert_eq!(reader_ask(&run["read_definition"].clone(), "workflow:top", &run)["params"], json!(["workflow:top", ["workflow:by-a-row"]]));
        let mut second = first.clone();
        second["rows"].as_array_mut().unwrap().push(json!({ "recipe": "workflow:by-a-row", "definition": one_step("workflow:by-a-row", "tool:z"), "kept_at": "v1" }));
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &second).unwrap().expect("walks now");
        let ids: Vec<&str> = all.iter().map(|d| d["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["workflow:top", "workflow:by-a-row"]);
        assert_eq!(run["answers"][READ_STEP]["uses"]["workflow:by-a-row"].as_str().unwrap().len(), 64);
        let mut changed = second.clone();
        changed["rows"][1]["definition"] = one_step("workflow:by-a-row", "tool:other");
        let why = read_definitions(&mut run, "workflow:top", READ_STEP, &changed).unwrap_err();
        assert!(why.contains("workflow:by-a-row") && why.contains("changed"), "{why}");
    }

    // A workflow chosen at run time from a family the step admits (`prefix*`) and held by no uses is read by the reader
    // once (the walk notes it as missed), then the run walks with it.
    #[test]
    fn a_family_member_added_by_a_row_is_read_when_chosen() {
        let mut top = one_step("workflow:top", "tool:y");
        top["steps"] = json!([{ "id": "each", "kind": "loop", "config": { "source": { "$kind": "binding", "select": { "from": "input", "path": "methods" } },
            "item_var": "method", "definition_id": { "$kind": "binding", "select": { "from": "loop", "path": "method" } }, "definition_refs": ["workflow:method-*"] } }]);
        let mut run = json!({ "recipe": "workflow:top", "read_definition": uses_reader(), "input": { "methods": ["workflow:method-new"] }, "answers": {} }).as_object().unwrap().clone();
        let walk = |all: Vec<Value>, run: &Map<String, Value>| {
            let definitions: Vec<workflow_core::Definition> = all.into_iter().map(|d| serde_json::from_value(d).unwrap()).collect();
            futures::executor::block_on(workflow_engine::run_definition_with_started_at(
                definitions, "workflow:top", run["input"].clone(), "someone", "workflow", "2026-11-21T00:00:00Z", held())).unwrap()
        };
        let first = json!({ "rows": [{ "recipe": "workflow:top", "definition": top, "kept_at": "v1" }] });
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &first).unwrap().expect("no literal id is missing");
        let walked = walk(all, &run);
        assert_eq!(walked["definitions_missed"], json!(["workflow:method-new"]), "{walked}");
        assert!(missed_to_read(&mut run, &walked), "read it");
        assert_eq!(run["uses_missing"], json!(["workflow:method-new"]));
        assert!(!missed_to_read(&mut run, &walked), "asked once, never again");
        let mut second = first.clone();
        second["rows"].as_array_mut().unwrap().push(json!({ "recipe": "workflow:method-new", "definition": one_step("workflow:method-new", "tool:z"), "kept_at": "v1" }));
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &second).unwrap().expect("walks");
        let walked = walk(all, &run);
        assert_ne!(walked["status"], "failed", "{walked}");
        assert!(walked.get("definitions_missed").is_none());
    }

    // A run that uses many workflows asks only for the ones its walk reaches, one step at a time, never all at once: School's
    // run (10:11 PM CST Nov 21 2026) asked for all 8 of its used rows in one answer, 142,901 bytes, over the engine's 131,072,
    // and hung. Here the walk waits on the first used workflow's ask, so only that one is read; the second is never asked.
    #[test]
    fn a_run_reads_only_the_used_workflows_its_walk_reaches() {
        let mut top = one_step("workflow:top", "tool:y");
        top["steps"] = json!([{ "id": "first", "kind": "action", "config": { "definition_id": "workflow:first" } },
                              { "id": "second", "kind": "action", "config": { "definition_id": "workflow:second" } }]);
        top["edges"] = json!([{ "from": "first", "to": "second", "kind": "always" }]);
        let mut run = json!({ "recipe": "workflow:top", "read_definition": uses_reader(), "input": {}, "answers": {} }).as_object().unwrap().clone();
        let first = json!({ "rows": [{ "recipe": "workflow:top", "definition": top, "kept_at": "v1" }] });
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &first).unwrap().expect("walks with what it holds");
        assert!(missed_to_read(&mut run, &walk_top(all, json!({}))));
        assert_eq!(run["uses_missing"], json!(["workflow:first"]), "only the one reached");
        let mut second = first.clone();
        second["rows"].as_array_mut().unwrap().push(json!({ "recipe": "workflow:first", "definition": one_step("workflow:first", "tool:z"), "kept_at": "v1" }));
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &second).unwrap().expect("walks");
        let walked = walk_top(all, json!({}));
        assert!(!missed_to_read(&mut run, &walked), "waiting on workflow:first's ask, it reaches nothing more: {walked}");
        assert_eq!(run["uses_missing"], json!(["workflow:first"]));
    }

    // A workflow that calls a workflow that calls a workflow (make-what-a-store-lacks calls run-statements-in-order, which is
    // its own row) is read a level at a time as the walk reaches each: the child once the top reaches it, the grandchild once
    // the child does, each by the same reader, until the walk waits on the grandchild's own ask.
    #[test]
    fn a_grandchild_workflow_is_read_when_the_walk_reaches_it() {
        let mut top = one_step("workflow:top", "tool:y");
        top["steps"] = json!([{ "id": "call-child", "kind": "action", "config": { "definition_id": "workflow:child" } }]);
        let mut child = one_step("workflow:child", "tool:y");
        child["steps"] = json!([{ "id": "call-grandchild", "kind": "action", "config": { "definition_id": "workflow:grandchild" } }]);
        let row = |id: &str, definition: Value| json!({ "recipe": id, "definition": definition, "kept_at": "v1" });
        let mut run = json!({ "recipe": "workflow:top", "read_definition": uses_reader(), "input": {}, "answers": {} }).as_object().unwrap().clone();
        let mut answer = json!({ "rows": [row("workflow:top", top)] });
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &answer).unwrap().unwrap();
        assert!(missed_to_read(&mut run, &walk_top(all, json!({}))));
        assert_eq!(run["uses_missing"], json!(["workflow:child"]));
        answer["rows"].as_array_mut().unwrap().push(row("workflow:child", child));
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &answer).unwrap().unwrap();
        let walked = walk_top(all, json!({}));
        assert!(missed_to_read(&mut run, &walked), "the child reached the grandchild: {walked}");
        assert_eq!(run["uses_missing"], json!(["workflow:child", "workflow:grandchild"]));
        answer["rows"].as_array_mut().unwrap().push(row("workflow:grandchild", one_step("workflow:grandchild", "tool:z")));
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &answer).unwrap().unwrap();
        let walked = walk_top(all, json!({}));
        assert!(!missed_to_read(&mut run, &walked), "nothing more to read: {walked}");
        assert_ne!(walked["status"], "failed", "{walked}");
    }

    // A run that fails tells its end recorder first, holding why, and the answer back fails it with those words; a run with
    // no recorder fails at once. A finished or skipped run tells its recorder as an effect; a paused one tells nothing.
    #[test]
    fn a_runs_end_is_told_to_its_recorder_and_a_failure_before_it_fails() {
        let recorder = json!({ "tool": "tool:keep", "input": { "sql": "update wf_runs set status = $2, why = $3 where run_id = $1", "params": [] },
            "with": { "params.0": "run", "params.1": "status" }, "with_if_given": { "params.2": "why" } });
        let run = json!({ "run": "cause-1", "on_end": recorder, "input": {} }).as_object().unwrap().clone();
        assert_eq!(end_effect(&run, "completed", "workflow:x", None),
            Some(json!({ "wake": { "tool": "tool:keep", "input": { "sql": "update wf_runs set status = $2, why = $3 where run_id = $1", "params": ["cause-1", "completed", null] } } })));
        assert_eq!(end_effect(&run, "failed", "workflow:x", Some("too large")).unwrap()["wake"]["input"]["params"], json!(["cause-1", "failed", "too large"]));
        assert!(end_effect(&run, "paused", "workflow:x", None).is_none());
        let none = json!({ "run": "cause-1", "input": {} }).as_object().unwrap().clone();
        assert!(end_effect(&none, "completed", "workflow:x", None).is_none());
        // A failing run hands out its recorder with why, holding it as `ended`; the answer back fails it with those words.
        let read = json!({ "recipe": "workflow:x", "read_definition": reader(), "on_end": recorder, "run": "cause-1", "input": {}, "answers": {} });
        let why = "the definition of workflow:x was not read: tool:reader failed (answer-too-large): 142901 bytes";
        let out = ending(read.as_object().unwrap().clone(), "workflow:x", why).expect("told first");
        assert_eq!(out["result"]["status"], "paused");
        let effect = &out["wake_effects"][0]["wake"];
        assert_eq!(effect["tool"], "tool:keep");
        assert_eq!(effect["input"]["params"], json!(["cause-1", "failed", why]));
        let told = &effect["reply"]["payload"];
        assert_eq!(told["step"], END_STEP);
        assert_eq!(told["run"]["ended"], why, "the failure rides with the run");
        let carried = told["run"].as_object().unwrap().clone();
        assert!(ending(carried.clone(), "workflow:x", why).is_none(), "told once, never again");
        assert_eq!(ended_why(&carried, &json!({ "result": { "row_count": 1 } })), why);
        assert!(ended_why(&carried, &json!({ "error": "refused" })).ends_with("(its end was not recorded: refused)"));
        let unrecorded = json!({ "recipe": "workflow:x", "run": "cause-1", "input": {} }).as_object().unwrap().clone();
        assert!(ending(unrecorded, "workflow:x", why).is_none(), "no recorder: it fails at once");
    }

    // The end recorder belongs to the run, not to one wake's input: a run that names a reader (any wake's: a chosen run, an
    // answered step resumed from its envelope, a row change) records its end in its reader's database from run-end.json,
    // upserting its row, and a failure writes its why (Nov 22 2026: every resumed run's row stayed started).
    #[test]
    fn every_run_with_a_reader_records_its_end_whichever_wake_drove_it() {
        let reader = json!({ "tool": "tool:run-sql-in-my-database", "input": { "database": "runs_db", "sql": "select", "params": [] },
            "recipe_at": "params.0" });
        // Resumed by an answered step: the run is the envelope carried back, holding its reader and no on_end.
        let envelope = json!({ "recipe": "workflow:x", "read_definition": reader, "run": "cause-1", "input": {}, "answers": {} });
        let given = json!({ "input": {}, "cause": { "key": "answer-9", "detail": { "kind": ANSWERED, "payload": {
            "workflow": "workflow:x", "run": envelope, "step": "read-state", "for": "tool:read", "result": { "rows": [] } } } }, "context": {} });
        let (resumed, _) = the_run(&given);
        let effect = end_effect(&resumed, "completed", "workflow:x", None).expect("the resumed run records its end");
        assert_eq!(effect["wake"]["tool"], "tool:run-sql-in-my-database");
        assert_eq!(effect["wake"]["input"]["database"], "runs_db", "in its own reader's database");
        assert_eq!(effect["wake"]["input"]["params"], json!(["cause-1", "completed", null, "workflow:x"]));
        assert!(effect["wake"]["input"]["sql"].as_str().unwrap().contains("ON CONFLICT (run_id) DO UPDATE"), "a missing start row is upserted");
        // Started by a row-change wake: its switch hands the recipe and the reader; the same recorder.
        let started = json!({ "input": { "recipe": "workflow:x", "read_definition": reader, "row": "calendar_tasks" }, "cause": { "key": "change-1" }, "context": {} });
        let (changed, _) = the_run(&started);
        assert_eq!(end_effect(&changed, "completed", "workflow:x", None).unwrap()["wake"]["input"]["params"][0], "change-1");
        // A failure writes its why, through the same recorder.
        let out = ending(resumed.clone(), "workflow:x", "workflow:x: step read-state failed").expect("told before it fails");
        assert_eq!(out["wake_effects"][0]["wake"]["input"]["params"], json!(["cause-1", "failed", "workflow:x: step read-state failed", "workflow:x"]));
        // A run's own on_end still wins; a run with no reader database records nothing.
        let mut own = resumed.clone();
        own.insert("on_end".into(), json!({ "tool": "tool:keep", "input": { "params": [] }, "with": { "params.0": "run" } }));
        assert_eq!(end_effect(&own, "completed", "workflow:x", None).unwrap()["wake"]["tool"], "tool:keep");
        let bare = json!({ "run": "cause-2", "input": {} }).as_object().unwrap().clone();
        assert!(end_effect(&bare, "completed", "workflow:x", None).is_none());
    }

    // A run that ends well asks its recorder with a reply: the answer back says the end was kept, and a refused record
    // fails the run in words instead of vanishing.
    #[test]
    fn a_record_of_a_runs_end_comes_back_to_the_run() {
        let reader = json!({ "tool": "tool:run-sql-in-my-database", "input": { "database": "runs_db", "sql": "select", "params": [] } });
        let run = json!({ "recipe": "workflow:x", "read_definition": reader, "run": "cause-1", "input": {}, "answers": {} }).as_object().unwrap().clone();
        let effect = end_told(&run, "completed", "workflow:x", None, &door_asks()).expect("recorded");
        let reply = &effect["wake"]["reply"];
        assert_eq!(effect["wake"]["tool"], "tool:run-sql-in-my-database");
        assert_eq!(reply["payload"]["step"], END_STEP);
        assert_eq!(reply["payload"]["run"]["ended_as"], "completed");
        assert!(end_told(&run, "paused", "workflow:x", None, &door_asks()).is_none(), "a paused pass records nothing");
        let carried = reply["payload"]["run"].as_object().unwrap().clone();
        let kept = after_end(&carried, &json!({ "workflow": "workflow:x", "result": { "row_count": 1 } })).unwrap();
        assert_eq!((kept["result"]["status"].as_str(), kept["result"]["recorded"].as_bool()), (Some("completed"), Some(true)));
        let why = after_end(&carried, &json!({ "workflow": "workflow:x", "error": "process_exit_unsuccessful", "said": "no such table" })).unwrap_err();
        assert_eq!(why, "workflow:x completed, but its end was not recorded (process_exit_unsuccessful: no such table)");
    }

    // A workflow no place holds is not asked for forever: once asked for and still missing, the run walks and the step that
    // names it fails, naming where the engine looked.
    #[test]
    fn a_workflow_no_place_holds_fails_its_step_naming_where_it_looked() {
        let mut top = one_step("workflow:top", "tool:y");
        top["steps"] = json!([{ "id": "pick", "kind": "action", "config": { "definition_id": "workflow:nowhere" } }]);
        let mut run = json!({ "recipe": "workflow:top", "read_definition": uses_reader(), "input": {}, "answers": {}, "uses_missing": ["workflow:nowhere"] }).as_object().unwrap().clone();
        let answer = json!({ "rows": [{ "recipe": "workflow:top", "definition": top, "kept_at": "v1" }] });
        let all = read_definitions(&mut run, "workflow:top", READ_STEP, &answer).unwrap().expect("walks");
        let definitions: Vec<workflow_core::Definition> = all.into_iter().map(|d| serde_json::from_value(d).unwrap()).collect();
        let walked = futures::executor::block_on(workflow_engine::run_definition_with_started_at(
            definitions, "workflow:top", json!({}), "someone", "workflow", "2026-11-21T00:00:00Z", held())).unwrap();
        assert_eq!(walked["status"], "failed", "{walked}");
        let why = walked["error_message"].as_str().unwrap_or_default();
        assert!(why.contains("workflow:nowhere") && why.contains("uses") && why.contains("rows"), "{why}");
    }
}
