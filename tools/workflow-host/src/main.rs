// wf: work inside a run of one of the person's workflows, on the workflow engine (workflow-core), from any chat.
//   wf find WORDS... [--kinds K1,K2]   the workflows for this moment, from the rows of the person's stores: ranked by the words over each
//                                      workflow's name, job and steps; with --kinds, the account's own chooser
//                                      (tool:choose-the-workflows-that-fire) picks by those kinds of moment and the words break ties
//   wf kinds [WORDS...]                the kinds of moment the workflows wait for, nearest the words first
//   wf start WORKFLOW_ID [INPUT_JSON | - | @FILE]  start a run (- reads the input from stdin, @FILE from a file, so it never shows on argv); prints where it stopped and what each waiting step asks
//   wf answer RUN STEP ANSWER_JSON|-|@FILE  answer a step that is waiting for whoever holds the run, and go on; the engine refuses
//                                      an answer that does not fit the step's `submit` shape and names each miss
//   wf show RUN                        where the run is now
//   wf cancel RUN                      stop a run for good: it is never run again and shows as cancelled
//   wf record RUN [--keep]             the path the run's work took, read from the chats' own transcripts; --keep writes it to
//                                      recorded_paths (a run that completes keeps it by itself)
// RUN is the run's folder, its name under $WF_HOME/runs, or its first part (the number before the workflow).
// A run is answered only by the chat that started it (its CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID, else $WF_ACTOR), or by an
// answerer its person names in the answer_rights table (the run's person is RUN_PERSON, stamped at start).
// Every run is a folder under $WF_HOME/runs. Workflows are read from the rows of the person's own stores (workflow_recipes), so a
// row changed in its store is what the next wf command reads; no Workshop commit is involved.
// Built by build.sh beside this file, as an example of the workflow-engine crate at current main.
use std::{collections::{BTreeMap, BTreeSet}, io::Write, process::{Command, Stdio}, sync::{Arc, Mutex}};
use serde_json::{json, Value};
use workflow_engine::Host;

fn expand(path: &str) -> String { match path.strip_prefix("~/") { Some(rest) => format!("{}/{rest}", home()), None => path.to_string() } }

fn config() -> &'static Value {
    static CONFIG: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    CONFIG.get_or_init(|| {
        let path = std::env::var("WF_CONFIG").unwrap_or_else(|_| format!("{}/wf.json", wf_home()));
        match std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()) {
            Some(value) => value,
            None => { eprintln!("wf: no settings at {path} (a wf.json with cli, pin, person, host, workshop, runs_database, stores)"); std::process::exit(1); }
        }
    })
}

fn setting(name: &str) -> String {
    match config()[name].as_str() {
        Some(value) => expand(value),
        None => { eprintln!("wf: wf.json names no {name}"); std::process::exit(1); }
    }
}

fn wf_pin() -> String { std::env::var("WF_PIN").unwrap_or_else(|_| setting("pin")) }

fn run_person() -> String { setting("person") }

fn claude_projects() -> String { std::env::var("WF_TRANSCRIPTS").unwrap_or_else(|_| format!("{}/.claude/projects", home())) }




fn own_index() -> Vec<Value> {
    const SQL: &str = "select recipe, title, fires_when, coalesce(definition->>'name', title) as job, coalesce((select string_agg(case when jsonb_typeof(s->'config'->'context'->'title') = 'string' then s->'config'->'context'->>'title' else '' end || ' ' || case when jsonb_typeof(s->'config'->'input'->'do') = 'string' then s->'config'->'input'->>'do' else '' end, ' ') from jsonb_array_elements(coalesce(definition->'steps', '[]'::jsonb)) s), '') as words from workflow_recipes where definition is not null order by recipe";
    let mut entries = vec![];
    for store in config()["stores"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        match sql_read(store, SQL, json!([])) {
            Ok(rows) => for row in rows {
                let Some(id) = row["recipe"].as_str().map(String::from) else { continue };
                let mut kinds = BTreeSet::new();
                fn walk(node: &Value, kinds: &mut BTreeSet<String>) {
                    if node["kind"] == "rule" && node["field"] == "kinds" { for v in node["params"]["values"].as_array().into_iter().flatten().filter_map(Value::as_str) { kinds.insert(v.to_string()); } }
                    for child in node["rules"].as_array().into_iter().flatten() { walk(child, kinds); }
                }
                for entry in row["fires_when"].as_array().into_iter().flatten() { if entry["state"] != "Off" { walk(&entry["condition"]["tree"], &mut kinds); } }
                // The store is named by its credential, as the person's own stores always were (`{database}-connection`).
                entries.push(json!({ "id": id, "label": row["title"], "job": row["job"], "kinds": kinds, "words": row["words"], "own": format!("{store}-connection") }));
            },
            Err(why) => eprintln!("wf: the kept workflows of {store} could not be read ({why}); find does not rank them"),
        }
    }
    entries
}

fn own_definition(recipe: &str) -> Option<Value> {
    const SQL: &str = "select recipe, title, definition, input_schema from workflow_recipes where recipe = $1 and definition is not null";
    for store in config()["stores"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let Ok(rows) = sql_read(store, SQL, json!([recipe])) else { eprintln!("wf: {recipe} could not be read from {store}"); continue };
        let Some(row) = rows.into_iter().next() else { continue };
        let mut definition = row["definition"].clone();
        let fields = definition.as_object_mut()?;
        fields.entry("id").or_insert(json!(recipe));
        fields.entry("name").or_insert(row["title"].clone());
        fields.entry("kind").or_insert(json!("workflow"));
        fields.entry("is_active").or_insert(json!(true));
        fields.entry("version").or_insert(json!(1));
        fields.entry("edges").or_insert(json!([]));
        // The row's input_schema (workflow_recipes.input_schema) is the contract a start's input is checked against.
        if row["input_schema"].is_object() { fields.entry("input_schema").or_insert(row["input_schema"].clone()); }
        return Some(definition);
    }
    None
}

fn definition_named(id: &str) -> Value { own_definition(id).unwrap_or(Value::Null) }

fn door(mut request: Value) -> Result<std::process::Output, String> {
    request["cli"] = json!(setting("cli"));
    if let Some(fields) = request.as_object_mut() { fields.retain(|_, value| !value.is_null()); }
    let program = installed_door_op()?;
    let mut child = Command::new("node").arg(&program).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).map_err(|e| e.to_string())?;
    child.wait_with_output().map_err(|e| e.to_string())
}

// The door program the installed Workshop tree holds: the engine's pinned, landed copy, so it is never a lane's unlanded edit. The
// commit it is named by is said on stderr (the installed tree's own record: its address ends in the commit it was downloaded from).
fn installed_door_op() -> Result<String, String> {
    const DOOR: &str = "tools/use-your-tools-from-a-shell/do-work/door-op.mjs";
    let tree = installed_tree()?;
    let commit = read(&format!("{tree}.json"))["address"].as_str().and_then(|address| address.rsplit('/').next()).unwrap_or("unknown").to_string();
    eprintln!("wf: the door program is the installed Workshop's {DOOR} at commit {commit}");
    Ok(format!("{tree}/{DOOR}"))
}

fn database_of(store: &str) -> String { store.strip_suffix("-connection").unwrap_or(store).to_string() }

fn sql_read(database: &str, sql: &str, params: Value) -> Result<Vec<Value>, String> {
    let mut last = String::new();
    for attempt in 0..3u64 {
        match sql_rows(database, sql, params.clone()) {
            Ok(rows) => return Ok(rows),
            Err(why) => { last = why; std::thread::sleep(std::time::Duration::from_secs(1 + attempt)); }
        }
    }
    Err(last)
}

fn sql_rows(database: &str, sql: &str, params: Value) -> Result<Vec<Value>, String> {
    let out = door(json!({ "kind": "op", "method": "tools:run", "pins": [wf_pin()],
        "input": { "tool": "tool:run-sql-in-my-database", "input": { "database": database, "sql": sql, "params": params } } }))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    let answer: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    if answer["exit_code"].as_i64().unwrap_or(0) != 0 {
        let why = [&answer["error"], &answer["result"]["error"]].into_iter().find(|v| !v.is_null()).map(|v| v.to_string());
        return Err(why.unwrap_or_else(|| "no reason given".into()));
    }
    Ok(answer["result"]["rows"].as_array().cloned().unwrap_or_default())
}

fn json_text(given: &str, stdin: impl FnOnce() -> std::io::Result<String>) -> Result<String, String> {
    if given == "-" { return stdin().map_err(|_| "could not read the JSON from standard input".to_string()); }
    match given.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).map_err(|e| format!("could not read the JSON from {path}: {e}")),
        None => Ok(given.to_string()),
    }
}

fn home() -> String { std::env::var("HOME").unwrap_or_default() }
fn wf_home() -> String {
    std::env::var("WF_HOME").unwrap_or_else(|_| std::env::current_exe().ok().and_then(|exe| exe.parent()?.parent().map(|p| p.display().to_string())).unwrap_or_default())
}
fn runs_dir() -> String { format!("{}/runs", wf_home()) }
fn read(p: &str) -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|_| "null".into())).unwrap_or(Value::Null) }
fn keep_pick(line: Value) {
    let mut line = line;
    line["at"] = json!(now_utc());
    line["cwd"] = json!(std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}/picks.jsonl", wf_home())) {
        let _ = writeln!(file, "{line}");
    }
}
fn now_utc() -> String {
    Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}
/// The step an ask is answered under, as the workflow component names it (workflow-component src/main.rs step_of): its
/// place in the run (`_runtime_identity`, distinct for each loop iteration and used workflow, the same on every replay)
/// when nested, e.g. `each_iter_1/post-the-slide`, else its own step id. So each item of a loop is a step of its own.
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
// Who is working: $WF_ACTOR, else the chat's own session id, else nothing known.
fn actor() -> String {
    ["WF_ACTOR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID"].iter()
        .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty())).unwrap_or_default()
}
// The person every run acts for (the one go() runs each run as); written as person.json beside started_by.json at start.

// What a bare start leaves out (no store) is filled from the account's own row, by the same reader and the same code the
// workflow component uses (workflow_engine::fill_input): the reader is the person's DATA, $WF_FILL_INPUT (JSON) else
// the signed-in account's default account_stores row in their runs store, scoped by the account `{cli} whoami` signs
// in as (never a name in code). A caller's own store always wins; the run keeps filled_from.json.
fn fill_reader() -> Value {
    std::env::var("WF_FILL_INPUT").ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({
        "tool": "tool:run-sql-in-my-database",
        "input": { "database": setting("runs_database"),
            "sql": "SELECT id, fills FROM account_stores WHERE account = $1 AND CASE WHEN $2::text IS NULL THEN is_default ELSE fills->'store'->>'credential_name' = CASE WHEN left($2::text, 1) = '{' THEN ($2::text)::jsonb->>'credential_name' ELSE $2::text END END ORDER BY set_at DESC LIMIT 1", "params": [] },
        "with": { "params.0": "account" }, "with_if_given": { "params.1": "input.store" },
        "when_no_row": "uses_store_not_paired: no account_stores row holds the given store {store.credential_name|store}",
        "fills_at": "rows.0.fills", "from_at": "rows.0.id", "fills_absent": ["store", "uses_store"],
        "rows_at": "rows", "retry_seconds": [2, 4, 8] }))
}

// What a store fill came to. Only a read that worked and found no row is a refusal ("not paired"); a read that failed (the
// door did not answer, the tool failed, or it answered no rows list at the reader's rows_at) is tried again after each of
// the reader's retry_seconds and then is a stated read failure, never absence. Nov 22 2026, 1:38-2:16 AM CST: under load the
// door's tools:run timed out, OneRule::ask answered its "not answered yet" marker, and fill_input::apply read that as no
// row, cancelling three seed-breakdown runs "uses_store_not_paired" while record:account-store:<person>:<host> was there.
enum Fill { Filled(serde_json::Map<String, Value>), Refused(String), ReadFailed(String) }
async fn fill_store(given: &mut Value) -> Fill {
    let reader = fill_reader();
    if !workflow_engine::fill_input::wanted(&reader, given) { return Fill::Filled(serde_json::Map::new()); }
    let step = workflow_engine::fill_input::step(&reader);
    let (tool, asks) = match workflow_engine::fill_input::ask(&reader, &json!({ "account": signed_in_account(), "input": given })) {
        Ok(asked) => asked,
        Err(why) => return Fill::Refused(why.words),
    };
    let waits: Vec<u64> = reader["retry_seconds"].as_array().map(|all| all.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
    let rows_at = reader["rows_at"].as_str().map(str::to_owned);
    let mut failure = String::new();
    for attempt in 0..=waits.len() {
        if attempt > 0 {
            eprintln!("the store read failed ({failure}); trying again in {} s", waits[attempt - 1]);
            std::thread::sleep(std::time::Duration::from_secs(waits[attempt - 1]));
        }
        let host = OneRule { answers: Mutex::new(BTreeMap::new()), file: fill_answers_file(), waiting: Mutex::new(vec![]) };
        let context = serde_json::to_vec(&json!({ "step_id": step })).unwrap();
        let answer = match host.ask(&tool, serde_json::to_vec(&asks).unwrap(), Some(context)).await
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())) {
            Ok(answer) => answer,
            Err(why) => { failure = why; continue; }
        };
        match workflow_engine::fill_input::apply(&reader, given, &answer) {
            Ok(filled) => return Fill::Filled(filled),
            Err(why) if why.kind == workflow_engine::fill_input::FillKind::ReadFailed => {
                // Named for the person as the answer's shape shows it (its rows list missing), else as fill_input says it.
                failure = match rows_at.as_deref().filter(|path| !path.split('.').fold(&answer, |at, key| &at[key]).is_array()) {
                    Some(path) => format!("{tool} answered no {path} list: {}", answer.to_string().chars().take(300).collect::<String>()),
                    None => why.words,
                };
            }
            Err(why) => return Fill::Refused(why.words),
        }
    }
    Fill::ReadFailed(format!("the store read failed after {} tries: {failure}", waits.len() + 1))
}
// The signed-in account (`{cli} whoami --json` account_id), empty when none is signed in.
fn signed_in_account() -> String {
    Command::new(setting("cli")).args(["whoami", "--json"]).stderr(Stdio::null()).output().ok()
        .and_then(|out| serde_json::from_slice::<Value>(&out.stdout).ok())
        .and_then(|who| who["account_id"].as_str().map(str::to_owned)).unwrap_or_default()
}
// Who may answer for a person's runs is a row: answer_rights(person, actor) in the runs database.
// A chat that is neither the run's starter nor one of its person's answerers is refused; a run with no person stamp is refused too.
fn holder_refusal(run: &str) -> Option<String> {
    let owner = read(&format!("{run}/started_by.json")).as_str().unwrap_or_default().to_string();
    let me = actor();
    if owner.is_empty() || me.is_empty() || owner == me { return None; }
    let person = read(&format!("{run}/person.json")).as_str().unwrap_or_default().to_string();
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || ":_-.".contains(c));
    let allowed = match plain(&person) && plain(&me) {
        false => false,
        true => match sql_read(&setting("runs_database"), "select actor from answer_rights where person = $1 and actor = $2", json!([person, me])) {
            Ok(rows) => rows.iter().any(|row| row["actor"] == me.as_str()),
            Err(e) => { eprintln!("could not read answer_rights: {e}"); false }
        },
    };
    if allowed { return None; }
    Some(format!("run {run} was started by {owner}, not by this chat ({me}); start your own run"))
}
// The run's folder from a full path, a folder name under runs, or the number it starts with (refused when it names two).
fn run_of(given: &str) -> String {
    if std::path::Path::new(&format!("{given}/definition.json")).exists() { return given.to_string(); }
    let named = format!("{}/{given}", runs_dir());
    if std::path::Path::new(&format!("{named}/definition.json")).exists() { return named; }
    let matching: Vec<String> = std::fs::read_dir(runs_dir()).into_iter().flatten().flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string()).filter(|name| name.starts_with(&format!("{given}-"))).collect();
    match matching.as_slice() {
        [one] => format!("{}/{one}", runs_dir()),
        [] => { eprintln!("no run {given} under {}", runs_dir()); std::process::exit(1); }
        many => { eprintln!("{given} names {} runs: {}; give the whole name", many.len(), many.join(", ")); std::process::exit(1); }
    }
}


/// The person's own kept workflows (workflow_recipes in each pursuit database named by $WF_STORES), read directly by
/// own-workflows.mjs beside this file; each as an index entry plus its definition. A store that cannot be read adds nothing.

const COMMON: &[&str] = &["a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "it", "its", "be", "by", "with", "this", "that", "from", "as", "at",
    "are", "was", "so", "do", "my", "me", "i", "we", "our", "his", "her", "their", "they", "them", "you", "your", "what", "when", "which", "who", "how", "not", "no", "one", "each", "every"];
fn stem(word: &str) -> String {
    let w = word.to_string();
    for end in ["ings", "ing", "ers", "ies", "ied", "ed", "es", "er", "s"] {
        if w.len() > end.len() + 3 && w.ends_with(end) { return w[..w.len() - end.len()].to_string(); }
    }
    w
}
fn words_of(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1 && !COMMON.contains(w)).map(stem).collect()
}

/// BM25 over each workflow's name and job (counted twice) and its steps' words; returns id -> score.
fn word_scores(index: &[Value], query: &[String]) -> BTreeMap<String, f64> {
    let docs: Vec<(String, Vec<String>)> = index.iter().map(|w| {
        let head = format!("{} {} {}", w["id"].as_str().unwrap_or("").replace(['-', ':'], " "), w["label"].as_str().unwrap_or(""), w["job"].as_str().unwrap_or(""));
        let mut terms = words_of(&head);
        terms.extend(words_of(&head));
        terms.extend(words_of(w["words"].as_str().unwrap_or("")));
        (w["id"].as_str().unwrap_or("").to_string(), terms)
    }).collect();
    let n = docs.len().max(1) as f64;
    let average = docs.iter().map(|(_, t)| t.len()).sum::<usize>() as f64 / n;
    let wanted: BTreeSet<&String> = query.iter().collect();
    let mut holding: BTreeMap<&String, usize> = BTreeMap::new();
    for (_, terms) in &docs { for q in &wanted { if terms.contains(q) { *holding.entry(q).or_default() += 1; } } }
    docs.iter().filter_map(|(id, terms)| {
        let score: f64 = wanted.iter().map(|q| {
            let tf = terms.iter().filter(|t| t == q).count() as f64;
            if tf == 0.0 { return 0.0; }
            let df = *holding.get(q).unwrap_or(&0) as f64;
            let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
            idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * terms.len() as f64 / average))
        }).sum();
        (score > 0.0).then(|| (id.clone(), score))
    }).collect()
}
fn kinds_vocabulary(index: &[Value]) -> BTreeMap<String, Vec<String>> {
    let mut kinds: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for w in index { for k in w["kinds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        kinds.entry(k.to_string()).or_default().push(w["label"].as_str().unwrap_or("").to_string());
    } }
    kinds
}
fn find(args: &[String]) {
    let mut words = vec![]; let mut kinds: Vec<String> = vec![];
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--kinds" { kinds = args.get(i + 1).map(|k| k.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default(); i += 2; }
        else { words.push(args[i].clone()); i += 1; }
    }
    let index = own_index();
    let by_id: BTreeMap<String, &Value> = index.iter().map(|w| (w["id"].as_str().unwrap_or("").to_string(), w)).collect();
    let text = words.join(" ");
    let scores = word_scores(&index, &words_of(&text));
    let vocabulary = kinds_vocabulary(&index);
    let unknown: Vec<&String> = kinds.iter().filter(|k| !vocabulary.contains_key(*k)).collect();
    if !unknown.is_empty() { eprintln!("wf: no workflow waits for the kind(s) {unknown:?}; see `wf kinds {text}`"); }
    let mut ranked: Vec<(String, f64, f64)> = vec![]; // id, chooser score, word score
    let mut chooser_said = Value::Null;
    if !kinds.is_empty() {
        let part = json!({ "parts": [{ "words": text, "kinds": kinds }] });
        let out = Command::new(setting("cli")).args(["call", "tool:choose-the-workflows-that-fire", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().and_then(|mut c| { c.stdin.take().unwrap().write_all(part.to_string().as_bytes())?; c.wait_with_output() });
        let reply: Value = out.ok().and_then(|o| serde_json::from_slice(&o.stdout).ok()).unwrap_or(Value::Null);
        let chosen = reply["result"]["chosen"].as_array().cloned();
        match chosen {
            Some(chosen) => {
                for c in chosen {
                    let id = c["workflow"].as_str().unwrap_or("").to_string();
                    if ranked.iter().any(|r| r.0 == id) { continue; }
                    let s = scores.get(&id).copied().unwrap_or(0.0);
                    ranked.push((id, c["score"].as_f64().unwrap_or(0.0), s));
                }
                chooser_said = json!({ "chosen": ranked.len() });
            }
            None => eprintln!("wf: the chooser tool did not answer ({}); ranking by words only", reply["error"].as_str().or(reply["message"].as_str()).unwrap_or("no reply")),
        }
        ranked.sort_by(|a, b| (b.1 + b.2).partial_cmp(&(a.1 + a.2)).unwrap());
    }
    let mut by_words: Vec<(&String, &f64)> = scores.iter().filter(|(id, _)| !ranked.iter().any(|r| &r.0 == *id)).collect();
    by_words.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap());
    let show = |id: &str, why: String| {
        let w = by_id.get(id);
        let own = w.and_then(|w| w["own"].as_str()).map(|store| format!("  (kept in {store})")).unwrap_or_default();
        println!("{why}  {id}{own}\n      {}", w.and_then(|w| w["job"].as_str()).unwrap_or("").chars().take(200).collect::<String>());
    };
    if !ranked.is_empty() { println!("Chosen by the kinds {kinds:?} (the account's chooser), the words breaking ties:"); }
    for (id, c, s) in ranked.iter().take(8) { show(id, format!("{:5.1} (kinds {c:.1} + words {s:.1})", c + s)); }
    if !by_words.is_empty() { println!("{}", if ranked.is_empty() { "By the words:" } else { "Also near the words:" }); }
    for (id, s) in by_words.iter().take(if ranked.is_empty() { 8 } else { 3 }) { show(id, format!("{s:5.1} (words)")); }
    if kinds.is_empty() {
        let mut near: BTreeMap<String, usize> = BTreeMap::new();
        for (id, _) in by_words.iter().take(8) { for k in by_id.get(*id).and_then(|w| w["kinds"].as_array()).into_iter().flatten().filter_map(Value::as_str) { *near.entry(k.into()).or_default() += 1; } }
        let mut near: Vec<_> = near.into_iter().collect();
        near.sort_by(|a, b| b.1.cmp(&a.1));
        if !near.is_empty() { println!("Kinds of moment these wait for: {}\nName the kinds that fit this moment: wf find {text} --kinds K1,K2", near.iter().take(8).map(|(k, n)| format!("{k} ({n})")).collect::<Vec<_>>().join(", ")); }
    }
    if ranked.is_empty() && by_words.is_empty() { println!("No workflow fits these words. Say so in one line and work plainly."); }
    keep_pick(json!({ "command": "find", "words": text, "kinds": kinds, "chooser": chooser_said,
        "top": ranked.iter().map(|r| r.0.clone()).chain(by_words.iter().map(|w| w.0.clone())).take(5).collect::<Vec<_>>() }));
}
fn list_kinds(args: &[String]) {
    let index = own_index();
    let vocabulary = kinds_vocabulary(&index);
    let query: BTreeSet<String> = words_of(&args.join(" ")).into_iter().collect();
    let mut rows: Vec<(usize, &String, &Vec<String>)> = vocabulary.iter().map(|(k, labels)| {
        let here: BTreeSet<String> = words_of(&format!("{} {}", k.replace('-', " "), labels.join(" "))).into_iter().collect();
        (query.intersection(&here).count(), k, labels)
    }).collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.2.len().cmp(&a.2.len())));
    for (_, k, labels) in rows.iter().take(if query.is_empty() { usize::MAX } else { 15 }) {
        println!("{k} ({})  e.g. {}", labels.len(), labels.iter().take(2).cloned().collect::<Vec<_>>().join("; "));
    }
}
struct OneRule { answers: Mutex<BTreeMap<String, Value>>, file: String, waiting: Mutex<Vec<Value>> }

#[async_trait::async_trait]
impl Host for OneRule {
    async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        let ctx: Value = serde_json::from_slice(&context.unwrap_or_default()).unwrap_or(Value::Null);
        let step = step_of(&ctx);
        if let Some(kept) = self.answers.lock().unwrap().get(&step).cloned() {
            eprintln!("  {step}: answered from what is kept ({name})");
            return Ok(serde_json::to_vec(&kept).unwrap());
        }
        let input: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        let on_this_computer = !name.contains(':') && Command::new("/usr/bin/which").arg(name).stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if on_this_computer {
            let argv: Vec<String> = input["argv"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            let stdin = match &input["stdin"] { Value::String(text) => text.clone(), Value::Null => String::new(), other => other.to_string() };
            let started = std::time::Instant::now();
            let mut child = Command::new(name).args(&argv).current_dir(input["cwd"].as_str().unwrap_or(".")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
                .spawn().map_err(|e| e.to_string())?;
            child.stdin.take().unwrap().write_all(stdin.as_bytes()).map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            // The whole output when it is one JSON object (a CLI that prints it over several lines), else its last line that is.
            let parsed = serde_json::from_str::<Value>(text.trim()).ok().filter(|v| v.is_object())
                .or_else(|| text.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok().filter(|v| v.is_object())));
            if !out.status.success() {
                // A program that exits non-zero fails its step in its own words, as a failed tool does.
                let both = format!("{}{}", text, String::from_utf8_lossy(&out.stderr));
                let said = format!("{name} exited {:?}: {}", out.status.code(), both.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>());
                eprintln!("  {step}: {said}");
                return Err(said);
            }
            let answer = parsed.unwrap_or_else(|| json!({ "stdout": text, "exit_code": out.status.code() }));
            eprintln!("  {step}: answered by the program {name} on this computer in {:.1} s", started.elapsed().as_secs_f32());
            self.keep(&step, &answer)?;
            return Ok(serde_json::to_vec(&answer).unwrap());
        }
        // Every tool step asks the account through the door's tools:run, so the engine hands the run its host actions (files,
        // nested runs) the way the workflow component's wake effect does. A step whose input is exactly {"call": {name, arguments}}
        // is sent as {tool, call}; any other as {tool, input}. The answer is the door's whole reply ({result, tool}).
        if name.starts_with("tool:") {
            // {"call": ..., "upload": "/full/path"} also sends that file's bytes as the call's raw body ({cli} op --upload),
            // which tool:your-files' write_file_piece takes as its content_file: how a file on this computer reaches Files.
            let is_call = input.as_object().is_some_and(|fields| fields.contains_key("call") && fields.keys().all(|k| k == "call" || k == "upload"));
            let upload = input["upload"].as_str().filter(|_| is_call).map(String::from);
            let asked = if is_call { json!({ "tool": name, "call": input["call"] }) } else { json!({ "tool": name, "input": input }) };
            // The computer the call is met at first: $WF_PIN, this Mac's id by default (unpinned calls go to the always-on
            // computer since about 8:37 PM CST Nov 19, which does not hold this Mac's keys). A stopgap until that routing is fixed.
            let pin = std::env::var("WF_PIN").unwrap_or_else(|_| "f596fa0076f6c620".into());
            // Pinned, and only pinned: a step that sends must never quietly run on another computer (the coordinator,
            // Nov 20 2026 10:3x AM CST), and wf cannot tell a send from a read, so when the pinned computer is not carried
            // the step waits and says so; the run is answered again once that computer is carried.
            let call = |pinned: bool| -> Result<std::process::Output, String> {
                let mut door = Command::new(setting("cli"));
                door.args(["op", "tools:run", &asked.to_string()]);
                if pinned { door.args(["--pin", &pin]); }
                if let Some(file) = &upload { door.args(["--upload", file]); }
                door.stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())
            };
            let out = call(true)?;
            if !out.status.success() && String::from_utf8_lossy(&out.stderr).contains("No computer you pinned is carried") {
                eprintln!("  {step}: the computer {pin} is not carried by the door now; this step waits for it (wf show RUN once it is)");
            }
            let reply: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
            // A tool that ran and failed fails its step in its own words (the engine then takes the step's on_failure edge,
            // else the run fails), as tool:run-a-workflow does: a non-zero exit_code, or a call answered isError. Only no
            // answer at all leaves the step waiting.
            let exit_code = reply["exit_code"].as_i64().unwrap_or(0);
            let refused_call = is_call && reply["result"]["isError"] == true;
            if out.status.success() && (exit_code != 0 || refused_call || reply["error"].is_object()) {
                let words = [&reply["result"]["structuredContent"], &reply["result"]["content"], &reply["result"], &reply["error"], &reply["stderr"]]
                    .into_iter().find(|v| !v.is_null()).map(|v| v.to_string()).unwrap_or_default();
                let said = format!("{name} failed (exit_code {exit_code}): {}", words.chars().take(600).collect::<String>());
                eprintln!("  {step}: {said}");
                return Err(said);
            }
            let answered = if is_call { reply["result"].is_object() } else { !reply["result"].is_null() };
            if out.status.success() && answered {
                eprintln!("  {step}: answered by the account's {name}");
                // The same answer the engine keeps for each form (trillion-rust src/wake/tool_runner.rs run): a plain tool
                // run answers its own result (the door's reply.result), but a call answers the door's whole reply, so a call
                // step's bindings read output.result.structuredContent (src/tool_runs/tools/input_files.rs reads answer["result"]).
                // A program run in a container answers {tool, exit_code, result, ...}; the engine's step output is that answer's
                // result alone (trillion-rust src/wake/tool_runner.rs run: Ok(ran.result); container.rs builds the answer), so
                // wf keeps the same. Nov 21 2026: send-the-link bound output.result.data under wf and read nothing when woken.
                let kept = if is_call { reply.clone() }
                    else if reply["result"].get("exit_code").is_some() && reply["result"].get("result").is_some() { reply["result"]["result"].clone() }
                    else { reply["result"].clone() };
                self.keep(&step, &kept)?;
                return Ok(serde_json::to_vec(&kept).unwrap());
            }
            // A tool whose row runs on the person's own computer answers the door with how to run it ({how: {run_template}}),
            // not a result. wf is on that computer, so it runs the template itself, from the Workshop tree this computer's
            // engine has installed for the person (the one its own tool runs use; never a second export), with the step's
            // input written to a request file in the run folder.
            // The program's own answer is kept, never typed; {"result": X} alone is kept as X, as the door's reply is.
            // Nov 21 2026: the quote-deck run waited at its check and draw steps, both such tools, with no way on.
            if out.status.success() && !is_call {
                if let Some(template) = reply["how"]["run_template"].as_str() {
                    let folder = std::path::Path::new(&self.file).parent().map(|p| p.to_path_buf()).unwrap_or_else(std::env::temp_dir);
                    let request = folder.join(format!("{step}.request.json"));
                    std::fs::write(&request, serde_json::to_vec(&input).unwrap()).map_err(|e| e.to_string())?;
                    let words: Vec<String> = template.split_whitespace().map(|w| w.replace("{request}", &request.to_string_lossy())).collect();
                    if words.is_empty() { return Err(format!("{name} has an empty run_template")); }
                    let started = std::time::Instant::now();
                    let tree = installed_tree()?;
                    let ran = Command::new(&words[0]).args(&words[1..]).current_dir(&tree)
                        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())?;
                    let text = String::from_utf8_lossy(&ran.stdout).to_string();
                    let parsed = serde_json::from_str::<Value>(text.trim()).ok().filter(|v| v.is_object())
                        .or_else(|| text.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok().filter(|v| v.is_object())));
                    let failed = !ran.status.success() || parsed.as_ref().map_or(true, |v| v.get("error").is_some());
                    if failed {
                        let both = format!("{}{}", text, String::from_utf8_lossy(&ran.stderr));
                        let said = format!("{name} on this computer exited {:?}: {}", ran.status.code(), both.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>());
                        eprintln!("  {step}: {said}");
                        return Err(said);
                    }
                    let parsed = parsed.unwrap();
                    let kept = match parsed.as_object() { Some(o) if o.len() == 1 && o.contains_key("result") => parsed["result"].clone(), _ => parsed };
                    eprintln!("  {step}: answered by {name}, run on this computer from the installed Workshop {} in {:.1} s", tree.rsplit('/').next().unwrap_or("").chars().take(12).collect::<String>(), started.elapsed().as_secs_f32());
                    self.keep(&step, &kept)?;
                    return Ok(serde_json::to_vec(&kept).unwrap());
                }
            }
            // Say what the door said, so a refusal is never mistaken for silence.
            let said = String::from_utf8_lossy(&out.stderr).trim().chars().take(600).collect::<String>();
            eprintln!("  {step}: the account's {name} did not answer (exit {:?}){}; it waits", out.status.code(), if said.is_empty() { String::new() } else { format!(": {said}") });
        }
        // A step named for one of the door's own operations (`secrets:put` and the like: resource:verb, not a tool, a
        // workflow or a person) is asked of the door as that operation, as the engine's host does. The door refuses a name it
        // does not hold, and then the step waits. Nov 21 2026: a pursuit's reader run waited at keep-the-reader-login
        // (secrets:put with make, so the vault makes the login and only its name comes back) with no way on.
        let door_op = name.split_once(':').is_some_and(|(resource, verb)| !["tool", "workflow", "person", "record"].contains(&resource)
            && !resource.is_empty() && !verb.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c == ':' || c == '-' || c == '_'));
        if door_op {
            // The input goes on stdin, never argv: a secrets:put may carry a value. It is met at the same computer as every
            // tool step ($WF_PIN, this Mac by default): each computer has its own vault, so a run whose secrets:names and
            // secrets:put went unpinned (to the always-on) and whose tool steps went pinned (to this Mac) kept a login in one
            // vault and read it from the other. Nov 22 2026 1:07 AM CST: keep-the-reader-login kept
            // <person>_for_who_runs_it-reader-connection on <the computer>, and make-the-reader, pinned here,
            // was refused "credential not held"; the Nov 21 make-a-database stalls were the same split.
            let pin = std::env::var("WF_PIN").unwrap_or_else(|_| "f596fa0076f6c620".into());
            let mut child = Command::new(setting("cli")).args(["op", name, "-", "--pin", &pin]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
            child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            let reply: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
            if out.status.success() && reply.is_object() && reply.get("error").is_none() {
                eprintln!("  {step}: answered by the door's {name}");
                self.keep(&step, &reply)?;
                return Ok(serde_json::to_vec(&reply).unwrap());
            }
            let said = String::from_utf8_lossy(&out.stderr).trim().chars().take(600).collect::<String>();
            eprintln!("  {step}: the door's {name} did not answer (exit {:?}){}", out.status.code(), if said.is_empty() { String::new() } else { format!(": {said}") });
        }
        // An ask his approval_setting already answers never reaches him: the most specific row for the ask's scope (its
        // input's "scope", else "*") decides, and "auto" refuses the ask, so the workflow acts on his standing answer
        // (his "Yes, everything" master switch, 12:04 PM CST Nov 20 2026). Only a scope whose row says "ask" (a device in
        // his hand, a payment, a choice between his own rules) is put to him.
        if let Some(person) = name.strip_prefix("person:") {
            let scope = input["scope"].as_str().unwrap_or("*").to_string();
            let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || ":_-.*/".contains(c));
            if plain(person) && plain(&scope) {
                if let Ok(rows) = sql_read(&setting("runs_database"), "select scope, mode, set_by from approval_setting where person = $1 and scope in ($2, '*') order by (scope = $2) desc, set_at desc limit 1", json!([person, scope])) {
                    if let Some(row) = rows.first() {
                        if row["mode"] == "auto" {
                            let said = format!("{step} asks {name}, but his approval_setting ({person}, {}, auto) already answers it ({}); act on it, and put to him only what a scope whose row says ask covers",
                                row["scope"].as_str().unwrap_or(""), row["set_by"].as_str().unwrap_or("").chars().take(160).collect::<String>());
                            eprintln!("  {said}");
                            return Err(said);
                        }
                    }
                }
            }
        }
        if name.starts_with("person:") {
            let folder = std::path::Path::new(&self.file).parent().map(|d| d.display().to_string()).unwrap_or_default();
            let kept = self.answers.lock().unwrap().clone();
            let asked = input.to_string();
            if made_pieces(&kept).iter().any(|(_, piece)| piece["file_identity"].as_str().is_some_and(|id| asked.contains(id))) {
                if let Err(misses) = piece_gate(&folder) {
                    let said = format!("{step} would show {name} a piece that has not passed review: {}", misses.join("; "));
                    eprintln!("  {said}");
                    return Err(said);
                }
            }
        }
        eprintln!("  {step}: waits for {name}");
        // An ask's words often name its inputs as {key} (Nov 21: copy-a-held-value showed "{name}" and "{hosts}" unfilled);
        // the engine fills no such text, so the asker's words are filled here from the step's own input, then the run's.
        // A {key} neither holds stays, and is listed as unfilled so whoever answers sees what the ask is missing.
        let run_input = std::path::Path::new(&self.file).parent().map(|d| read(&format!("{}/input.json", d.display()))).unwrap_or(Value::Null);
        let (input, unfilled) = fill_ask_words(&input, &run_input);
        if !unfilled.is_empty() { eprintln!("  {step}: its words name {} but nothing holds them", unfilled.join(", ")); }
        self.waiting.lock().unwrap().push(json!({ "step": step, "for": name, "asks": input, "unfilled": unfilled }));
        Ok(serde_json::to_vec(&json!({ "$kind": workflow_core::executor::context::NOT_ANSWERED_YET, "step_id": step, "asked": name })).unwrap())
    }
    async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
}
impl OneRule {
    fn keep(&self, step: &str, answer: &Value) -> Result<(), String> {
        let mut answers = self.answers.lock().unwrap();
        answers.insert(step.to_string(), answer.clone());
        std::fs::write(&self.file, serde_json::to_vec_pretty(&*answers).unwrap()).map_err(|e| e.to_string())
    }
}

// The path a run's work took, read from the harness's own stream: the chat transcripts (Claude Code's projects/**.jsonl,
// a lane's subagents/*.jsonl, Codex's sessions/**.jsonl) that name this run's folder, from the run's start on. Each tool
// call becomes a step {trigger_seen, did, where_each_fact_lives, check, by}, so a job done by hand is the first draft of
// its workflow (11:30 AM CST Nov 20 2026). Nothing depends on an AI remembering to write a note. Values are cut
// out: SQL literals, e-mail addresses, long numbers and connection strings never reach the row.
fn record(run: &str) -> Result<Value, String> {
    let name = run.rsplit('/').next().unwrap_or(run).to_string();
    // A chat may name the run by its leading number alone (run_of takes it), so that is what is looked for.
    let short = name.split('-').next().unwrap_or(&name).to_string();
    let started = read(&format!("{run}/started_at.json")).as_str().unwrap_or_default().to_string();
    // Transcripts written since the run started: minutes since then, read from the start's own UTC time.
    let started_secs: u64 = Command::new("date").args(["-j", "-u", "-f", "%Y-%m-%dT%H:%M:%SZ", &started, "+%s"]).output()
        .ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0);
    let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let minutes = if started_secs == 0 { String::new() } else { format!("-{}", now_secs.saturating_sub(started_secs) / 60 + 2) };
    let roots = [claude_projects(), format!("{}/.codex/sessions", home())];
    let mut files: Vec<String> = vec![];
    for root in &roots {
        let mut find = Command::new("find");
        find.args([root.as_str(), "-name", "*.jsonl"]);
        if !minutes.is_empty() { find.args(["-mmin", &minutes]); }
        let listed = find.stdout(Stdio::piped()).stderr(Stdio::null()).output().map_err(|e| e.to_string())?;
        let paths: Vec<String> = String::from_utf8_lossy(&listed.stdout).lines().map(String::from).collect();
        for chunk in paths.chunks(200) {
            let hit = Command::new("grep").arg("-l").arg("-F").arg(&short).args(chunk).stdout(Stdio::piped()).stderr(Stdio::null()).output().map_err(|e| e.to_string())?;
            files.extend(String::from_utf8_lossy(&hit.stdout).lines().map(String::from));
        }
    }
    if files.is_empty() { return Err(format!("no chat transcript names {name}")); }
    let cut = |text: &str| -> String {
        let mut t = text.to_string();
        for (pattern, with) in [
            (r"postgres(ql)?://\S+", "<connection>"),
            (r"(?i)(password|secret|token|api[_-]?key)\s*[=:]\s*\S+", "$1=<cut>"),
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "<email>"),
            (r"'(?:[^']|'')*'", "'…'"),
            (r"\b\d{7,}\b", "<number>"),
        ] { t = re(pattern).replace_all(&t, with).to_string(); }
        t.chars().take(400).collect()
    };
    let places = |text: &str| -> Vec<String> {
        let mut found: BTreeSet<String> = BTreeSet::new();
        for (pattern, kind) in [
            (r"\b([a-z0-9_]+_for_who_(?:runs|uses)_it|[a-z0-9_]+_sign_ins)\b", "database"),
            (r"\b(?i:from|into|update|join|table)\s+([a-z_][a-z0-9_.]*[a-z0-9])\b", "table"),
            (r"\b(tool:[a-z0-9-]+)", "tool"),
            (r"\b(workflow:[a-z0-9-]+)", "workflow"),
            (r"(https?://[^\s'\x22)<>]+)", "site"),
            (r"(/Users/[^\s'\x22:;,)<>|]+)", "file"),
        ] {
            for c in re(pattern).captures_iter(text) {
                let place = c[1].trim_end_matches(['.', ',']).to_string();
                // A table is named only in SQL: the text holds a statement, and the name is written as SQL writes one.
                if kind == "table" && !is_like(r"(?i)\b(select|insert into|update \S+ set|delete from|create table|alter table)\b", text) { continue; }
                found.insert(format!("{kind} {}", cut(&place)));
            }
        }
        found.into_iter().collect()
    };
    let mut steps: Vec<Value> = vec![];
    let mut worked: Vec<String> = vec![];
    for file in &files {
        // A call is kept until its result arrives, then made a step.
        let mut open: BTreeMap<String, (String, Value, String, String)> = BTreeMap::new();
        let mut said = String::new();
        let mut by = String::new();
        // The step the run waited on when this chat last heard from wf, the trigger when the chat said nothing first.
        let mut waits_on = String::new();
        let mut file_steps: Vec<Value> = vec![];
        // Only a chat that worked this run (a wf start, answer or show naming it) counts, and only up to its last such call:
        // a chat that merely read the run's folder name did not work it.
        let mut worked_until: Option<String> = None;
        let content = std::fs::read_to_string(file).unwrap_or_default();
        for line in content.lines() {
            let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
            let at = o["timestamp"].as_str().unwrap_or_default().to_string();
            // The job starts with the last ask that reached this chat before the run did (the person's words, a peer's
            // message or a lane's brief): work before that ask was another job's, and the ask is what the chat first saw.
            let asked_text = if o["type"] == "user" { match &o["message"]["content"] { Value::String(s) => s.clone(),
                    Value::Array(a) => a.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "), _ => String::new() } }
                else if o["type"] == "response_item" && o["payload"]["type"] == "message" && o["payload"]["role"] == "user" {
                    o["payload"]["content"].as_array().into_iter().flatten().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" ") }
                else { String::new() };
            let asked_text = asked_text.trim();
            if !asked_text.is_empty() && !asked_text.starts_with("<system-reminder>") && !asked_text.starts_with("<task-notification") && at.as_str() <= started.as_str() {
                file_steps.clear();
                open.clear();
                said = format!("asked: {}", asked_text.chars().take(300).collect::<String>());
            }
            // Claude Code: assistant tool_use, then a user tool_result. Codex: response_item function_call, then function_call_output.
            let mut calls: Vec<(String, String, Value)> = vec![];
            let mut results: Vec<(String, String, bool)> = vec![];
            if o["type"] == "assistant" {
                if let Some(model) = o["message"]["model"].as_str() { by = format!("{} {}", model, o["agentId"].as_str().or(o["sessionId"].as_str()).unwrap_or("")); }
                for part in o["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "text" { said = part["text"].as_str().unwrap_or_default().to_string(); }
                    if part["type"] == "tool_use" { calls.push((part["id"].as_str().unwrap_or_default().into(), part["name"].as_str().unwrap_or_default().into(), part["input"].clone())); }
                }
            } else if o["type"] == "user" {
                for part in o["message"]["content"].as_array().into_iter().flatten().filter(|p| p["type"] == "tool_result") {
                    let text = match &part["content"] { Value::String(s) => s.clone(), Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "), _ => String::new() };
                    results.push((part["tool_use_id"].as_str().unwrap_or_default().into(), text, part["is_error"] == true));
                }
            } else if o["type"] == "response_item" {
                let p = &o["payload"];
                if p["type"] == "message" && p["role"] == "assistant" { said = p["content"].as_array().into_iter().flatten().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "); }
                if p["type"] == "function_call" {
                    let args = p["arguments"].as_str().and_then(|a| serde_json::from_str::<Value>(a).ok()).unwrap_or(p["arguments"].clone());
                    calls.push((p["call_id"].as_str().unwrap_or_default().into(), p["name"].as_str().unwrap_or_default().into(), args));
                }
                if p["type"] == "function_call_output" {
                    let text = p["output"].as_str().map(String::from).unwrap_or_else(|| p["output"].to_string());
                    results.push((p["call_id"].as_str().unwrap_or_default().into(), text.clone(), text.contains("Process exited with code") && !text.contains("code 0")));
                }
            } else if o["type"] == "turn_context" { by = format!("{} codex", o["payload"]["model"].as_str().unwrap_or("")); }
            for (id, tool, input) in calls { open.insert(id, (tool, input, said.clone(), at.clone())); }
            for (id, text, failed) in results {
                let Some((tool, input, why, at)) = open.remove(&id) else { continue };
                let input_text = input.to_string();
                let is_wf = is_like(r"\bwf (start|answer|show|cancel)\b", &input_text);
                if is_wf && (input_text.contains(&short) || (input_text.contains("wf start") && text.contains(&short))) { worked_until = Some(at.clone()); }
                if is_wf {
                    if let Some(c) = re(r#""step":\s*"([^"]+)""#).captures_iter(&text).last() { waits_on = c[1].to_string(); }
                }
                let asked = [&input["command"], &input["cmd"], &input["file_path"], &input["url"], &input["query"], &input["prompt"], &input["pattern"]].into_iter()
                    .find_map(|v| match v { Value::String(s) => Some(s.clone()), Value::Array(a) => Some(a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")), _ => None })
                    .unwrap_or_else(|| input.to_string());
                let verb = match tool.as_str() {
                    "Read" | "Grep" | "Glob" | "WebFetch" | "WebSearch" => "read",
                    "Edit" | "Write" | "NotebookEdit" | "apply_patch" => "wrote",
                    "Agent" | "SendMessage" => "asked",
                    _ if tool.starts_with("mcp__") => "called",
                    _ => {
                        let low = asked.to_lowercase();
                        if is_like(r"\b(insert|update|delete|create|alter)\b|>\s*/|\bwf answer\b|\bgit (push|commit)\b|--upload|\bcp\b|\bmv\b", &low) { "wrote" }
                        else if is_like(r"\b(select|cat|sed -n|grep|ls|head|tail|wf (show|find|kinds)|git (show|log|diff|status))\b", &low) { "read" } else { "ran" }
                    }
                };
                let low = asked.to_lowercase();
                let check = if failed { Value::String(format!("failed: {}", cut(&text.chars().take(200).collect::<String>()))) }
                    else if is_like(r"\b(test|pytest|cargo test|is-ancestor|readback|read back|--check|verify|curl -s?i?)\b", &low) { Value::String(format!("checked: {}", cut(&text.chars().rev().take(160).collect::<String>().chars().rev().collect::<String>()))) }
                    else { Value::Null };
                let seen = why.lines().rev().find(|l| !l.trim().is_empty()).map(String::from)
                    .unwrap_or_else(|| if waits_on.is_empty() { String::new() } else { format!("the run waits on {waits_on}") });
                file_steps.push(json!({
                    "at": at,
                    "trigger_seen": cut(&seen),
                    "did": format!("{verb} with {tool}: {}", cut(&asked)),
                    "where_each_fact_lives": places(&format!("{asked}\n{}", text.chars().take(2000).collect::<String>())),
                    "check": check,
                    "by": by,
                }));
            }
        }
        if let Some(until) = worked_until { worked.push(file.clone()); steps.extend(file_steps.into_iter().filter(|st| st["at"].as_str().unwrap_or("") <= until.as_str())); }
    }
    if worked.is_empty() { return Err(format!("no chat transcript worked {name} (a wf start, answer or show naming it)")); }
    steps.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    // No person's name reaches the row: the names held in every people-shaped table (one with an email column) of each
    // pursuit the path touched are cut out, whole words, with and without their accents.
    let databases: BTreeSet<String> = steps.iter().flat_map(|st| st["where_each_fact_lives"].as_array().cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().and_then(|p| p.strip_prefix("database ")).map(String::from))
        .filter_map(|d| d.split("_for_who_").next().filter(|_| d.contains("_for_who_")).or_else(|| d.strip_suffix("_sign_ins")).map(String::from))
        // Each pursuit keeps its people in three stores: who runs it, who uses it, and its own sign-ins.
        .flat_map(|pursuit| ["_for_who_runs_it", "_for_who_uses_it", "_sign_ins"].map(|end| format!("{pursuit}{end}"))).collect();
    let mut names: BTreeSet<String> = BTreeSet::new();
    // The tables those stores really hold, so a word after "from" in prose is not taken for one.
    let mut real_tables: BTreeSet<String> = ["information_schema.tables", "information_schema.columns"].map(String::from).into_iter().collect();
    for database in &databases {
        if let Ok(rows) = sql_read(database, "select table_schema as s, table_name as t from information_schema.tables where table_schema not in ('pg_catalog','information_schema')", json!([])) {
            for v in rows.iter() {
                let (schema, table) = (v["s"].as_str().unwrap_or_default(), v["t"].as_str().unwrap_or_default());
                real_tables.insert(table.to_string());
                real_tables.insert(format!("{schema}.{table}"));
            }
        }
        let sql = "select query_to_xml(format('select distinct %I::text as n from %I.%I where %I is not null', c.column_name, c.table_schema, c.table_name, c.column_name), false, true, '')::text as x \
                   from information_schema.columns c where c.column_name in ('name','full_name','first_name','last_name','display_name','given_name','family_name') \
                   and c.table_schema not in ('pg_catalog','information_schema') \
                   and exists (select 1 from information_schema.columns e where e.table_schema = c.table_schema and e.table_name = c.table_name and e.column_name like '%email%')";
        if let Ok(rows) = sql_read(database, sql, json!([])) {
            for row in rows.iter() {
                let x = row["x"].as_str().unwrap_or_default().to_string();
                for c in regex::Regex::new(r"<n>([^<]*)</n>").unwrap().captures_iter(&x) {
                    let full = c[1].trim().to_string();
                    for part in std::iter::once(full.clone()).chain(full.split_whitespace().map(String::from)) {
                        // A name is written with a capital, so a lowercase word in a name field ("the") is not taken.
                        if part.chars().count() >= 3 && part.chars().next().is_some_and(char::is_uppercase) { names.insert(part.clone()); names.insert(plain_letters(&part)); }
                    }
                }
            }
        }
    }
    // A word the shared workflows already use ("Only", "Tennis") or a pursuit's own name is not a person's: test and
    // business accounts sit in the same tables.
    let shared: BTreeSet<String> = own_index().iter().map(Value::to_string).collect::<Vec<_>>().join(" ")
        .split(|c: char| !c.is_ascii_alphabetic()).map(str::to_lowercase).chain(databases.iter().flat_map(|d| d.split('_').map(String::from).collect::<Vec<_>>())).collect();
    for st in steps.iter_mut() {
        if let Some(places) = st["where_each_fact_lives"].as_array_mut() {
            places.retain(|p| p.as_str().and_then(|p| p.strip_prefix("table ")).map_or(true, |t| real_tables.contains(t)));
        }
    }
    let mut names: Vec<String> = names.into_iter().filter(|n| !n.split_whitespace().all(|w| shared.contains(&plain_letters(w).to_lowercase()))).collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
    let input = read(&format!("{run}/input.json"));
    let def = read(&format!("{run}/definition.json"));
    let workflow = def["id"].as_str().unwrap_or_default().to_string();
    // The pursuit: the run's own input names it, else the one whose stores the work touched most.
    let mut touched: BTreeMap<String, usize> = BTreeMap::new();
    for st in &steps { for p in st["where_each_fact_lives"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if let Some(d) = p.strip_prefix("database ") { *touched.entry(d.split("_for_who_").next().unwrap_or(d).trim_end_matches("_sign_ins").to_string()).or_default() += 1; }
    } }
    let pursuit = ["pursuit", "store", "posts_store", "database"].iter().find_map(|k| input[*k].as_str())
        .map(|s| s.split("_for_who").next().unwrap_or(s).to_string())
        .or_else(|| touched.iter().max_by_key(|(_, n)| **n).map(|(p, _)| p.clone())).unwrap_or_else(|| setting("host"));
    // What reaches a person outside: the sending tools the person's store lists (words_go_out_tools), matched by name and
    // first word as the store's own words_go_out check matches them.
    let senders: Vec<Vec<String>> = sql_read(&setting("runs_database"), "select tool from words_go_out_tools where voice_exempt_because is null", json!([])).unwrap_or_default()
        .iter().filter_map(|v| v["tool"].as_str().map(|t| t.split_whitespace().map(String::from).collect())).collect();
    let sends = |text: &str| senders.iter().any(|words| words.iter().all(|w| text.contains(w.trim_start_matches("tool:"))));
    // The calls made into steps of an SOP: a step ends where the chat says what it will do next, where it answers a step
    // of the run, or where the work moves to another place. The first step's trigger is what the run's workflow fires on.
    let kinds: Vec<Value> = own_index().into_iter().find(|w| w["id"] == workflow.as_str()).map(|w| w["kinds"].as_array().cloned().unwrap_or_default()).unwrap_or_default();
    let primary = |call: &Value| -> String {
        let places: Vec<&str> = call["where_each_fact_lives"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        places.iter().find(|p| !p.starts_with("file ") && !p.starts_with("table ")).map(|p| p.to_string())
            .or_else(|| places.iter().find(|p| p.starts_with("file ")).map(|p| p.split('/').take(5).collect::<Vec<_>>().join("/")))
            .unwrap_or_default()
    };
    let mut segments: Vec<Vec<Value>> = vec![];
    let (mut last_seen, mut last_place, mut closed) = (String::new(), String::new(), true);
    for call in &steps {
        let seen = call["trigger_seen"].as_str().unwrap_or_default().to_string();
        let place = primary(call);
        if closed || seen != last_seen || (!place.is_empty() && !last_place.is_empty() && place != last_place) { segments.push(vec![]); }
        segments.last_mut().unwrap().push(call.clone());
        closed = is_like(r"\bwf answer\b", call["did"].as_str().unwrap_or_default());
        last_seen = seen;
        if !place.is_empty() { last_place = place; }
    }
    let answered = regex::Regex::new(r"wf answer\s+\S+\s+([A-Za-z0-9_#/.-]+)").unwrap();
    let path_steps: Vec<Value> = segments.iter().enumerate().map(|(i, calls)| {
        let places: BTreeSet<String> = calls.iter().flat_map(|c| c["where_each_fact_lives"].as_array().cloned().unwrap_or_default()).filter_map(|p| p.as_str().map(String::from)).collect();
        let checks: Vec<String> = calls.iter().filter_map(|c| c["check"].as_str().map(String::from)).collect();
        let dids: Vec<&str> = calls.iter().filter_map(|c| c["did"].as_str()).collect();
        let count = |verb: &str| dids.iter().filter(|d| d.starts_with(verb)).count();
        let step_answered = dids.iter().find_map(|d| answered.captures(d).map(|c| c[1].to_string()));
        let tools: BTreeSet<String> = places.iter().filter_map(|p| p.strip_prefix("tool ").map(String::from)).collect();
        let by = match (&step_answered, tools.len()) {
            (Some(step), _) => format!("{workflow}#{step}"),
            (None, 1) if dids.iter().all(|d| d.contains(tools.iter().next().unwrap().as_str())) => tools.iter().next().unwrap().clone(),
            _ => "judgment".into(),
        };
        let first_change = dids.iter().find(|d| d.starts_with("wrote") || d.starts_with("ran") || d.starts_with("called") || d.starts_with("asked")).or(dids.first()).copied().unwrap_or_default();
        json!({
            // A judgment step carries what the chat saw before it chose (the recorded-path guard refuses one without it).
            "trigger_seen": if i == 0 && !kinds.is_empty() { json!([{ "field": "kinds", "values": kinds }]) }
                else if by == "judgment" && calls[0]["trigger_seen"].as_str().is_some_and(|t| !t.is_empty()) { json!([{ "field": "seen", "values": [calls[0]["trigger_seen"]] }]) }
                else { json!([]) },
            "seen": calls[0]["trigger_seen"],
            "did": format!("{} ({} calls: read {}, wrote {}, ran {}, called {}, asked {})", first_change.chars().take(240).collect::<String>(), calls.len(),
                count("read"), count("wrote"), count("ran"), count("called"), count("asked")),
            "where_each_fact_lives": { "where": places.iter().cloned().collect::<Vec<_>>().join("; ").chars().take(600).collect::<String>(), "places": places },
            "check": if checks.is_empty() { Value::String("no check seen in this step".into()) } else { Value::String(checks.join(" | ").chars().take(600).collect()) },
            "by": by,
            "sends_to_customer": calls.iter().any(|c| sends(c["did"].as_str().unwrap_or_default())),
            "at": calls[0]["at"], "until": calls[calls.len() - 1]["at"],
            "calls": calls,
        })
    }).collect();
    let request = cut(input["request"].as_str().unwrap_or_default());
    let title = if request.is_empty() { format!("{} done by hand", def["name"].as_str().unwrap_or(&workflow)) } else { format!("{} done by hand: {request}", def["name"].as_str().unwrap_or(&workflow)) };
    // The job in its own words is the run's request, given at wf start; the chat's line before the first call is often a
    // progress line ("I'll start with..."), which the recorded-path guard refuses (know-a-person, Nov 21 4:0x AM CST).
    let problem = Some(request.clone()).filter(|r| r.chars().count() >= 20)
        .or_else(|| path_steps.first().and_then(|st| st["seen"].as_str()).filter(|s| !s.is_empty()).map(String::from))
        .unwrap_or_default();
    let path = json!({
        "path_id": format!("path:{name}"),
        "pursuit": pursuit,
        "title": title.chars().take(200).collect::<String>(),
        "problem": problem.chars().take(400).collect::<String>(),
        "who": format!("Whoever does this job for the {pursuit} pursuit by hand today"),
        "steps": path_steps,
        "came_from": json!({ "run": run, "workflow": workflow, "started_at": started, "recorded_at": now_utc(), "transcripts": worked,
                             "by": read(&format!("{run}/started_by.json")), "calls": steps.len() }).to_string(),
    });
    if names.is_empty() { return Ok(path); }
    // As written with its capital in words ("Ana"), and in any case inside an id or a path ("lesson-ana", "ana-plan"),
    // so a name that is also a word ("Will") still leaves the word "will" alone.
    let any = names.iter().map(|n| regex::escape(n)).collect::<Vec<_>>().join("|");
    let person = regex::Regex::new(&format!(r"\b(?:{any})\b|(?i:[-_:/.](?:{any})\b)|(?i:\b(?:{any})[-_:/.])")).map_err(|e| e.to_string())?;
    // Only values are cut, never a field's name.
    fn cut_names(value: &Value, person: &regex::Regex) -> Value {
        match value {
            Value::String(text) => Value::String(person.replace_all(text, |c: &regex::Captures| {
                let found = &c[0];
                let marks = "-_:/.";
                match (found.chars().next(), found.chars().last()) {
                    (Some(mark), _) if marks.contains(mark) => format!("{mark}<person>"),
                    (_, Some(mark)) if marks.contains(mark) => format!("<person>{mark}"),
                    _ => "<person>".into(),
                }
            }).to_string()),
            Value::Array(items) => Value::Array(items.iter().map(|v| cut_names(v, person)).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), cut_names(v, person))).collect()),
            other => other.clone(),
        }
    }
    Ok(cut_names(&path, &person))
}
fn is_like(pattern: &str, text: &str) -> bool { re(pattern).is_match(text) }
// A pattern is compiled once per process: record walks every call of every chat that names the run, and compiling its
// patterns per call made a long chat take minutes (a 187 MB transcript held wf record past 60 s, Nov 21 4:3x AM CST).
fn re(pattern: &str) -> regex::Regex {
    thread_local! { static COMPILED: std::cell::RefCell<std::collections::HashMap<String, regex::Regex>> = Default::default(); }
    COMPILED.with(|c| c.borrow_mut().entry(pattern.to_string()).or_insert_with(|| regex::Regex::new(pattern).unwrap()).clone())
}
// The Workshop tree this computer's engine installed for the person: its keeper's state (persons/<person>/workshop-installs/
// state.json, `current`) names a folder under tool-installs/workshop-trees. The same files the engine's own tool runs use.
fn installed_tree() -> Result<String, String> {
    let root = setting("computer_root");
    let people: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{root}/persons")).map_err(|e| format!("no installed Workshop: {e}"))?
        .filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.join("workshop-installs/state.json").exists()).collect();
    let state = match people.as_slice() {
        [one] => read(&one.join("workshop-installs/state.json").to_string_lossy()),
        [] => return Err("this computer's engine has installed no Workshop for anyone".into()),
        _ => return Err("this computer's engine holds Workshop installs for more than one person; wf cannot tell whose".into()),
    };
    let current = state["current"].as_str().filter(|c| c.len() == 64 && c.chars().all(|ch| ch.is_ascii_hexdigit())).ok_or("the Workshop install state names no current tree")?;
    let tree = format!("{root}/tool-installs/workshop-trees/{current}");
    if !std::path::Path::new(&tree).is_dir() { return Err(format!("the installed Workshop tree {current} is missing")); }
    Ok(tree)
}
fn plain_letters(word: &str) -> String {
    word.chars().map(|c| match c { 'á'|'à'|'â'|'ä'|'ã'|'å' => 'a', 'Á'|'À'|'Â'|'Ä'|'Ã'|'Å' => 'A', 'é'|'è'|'ê'|'ë' => 'e', 'É'|'È'|'Ê'|'Ë' => 'E',
        'í'|'ì'|'î'|'ï' => 'i', 'Í'|'Ì'|'Î'|'Ï' => 'I', 'ó'|'ò'|'ô'|'ö'|'õ'|'ø' => 'o', 'Ó'|'Ò'|'Ô'|'Ö'|'Õ'|'Ø' => 'O', 'ú'|'ù'|'û'|'ü' => 'u',
        'Ú'|'Ù'|'Û'|'Ü' => 'U', 'ç' => 'c', 'Ç' => 'C', 'ñ' => 'n', 'Ñ' => 'N', other => other }).collect()
}
// One query through the one held-database opener (rows as JSON lines), so no connection string is ever seen.
// Each run is also a row any computer can read (wf_runs in the runs-it store), so a lane on another computer, or the
// landing check, finds a run by its lane without this Mac's folder. Only the shape is kept: ids, lane, the request's
// first words, status and step names; answers stay in the run's folder. A row that cannot be written never stops the run.
fn fill_ask_words(asks: &Value, run_input: &Value) -> (Value, Vec<String>) {
    let mut unfilled: BTreeSet<String> = BTreeSet::new();
    let value_of = |key: &str| -> Option<String> {
        [&asks[key], &run_input[key]].into_iter().find(|v| !v.is_null()).map(|v| match v { Value::String(t) => t.clone(), other => other.to_string() })
    };
    fn walk(v: &Value, value_of: &dyn Fn(&str) -> Option<String>, unfilled: &mut BTreeSet<String>, words_key: bool) -> Value {
        match v {
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), walk(x, value_of, unfilled, ["do", "words", "ask", "question", "prompt"].contains(&k.as_str())))).collect()),
            Value::Array(a) => Value::Array(a.iter().map(|x| walk(x, value_of, unfilled, false)).collect()),
            Value::String(t) if words_key => Value::String(re(r"\{([a-z_][a-z_0-9]*)\}").replace_all(t, |c: &regex::Captures| match value_of(&c[1]) {
                Some(found) => found, None => { unfilled.insert(c[1].to_string()); c[0].to_string() } }).to_string()),
            other => other.clone(),
        }
    }
    let filled = walk(asks, &value_of, &mut unfilled, false);
    (filled, unfilled.into_iter().collect())
}
fn keep_run_row(run: &str, workflow: &str, started: &str, shown: &Value) {
    let input = read(&format!("{run}/input.json"));
    let name = run.rsplit('/').next().unwrap_or(run);
    let names = |v: &Value| -> Value { Value::Array(v.as_array().into_iter().flatten().filter_map(|x| x["step"].as_str().or(x.as_str()).map(|s| Value::String(s.to_string()))).collect()) };
    let row = json!({
        "run_id": name, "workflow": workflow, "lane": input["lane"].as_str().unwrap_or(""),
        "request": input["request"].as_str().unwrap_or("").chars().take(300).collect::<String>(),
        // The seed whole, never cut, so "who already owns this seed" matches a run exactly (Nov 21 2026).
        "seed": input["seed"].as_str().map(str::to_string).or_else(|| input["seed"]["id"].as_str().map(str::to_string)).unwrap_or_default(),
        "started_by": read(&format!("{run}/started_by.json")).as_str().unwrap_or(""), "started_at": started,
        "computer": Command::new("hostname").arg("-s").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default(),
        "status": shown["status"].as_str().unwrap_or("unknown"), "waiting": names(&shown["waiting"]), "failed": names(&shown["failed"]),
    });
    // One statement, the upsert; the table is made only when it is missing (the tool runs one statement at a time).
    const UPSERT: &str = "insert into wf_runs (run_id, workflow, lane, request, seed, started_by, started_at, computer, status, waiting, failed) select r->>'run_id', r->>'workflow', r->>'lane', r->>'request', r->>'seed', r->>'started_by', nullif(r->>'started_at','')::timestamptz, r->>'computer', r->>'status', r->'waiting', r->'failed' from (select $1::jsonb as r) x on conflict (run_id) do update set status = excluded.status, waiting = excluded.waiting, failed = excluded.failed, lane = excluded.lane, seed = case when excluded.seed <> '' then excluded.seed else wf_runs.seed end, updated_at = now() returning run_id";
    const CREATE: &str = "create table if not exists wf_runs (run_id text primary key, workflow text not null, lane text not null default '', request text not null default '', seed text not null default '', started_by text not null default '', started_at timestamptz, computer text not null default '', status text not null, waiting jsonb not null default '[]', failed jsonb not null default '[]', updated_at timestamptz not null default now())";
    let database = setting("runs_database");
    let params = json!([row.to_string()]);
    let kept = match sql_rows(&database, UPSERT, params.clone()) {
        Err(e) if e.contains("wf_runs") && e.contains("does not exist") => sql_rows(&database, CREATE, json!([])).and_then(|_| sql_rows(&database, UPSERT, params)),
        other => other,
    };
    if let Err(e) = kept { eprintln!("the run's row is not kept ({e}); its folder still holds it"); }
}// One engine call through the door program (tools/use-your-tools-from-a-shell/do-work/door-op.mjs in the Workshop): one JSON
// A made piece reaches a person, or its run completes, only once a reviewer other than its makers passed that exact file
// (~10 PM CST Nov 21 2026, after a third rejected cut: "there is no reviewer … no proper evals"). A step answer
// marks what it made with "made": [{file_identity, kind}]; the answer to the step "review" is
// {passed, file_identity, reviewer, checks, misses} (one object, or one per piece). The checks each kind requires are rows
// (piece_required_checks in the run's own store), never a list here, read through the store's piece_gate_misses: each needs a passing latest row in
// piece_check_verdicts for that identity by someone who made none of it. A missing row, a kind with no rows, or a store
// wf cannot read is a refusal. Each decision is kept as a piece_gate_decisions row so pass rates per maker and kind count.
fn made_pieces(answers: &BTreeMap<String, Value>) -> Vec<(String, Value)> {
    answers.iter().flat_map(|(step, answer)| answer["made"].as_array().into_iter().flatten().map(move |piece| (step.clone(), piece.clone()))).collect()
}
fn piece_gate(run: &str) -> Result<(), Vec<String>> {
    let answers: BTreeMap<String, Value> = serde_json::from_value(read(&format!("{run}/answers.json"))).unwrap_or_default();
    let made = made_pieces(&answers);
    if made.is_empty() { return Ok(()); }
    let answered_by: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_by.json"))).unwrap_or_default();
    let starter = read(&format!("{run}/started_by.json")).as_str().unwrap_or_default().to_string();
    // Its makers: whoever started the run and whoever answered a step that made a piece.
    let mut makers: BTreeSet<String> = made.iter().filter_map(|(step, _)| answered_by.get(step).cloned()).collect();
    if !starter.is_empty() { makers.insert(starter); }
    let input = read(&format!("{run}/input.json"));
    let store = input["store"]["credential_name"].as_str().or(input["store"].as_str()).unwrap_or_default().to_string();
    let reviews: Vec<Value> = answers.iter().filter(|(step, _)| step.as_str() == "review" || [".review", "/review", ":review"].iter().any(|end| step.ends_with(end)))
        .flat_map(|(step, v)| { let one = |r: &Value| { let mut r = r.clone(); r["_step"] = json!(step); r };
            match v { Value::Array(all) => all.iter().map(one).collect::<Vec<_>>(), other => vec![one(other)] } }).collect();
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || ":_-./".contains(c));
    let identity_shape = re(r"^1f:[0-9a-f]{64}$");
    let mut misses: Vec<String> = vec![];
    let mut decisions: Vec<Value> = vec![];
    for (step, piece) in &made {
        let identity = piece["file_identity"].as_str().unwrap_or_default().to_string();
        let kind = piece["kind"].as_str().unwrap_or_default().to_string();
        let thing = piece["piece"].as_str().unwrap_or_default().to_string();
        let mut here: Vec<String> = vec![];
        let mut reviewer = String::new();
        if !identity_shape.is_match(&identity) { here.push(format!("{step} made a piece with no file identity 1f:<64 hex> ({identity:?})")); }
        if !plain(&kind) { here.push(format!("{step} made {identity} with no kind")); }
        if thing.is_empty() { here.push(format!("{step} made {identity} with no piece (the stable id of the thing across its versions)")); }
        match reviews.iter().find(|r| r["file_identity"] == identity.as_str()) {
            None => here.push(format!("no review of {identity}: a reviewer step answering for that exact file is required")),
            Some(review) => {
                reviewer = review["reviewer"].as_str().unwrap_or_default().to_string();
                let by = answered_by.get(review["_step"].as_str().unwrap_or_default());
                if review["passed"] != true { here.push(format!("the review of {identity} did not pass")); }
                if review["misses"].as_array().map_or(true, |m| !m.is_empty()) {
                    here.push(format!("the review of {identity} lists misses: {}", review["misses"].to_string().chars().take(400).collect::<String>()));
                }
                if reviewer.is_empty() { here.push(format!("the review of {identity} names no reviewer")); }
                if makers.contains(&reviewer) { here.push(format!("{identity} was reviewed by {reviewer}, who made it; the reviewer is someone else")); }
                if let Some(by) = by { if by != &reviewer { here.push(format!("the review of {identity} names reviewer {reviewer} but was answered by {by}")); }
                    if makers.contains(by) { here.push(format!("the review of {identity} was answered by {by}, who made it")); } }
            }
        }
        if here.is_empty() {
            if !plain(&store) { here.push("the run names no store to read the piece's checks from (input.store)".into()); }
            else {
                // The one rule is the store's own function (piece_gate_misses, the same one its post and send triggers use):
                // every required check of the kind, the latest verdict for this file, none by a maker; empty means it passes.
                let names: Vec<String> = makers.iter().filter(|m| plain(m)).cloned().collect();
                match sql_read(&database_of(&store), "select check_id, reason, named from piece_gate_misses($1, $2, string_to_array($3, ','))", json!([identity, kind, names.join(",")])) {
                    Err(e) => here.push(format!("the checks for kind {kind} could not be read from {store}: {}", e.chars().take(300).collect::<String>())),
                    Ok(rows) => for row in rows.iter() {
                        // The elements a check names as failing (an element with no citation, say) are listed by name.
                        let named = ["uncited", "elements", "failing", "items"].iter().find_map(|k| row["named"][k].as_array().cloned()).unwrap_or_default();
                        let named: Vec<String> = named.iter().map(|e| e.as_str().map(String::from).or_else(|| e["name"].as_str().map(String::from)).unwrap_or_else(|| e.to_string())).collect();
                        here.push(format!("{}: {}{}", row["check_id"].as_str().unwrap_or(""), row["reason"].as_str().unwrap_or(""), if named.is_empty() { String::new() } else { format!(" [{}]", named.join(", ")) }));
                    },
                }
            }
        }
        decisions.push(json!({ "run": run.rsplit('/').next().unwrap_or(run), "piece": thing, "file_identity": identity, "kind": kind, "passed": here.is_empty(),
            "misses": here, "maker": makers.iter().cloned().collect::<Vec<_>>().join(","), "reviewer": reviewer, "steps": decision_steps(run, &answers) }));
        misses.extend(here);
    }
    if plain(&store) {
        let text = Value::Array(decisions).to_string();
        // A round is one file of a piece: the same file judged again keeps its round, a new version of the piece is the
        // next. A decision equal to that file's latest is not written again (wf show walks the run many times).
        let sql = "insert into piece_gate_decisions (run, piece, round, file_identity, kind, passed, misses, maker, reviewer, steps)
                select d->>'run', d->>'piece', coalesce((select p.round from piece_gate_decisions p where p.piece = d->>'piece' and p.file_identity = d->>'file_identity' limit 1),
                    (select count(distinct p.file_identity) from piece_gate_decisions p where p.piece = d->>'piece') + 1),
                  d->>'file_identity', d->>'kind', (d->>'passed')::boolean, d->'misses', d->>'maker', d->>'reviewer', d->'steps'
                from jsonb_array_elements($1::jsonb) d
                where not exists (select 1 from (select p.passed, p.misses, p.reviewer from piece_gate_decisions p where p.piece = d->>'piece' and p.file_identity = d->>'file_identity' order by p.at desc limit 1) l
                    where l.passed = (d->>'passed')::boolean and l.misses = d->'misses' and l.reviewer = d->>'reviewer') returning 1";
        if let Err(e) = sql_rows(&database_of(&store), sql, json!([text])) { eprintln!("the review gate's decision is not kept in {store} ({e})"); }
    }
    if misses.is_empty() { Ok(()) } else { Err(misses) }
}
// The run's steps up to a gate decision, for workflow:turn-a-fix-into-its-workflow: each answered step's id, kind, who
// answered and when, and its made and misses fields; never the answer bodies.
fn decision_steps(run: &str, answers: &BTreeMap<String, Value>) -> Value {
    let answered_by: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_by.json"))).unwrap_or_default();
    let answered_at: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_at.json"))).unwrap_or_default();
    let kinds: BTreeMap<String, String> = workflow_engine::uses::with_uses(read(&format!("{run}/definition.json"))).unwrap_or_default().iter()
        .flat_map(|d| d["steps"].as_array().cloned().unwrap_or_default())
        .filter_map(|s| Some((s["id"].as_str()?.to_string(), s["kind"].as_str().unwrap_or("").to_string()))).collect();
    let mut steps: Vec<Value> = answers.iter().map(|(step, answer)| json!({ "step": step, "kind": kinds.get(step).cloned().unwrap_or_default(),
        "answered_by": answered_by.get(step).cloned().unwrap_or_else(|| "tool".into()), "at": answered_at.get(step).cloned().unwrap_or_default(),
        "made": answer.get("made").cloned().unwrap_or(Value::Null), "misses": answer.get("misses").cloned().unwrap_or(Value::Null) })).collect();
    steps.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    Value::Array(steps)
}
// Every ask each chat on this computer took in the last hours, and whether its work ran inside a workflow run (a wf start
// or answer while handling it) or by hand: read from the chats' own transcripts, so a hand job shows as an exception
// without any chat reporting it (Nov 21 2026: jobs were done by hand while the harness sat unused).
fn audit(hours: u64) -> Result<Vec<Value>, String> {
    let names: BTreeMap<String, String> = std::fs::read_dir(format!("{}/.claude/sessions", home())).map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()).filter_map(|e| serde_json::from_str::<Value>(&std::fs::read_to_string(e.path()).ok()?).ok())
        .filter_map(|v| Some((v["sessionId"].as_str()?.to_string(), v["name"].as_str().unwrap_or("").to_string()))).collect();
    let listed = Command::new("find").args([&claude_projects(), "-name", "*.jsonl", "-not", "-path", "*/subagents/*", "-mmin", &format!("-{}", hours * 60)])
        .stdout(Stdio::piped()).stderr(Stdio::null()).output().map_err(|e| e.to_string())?;
    let since = Command::new("date").args(["-u", "-v", &format!("-{hours}H"), "+%Y-%m-%dT%H:%M:%SZ"]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let wf_call = regex::Regex::new(r"\bwf (start|answer)\b").unwrap();
    let mut jobs = vec![];
    for file in String::from_utf8_lossy(&listed.stdout).lines() {
        let session = file.rsplit('/').next().unwrap_or("").trim_end_matches(".jsonl").to_string();
        let content = std::fs::read_to_string(file).unwrap_or_default();
        let mut current: Option<Value> = None;
        let close = |job: Option<Value>, jobs: &mut Vec<Value>| { if let Some(j) = job { if j["calls"].as_u64().unwrap_or(0) > 0 { jobs.push(j); } } };
        for line in content.lines() {
            let Ok(o) = serde_json::from_str::<Value>(line) else { continue };
            let at = o["timestamp"].as_str().unwrap_or_default().to_string();
            if at.as_str() < since.as_str() { continue; }
            if o["type"] == "user" {
                let text = match &o["message"]["content"] { Value::String(t) => t.clone(),
                    Value::Array(a) => a.iter().filter(|x| x["type"] == "text").filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join(" "), _ => String::new() };
                let text = text.trim().to_string();
                if text.is_empty() || text.starts_with("<system-reminder>") || text.starts_with("<task-notification") || text.contains("\"idle_notification\"") { continue; }
                close(current.take(), &mut jobs);
                let from = if text.contains("cross-session-message") || text.contains("teammate-message") { "peer" } else { "person" };
                let ask: String = regex::Regex::new(r"<[^>]+>").unwrap().replace_all(&text, " ").split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
                current = Some(json!({ "session": session, "chat": names.get(&session).cloned().unwrap_or_default(), "ask_at": at, "from": from, "ask": ask, "calls": 0, "in_run": false, "asked_him": 0, "checked_first": false }));
            } else if o["type"] == "assistant" {
                if let Some(job) = current.as_mut() {
                    for part in o["message"]["content"].as_array().into_iter().flatten().filter(|p| p["type"] == "tool_use") {
                        job["calls"] = json!(job["calls"].as_u64().unwrap_or(0) + 1);
                        if wf_call.is_match(&part["input"].to_string()) { job["in_run"] = json!(true); }
                        // A question card put to the person, and whether the question workflow ran before it in this ask.
                        if part["input"].to_string().contains("answer-a-question-before-it-reaches-the-person") { job["checked_first"] = json!(true); }
                        if part["name"] == "AskUserQuestion" { job["asked_him"] = json!(job["asked_him"].as_u64().unwrap_or(0) + 1); }
                    }
                }
            }
        }
        close(current.take(), &mut jobs);
    }
    jobs.sort_by(|a, b| a["ask_at"].as_str().cmp(&b["ask_at"].as_str()));
    Ok(jobs)
}
// Keeps a recorded path as one row of the runs database's recorded_paths (a row arriving fires
// workflow:turn-a-recorded-path-into-a-workflow), through the one held-database opener so no connection string is seen.
fn keep_path(path: &Value) -> Result<String, String> {
    const SQL: &str = "insert into recorded_paths (path_id, pursuit, title, problem, who, steps, came_from) select p->>'path_id', p->>'pursuit', p->>'title', p->>'problem', p->>'who', p->'steps', p->>'came_from' from (select $1::jsonb as p) x on conflict (path_id) do update set title = excluded.title, problem = excluded.problem, steps = excluded.steps, came_from = excluded.came_from returning path_id, jsonb_array_length(steps) as steps";
    let rows = sql_rows(&setting("runs_database"), SQL, json!([path.to_string()]))?;
    Ok(rows.first().map(Value::to_string).unwrap_or_default())
}

/// Adds to the run's kept definition each missed workflow wf can read (the person's own stores, else Workshop main) that it
/// does not hold yet; whether it added any.
fn add_missed(run: &str, missed: Vec<Value>) -> bool {
    if missed.is_empty() { return false; }
    let mut def = read(&format!("{run}/definition.json"));
    let have: BTreeSet<String> = workflow_engine::uses::with_uses(def.clone()).unwrap_or_default().iter().filter_map(|d| d["id"].as_str().map(String::from)).collect();
    let mut added = false;
    for named in missed.iter().filter_map(Value::as_str).filter(|named| !have.contains(*named)) {
        let kept = definition_named(named);
        if kept.is_null() { eprintln!("the run chose {named}, which is on neither Workshop main nor in the person's own stores"); continue; }
        if !def["uses"].is_array() { def["uses"] = json!([]); }
        def["uses"].as_array_mut().unwrap().push(kept);
        eprintln!("read {named}, which the run chose, and walk again");
        added = true;
    }
    if added { std::fs::write(format!("{run}/definition.json"), serde_json::to_vec(&def).unwrap()).unwrap(); }
    added
}

// A step that waits on a hand ask ("anyone", "ai", "whoever-holds-the-run") is given once, as the task
// record:calendar-task:step-<fact_id>, by the same workflow the engine's own runs reach (the Mac's a-step-is-waiting wake
// runs workflow:give-a-waiting-step-to-its-answerer for each workflow-step-waiting fact): wf starts that workflow from its
// row with the wake's input ({fact_id, fact, pursuit, database}; $WF_GIVE_INPUT for pursuit/database; the give names no taker, takers claim), the
// fact in the engine's own shape (tools/workflows/crates/workflow-component effect_of). Telling the fact at the door is no
// road: that wake hears only facts from runs, and a door-told fact holds at most 8 text fields (3:20 AM CST Nov 22). Its told_as names this run's folder; source wf-step-answered, so no
// engine wake mistakes it for one of its own runs. When that task is Done, the next walk of this run (wf show or answer)
// reads its result and answers the step with it, through the same shape check a typed answer gets; answered_by is the
// task's finished_by. A result that is not JSON, or that the step refuses, is not kept and is said in told_waiting.json.
// Nov 22 2026 (hand-asks-to-model): three wf runs waited 1:54-1:57 AM CST on anyone asks and no one was ever given them.
const HAND_ASKS: [&str; 3] = ["anyone", "ai", "whoever-holds-the-run"];
fn plain_id(s: &str) -> bool { !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || ":_-./".contains(c)) }
fn fact_id_of(run: &str, step: &str) -> String {
    format!("wf-{}:{}", run.rsplit('/').next().unwrap_or(run), step)
}
fn tell_waiting(run: &str, workflow: &str, waiting: &[Value]) {
    let file = format!("{run}/told_waiting.json");
    let mut told: serde_json::Map<String, Value> = read(&file).as_object().cloned().unwrap_or_default();
    let started_by = read(&format!("{run}/started_by.json"));
    let mut changed = false;
    for w in waiting {
        let (step, name) = (w["step"].as_str().unwrap_or_default(), w["for"].as_str().unwrap_or_default());
        if !HAND_ASKS.contains(&name) || told.get(step).is_some_and(|t| t["told"] == true) { continue; }
        let fact_id = fact_id_of(run, step);
        let told_as = json!({ "source": "wf-step-answered", "event_id": fact_id,
            "payload": { "workflow": workflow, "run": run, "step": step, "for": name } });
        let fact = json!({ "kind": "workflow-step-waiting", "event_id": fact_id,
            "payload": { "workflow": workflow, "step": step, "for": name, "asks": w["asks"], "told_as": told_as, "started_by": started_by } });
        let mut give: Value = std::env::var("WF_GIVE_INPUT").ok().and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({ "pursuit": setting("host"), "database": setting("runs_database") }));
        give["fact_id"] = json!(fact_id);
        give["fact"] = fact["payload"].clone();
        give["request"] = json!(format!("give the waiting step {step} of {run} to {name}"));
        let me = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "wf".into());
        let sent = Command::new(&me).args(["start", "workflow:give-a-waiting-step-to-its-answerer", "-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().and_then(|mut child| { child.stdin.take().unwrap().write_all(give.to_string().as_bytes())?; child.wait_with_output() });
        let entry = match sent {
            Ok(out) => {
                let shown: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
                if shown["status"] == "completed" {
                    eprintln!("  {step}: given as the task record:calendar-task:step-{fact_id} (run {})", shown["run"].as_str().unwrap_or(""));
                    json!({ "told": true, "at": now_utc(), "fact_id": fact_id, "task": format!("record:calendar-task:step-{fact_id}"), "for": name, "giver_run": shown["run"] })
                } else {
                    json!({ "told": false, "at": now_utc(), "fact_id": fact_id, "giver_run": shown["run"], "error": format!("the giver ended {}: {}", shown["status"],
                        String::from_utf8_lossy(&out.stderr).trim().chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()) })
                }
            }
            Err(e) => json!({ "told": false, "at": now_utc(), "fact_id": fact_id, "error": e.to_string() }),
        };
        if entry["told"] != true { eprintln!("  {step}: could not give it as a task ({}); the next walk tries again", entry["error"]); }
        told.insert(step.to_string(), entry);
        changed = true;
    }
    if changed { std::fs::write(&file, serde_json::to_vec_pretty(&told).unwrap()).ok(); }
}
// The answers of told steps whose task is Done, put with the run's answers before it is walked: {step: finished_by}.
fn take_task_answers(run: &str) -> BTreeMap<String, String> {
    let file = format!("{run}/told_waiting.json");
    let mut told: serde_json::Map<String, Value> = read(&file).as_object().cloned().unwrap_or_default();
    let mut answers: BTreeMap<String, Value> = serde_json::from_value(read(&format!("{run}/answers.json"))).unwrap_or_default();
    let open: Vec<(String, String)> = told.iter().filter(|(step, t)| t["told"] == true && t["answered_at"].is_null() && !answers.contains_key(*step))
        .filter_map(|(step, t)| t["task"].as_str().filter(|id| plain_id(id)).map(|id| (step.clone(), id.to_string()))).collect();
    let mut taken = BTreeMap::new();
    if open.is_empty() { return taken; }
    let ids_list = open.iter().map(|(_, id)| id.as_str()).collect::<Vec<_>>().join(",");
    let rows = match sql_read(&setting("runs_database"), "select id, status, result, outcome, finished_by from calendar_tasks where id = any(string_to_array($1, ','))", json!([ids_list])) {
        Ok(rows) => rows,
        Err(e) => { eprintln!("could not read the told steps' tasks: {e}"); return taken; }
    };
    for (step, id) in open {
        let Some(row) = rows.iter().find(|r| r["id"] == id.as_str()) else { continue };
        if row["status"] != "Done" { continue; }
        let text = row["result"].as_str().or(row["outcome"].as_str()).unwrap_or_default().to_string();
        let entry = told.get_mut(&step).unwrap();
        if entry["refused_result"] == text.as_str() { continue; }
        match serde_json::from_str::<Value>(text.trim()) {
            Ok(value) => {
                let by = row["finished_by"].as_str().unwrap_or("").to_string();
                answers.insert(step.clone(), value);
                entry["answered_at"] = json!(now_utc());
                entry["answered_by"] = json!(by);
                entry["taken_text"] = json!(text);
                taken.insert(step.clone(), by);
            }
            Err(_) => { entry["refused_result"] = json!(text); entry["refused_why"] = json!("the task's result is not JSON; finish the task with the step's submit as JSON"); }
        }
    }
    std::fs::write(&file, serde_json::to_vec_pretty(&told).unwrap()).ok();
    if !taken.is_empty() {
        std::fs::write(format!("{run}/answers.json"), serde_json::to_vec_pretty(&answers).unwrap()).unwrap();
        let mut by_file: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_by.json"))).unwrap_or_default();
        let mut at_file: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_at.json"))).unwrap_or_default();
        for (step, by) in &taken { by_file.insert(step.clone(), by.clone()); at_file.insert(step.clone(), now_utc()); eprintln!("  {step}: answered by its task, finished by {by}"); }
        std::fs::write(format!("{run}/answered_by.json"), serde_json::to_vec_pretty(&by_file).unwrap()).unwrap();
        std::fs::write(format!("{run}/answered_at.json"), serde_json::to_vec_pretty(&at_file).unwrap()).unwrap();
    }
    taken
}
// A task's answer the step refused (shape, or a review gate hold) is taken out again and said, never kept.
fn untake_task_answers(run: &str, refused: &[(String, String)]) {
    let file = format!("{run}/told_waiting.json");
    let mut told: serde_json::Map<String, Value> = read(&file).as_object().cloned().unwrap_or_default();
    let mut answers: BTreeMap<String, Value> = serde_json::from_value(read(&format!("{run}/answers.json"))).unwrap_or_default();
    let mut by_file: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_by.json"))).unwrap_or_default();
    let mut at_file: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_at.json"))).unwrap_or_default();
    for (step, why) in refused {
        answers.remove(step);
        by_file.remove(step); at_file.remove(step);
        if let Some(entry) = told.get_mut(step) {
            // The task's own text, as take_task_answers compares it, so the same result is never taken again.
            entry["refused_result"] = entry["taken_text"].clone();
            entry["refused_why"] = json!(why);
            entry["answered_at"] = Value::Null;
            entry["answered_by"] = Value::Null;
        }
        eprintln!("  {step}: its task's answer was refused and not kept: {why}");
    }
    std::fs::write(format!("{run}/answers.json"), serde_json::to_vec_pretty(&answers).unwrap()).unwrap();
    std::fs::write(format!("{run}/answered_by.json"), serde_json::to_vec_pretty(&by_file).unwrap()).unwrap();
    std::fs::write(format!("{run}/answered_at.json"), serde_json::to_vec_pretty(&at_file).unwrap()).unwrap();
    std::fs::write(&file, serde_json::to_vec_pretty(&told).unwrap()).ok();
}
// A step answered here by hand that tell_waiting also gave as a task has that task finished with the same answer, so the
// board keeps no To do task for a step that no longer waits (Nov 22 2026, lane give-to-a-taker: one lane's wf runs left
// about 80 such tasks open in an hour). Only a task still To do changes; a failed write leaves the step answered and says so.
fn finish_told_task(run: &str, step: &str, answer: &Value) {
    let told = read(&format!("{run}/told_waiting.json"));
    let Some(task) = told[step]["task"].as_str().filter(|id| plain_id(id)) else { return };
    const FINISH: &str = "with done as (update calendar_tasks set status = 'Done', result = $2, finished_by = $3, finished_at = now()::text, changed_at = now() where id = $1 and status = 'To do' returning id) insert into task_changes (task_id, kind, status, title) select id, 'status', 'Done', 'Answered by hand in its wf run' from done returning task_id";
    if let Err(e) = sql_rows(&setting("runs_database"), FINISH, json!([task, answer.to_string(), actor()])) {
        eprintln!("  {step}: its task {task} stays To do ({e}); the step itself is answered");
    }
}

async fn go(run: &str, print: bool) -> Value {
    let cancelled = read(&format!("{run}/cancelled.json"));
    if !cancelled.is_null() {
        let shown = json!({ "run": run, "status": "cancelled", "cancelled": cancelled });
        if print { println!("{}", serde_json::to_string_pretty(&shown).unwrap()); }
        return shown;
    }
    let def = read(&format!("{run}/definition.json"));
    let paused = read(&format!("{run}/fill_paused.json"));
    if !paused.is_null() {
        let mut given = read(&format!("{run}/input.json"));
        let started = read(&format!("{run}/started_at.json")).as_str().unwrap_or_default().to_string();
        let ended = match fill_store(&mut given).await {
            Fill::Filled(filled) => {
                let problems = input_problems(&def["input_schema"], &given);
                if problems.is_empty() {
                    std::fs::write(format!("{run}/input.json"), given.to_string()).unwrap();
                    if !filled.is_empty() { std::fs::write(format!("{run}/filled_from.json"), serde_json::to_vec_pretty(&filled).unwrap()).unwrap(); }
                    std::fs::rename(format!("{run}/fill_paused.json"), format!("{run}/fill_resumed.json")).unwrap();
                    eprintln!("the store read answered; the run goes on");
                    None
                } else { Some(("cancelled", format!("the input was not filled: it does not meet the workflow's input_schema: {}", problems.join("; ")))) }
            }
            Fill::Refused(why) => Some(("cancelled", if why.starts_with("the input was not filled") { why } else { format!("the input was not filled: {why}") })),
            Fill::ReadFailed(why) => Some(("paused", why)),
        };
        if let Some((status, why)) = ended {
            let note = json!({ "at": now_utc(), "by": actor(), "why": why, "first": paused.get("first").cloned().unwrap_or_else(|| paused.clone()) });
            std::fs::write(format!("{run}/{}.json", if status == "cancelled" { "cancelled" } else { "fill_paused" }), serde_json::to_vec(&note).unwrap()).unwrap();
            let id = def["id"].as_str().unwrap_or_default().to_string();
            let shown = json!({ "run": run, "status": status, status: note });
            keep_run_row(run, &id, &started, &json!({ "status": status, status: note }));
            if print { println!("{}", serde_json::to_string_pretty(&shown).unwrap()); }
            return shown;
        }
    }
    let first: workflow_core::Definition = match serde_json::from_value(def.clone()) {
        Ok(d) => d,
        Err(e) => { eprintln!("the run's definition ({run}/definition.json) does not decode: {e}"); std::process::exit(1); }
    };
    let mut defs: Vec<workflow_core::Definition> = vec![first];
    // Every workflow in its uses at any depth (workflow_engine::uses), so a body kept in a sub-workflow's own uses is found.
    let all = workflow_engine::uses::with_uses(def.clone()).unwrap_or_else(|why| { eprintln!("{why}"); std::process::exit(1) });
    for used in all.into_iter().skip(1) { if let Ok(d) = serde_json::from_value(used) { defs.push(d); } }
    let id = def["id"].as_str().unwrap().to_string();
    let taken = take_task_answers(run);
    let answers: BTreeMap<String, Value> = serde_json::from_value(read(&format!("{run}/answers.json"))).unwrap_or_default();
    let host = Arc::new(OneRule { answers: Mutex::new(answers), file: format!("{run}/answers.json"), waiting: Mutex::new(vec![]) });
    let started = read(&format!("{run}/started_at.json")).as_str().unwrap_or_default().to_string();
    let out = workflow_engine::run_definition_with_started_at(defs, &id, read(&format!("{run}/input.json")), run_person().as_str(), &setting("host"), &started, host.clone()).await;
    // A walk that failed on workflows a step chose at run time and nothing held (a family member added by its row) reads
    // them where wf reads every named workflow, keeps them with the run, and walks again from the held answers.
    if let Ok(r) = &out {
        if r["status"] == "failed" && add_missed(run, r["definitions_missed"].as_array().cloned().unwrap_or_default()) {
            return Box::pin(go(run, print)).await;
        }
    }
    let shown = match out {
        Ok(r) => {
            if std::env::var("WF_DUMP_STEPS").is_ok() { std::fs::write(format!("{run}/engine-steps.json"), serde_json::to_vec_pretty(&r["execution_context"]["steps"]).unwrap()).ok(); }
            // A branch not taken is "completed" to the engine with error "Skipped — …"; it is shown as skipped, never as done.
            let steps: BTreeMap<String, Value> = r["execution_context"]["steps"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(),
                if v["error"].as_str().is_some_and(|e| e.starts_with("Skipped")) { json!("skipped") } else { v["status"].clone() })).collect()).unwrap_or_default();
            let failed: Vec<Value> = r["execution_context"]["steps"].as_object().map(|m| m.iter().filter(|(_, v)| v["status"] == "failed").map(|(k, v)| {
                let why = v["output"]["dispatch_failed"]["reason"].clone();
                json!({ "step": k, "error": if why.is_null() { v["error"].clone() } else { why }, "output": v["output"] })
            }).collect()).unwrap_or_default();
            // A run can fail with no failed step (a compile or edge error, a binding no step owns); say the engine's own words.
            // Nov 21 2026: a pursuit's reader run ended failed after held-names with no reason shown.
            let why = [&r["error_message"], &r["error"], &r["execution_context"]["error"], &r["reason"], &r["failure"]].into_iter().find(|v| !v.is_null()).cloned();
            let mut shown = json!({ "run": run, "status": r["status"], "steps": steps, "failed": failed, "waiting": *host.waiting.lock().unwrap() });
            if r["status"] == "failed" && failed.is_empty() {
                shown["why"] = why.unwrap_or_else(|| json!({ "no_reason_given": r.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                    "execution_context": r["execution_context"].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() }));
            }
            shown
        }
        Err(e) => json!({ "run": run, "status": "engine-error", "error": e }),
    };
    // A run that made a piece for a person completes only once its review passed (piece_gate); until then it is held.
    let mut shown = shown;
    if shown["status"] == "completed" {
        if let Err(misses) = piece_gate(run) { shown["status"] = json!("held-for-review"); shown["review_misses"] = json!(misses); }
    }
    // An answer taken from a task that the step refused, or that would end the run before its review passed, is put back.
    if !taken.is_empty() {
        let mut refused: Vec<(String, String)> = shown["failed"].as_array().into_iter().flatten()
            .filter_map(|f| f["step"].as_str().filter(|s| taken.contains_key(*s)).map(|s| (s.to_string(), f["error"].to_string()))).collect();
        if shown["status"] == "held-for-review" {
            refused.extend(taken.keys().map(|s| (s.clone(), format!("it would end the run before what it made passed review: {}", shown["review_misses"]))));
        }
        if !refused.is_empty() {
            untake_task_answers(run, &refused);
            return Box::pin(go(run, print)).await;
        }
    }
    if let Some(waiting) = shown["waiting"].as_array().cloned() { tell_waiting(run, &id, &waiting); }
    std::fs::write(format!("{run}/last.json"), serde_json::to_vec_pretty(&shown).unwrap()).ok();
    keep_run_row(run, &id, &started, &shown);
    if print { println!("{}", serde_json::to_string_pretty(&shown).unwrap()); }
    shown
}

/// A JSON argument as given: `-` reads it from standard input and `@PATH` from that file, so personal data in a start's
/// input or an answer (a customer's name and email) never shows on the command line other processes can list.
fn json_arg(given: &str) -> String {
    json_text(given, || { let mut text = String::new(); std::io::Read::read_to_string(&mut std::io::stdin(), &mut text).map(|_| text) })
        .unwrap_or_else(|e| { eprintln!("{e}"); std::process::exit(1) })
}

// A new run's folder, made whole with its first files. It is made only once the input is complete (see the start arm), so a
// start that is refused writes no folder. create_dir, so two starts can never take one folder: the second it started, then a
// part no other start shares (this process and the nanosecond).
fn make_run(id: &str, def: &Value, input: &str) -> String {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    std::fs::create_dir_all(runs_dir()).unwrap();
    let run = format!("{}/{}-{}{:09}-{}", runs_dir(), since.as_secs(), std::process::id(), since.subsec_nanos(), id.replace(':', "_"));
    if let Err(e) = std::fs::create_dir(&run) { eprintln!("could not make the run folder {run}: {e}"); std::process::exit(1); }
    std::fs::write(format!("{run}/started_by.json"), serde_json::to_vec(&actor()).unwrap()).unwrap();
    std::fs::write(format!("{run}/person.json"), serde_json::to_vec(&run_person()).unwrap()).unwrap();
    std::fs::write(format!("{run}/definition.json"), serde_json::to_vec(def).unwrap()).unwrap();
    std::fs::write(format!("{run}/answers.json"), "{}").unwrap();
    std::fs::write(format!("{run}/input.json"), input).unwrap();
    run
}

// The file a store fill's answer is kept in: under the wf home, not in a run folder, since the fill runs before any run exists.
fn fill_answers_file() -> String {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    std::fs::create_dir_all(format!("{}/fills", wf_home())).unwrap();
    format!("{}/fills/{}-{}{:09}.json", wf_home(), since.as_secs(), std::process::id(), since.subsec_nanos())
}

// A start whose store read keeps failing is kept paused, its input as given and the read error in fill_paused.json; any later
// wf show or answer reads the store again first (go), so a failed read never cancels a good run (Nov 22 2026).
fn paused_start(id: &str, def: &Value, input: &str, why: String) -> ! {
    eprintln!("{why}");
    let run = make_run(id, def, input);
    let started = now_utc();
    std::fs::write(format!("{run}/started_at.json"), serde_json::to_vec(&started).unwrap()).ok();
    let paused = json!({ "at": now_utc(), "by": actor(), "why": why });
    std::fs::write(format!("{run}/fill_paused.json"), serde_json::to_vec(&paused).unwrap()).ok();
    keep_pick(json!({ "command": "start", "workflow": id, "run": run, "by": actor(), "paused": why }));
    keep_run_row(&run, id, &started, &json!({ "status": "paused", "paused": paused }));
    println!("{}", serde_json::to_string_pretty(&json!({ "run": run, "status": "paused", "paused": paused,
        "next": "wf show RUN reads the store again and goes on when it answers" })).unwrap());
    std::process::exit(3);
}

// A start whose fill is refused ends cancelled with the reason, its run folder kept with the input as given (Nov 21 2026).
fn refused_start(id: &str, def: &Value, input: &str, why: String) -> ! {
    let why = if why.starts_with("the input was not filled") { why } else { format!("the input was not filled: {why}") };
    eprintln!("{why}");
    let run = make_run(id, def, input);
    std::fs::write(format!("{run}/cancelled.json"), serde_json::to_vec(&json!({ "at": now_utc(), "by": actor(), "why": why })).unwrap()).ok();
    std::process::exit(1)
}

// The JSON type a value has, in the words a schema uses; null is not a value a field is given (see input_problems).
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
fn is_type(value: &Value, want: &str) -> bool {
    match want {
        "string" => value.is_string(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some() || value.as_f64().is_some_and(|f| f.fract() == 0.0),
        "null" => value.is_null(),
        _ => true,
    }
}

// The input checked against the row's input_schema, after the fill. Every required field must be given (null is not given,
// as the fill reads it), and a given field that declares a type must hold that type. Each problem is one line: the refusal
// code, then the fields named. A definition with no input_schema has nothing to check.
fn input_problems(schema: &Value, given: &Value) -> Vec<String> {
    let props = schema["properties"].as_object().cloned().unwrap_or_default();
    let declared = |name: &str| props.get(name).and_then(|p| p["type"].as_str()).unwrap_or("any").to_string();
    let mut problems = vec![];
    let missing: Vec<String> = schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str)
        .filter(|name| given.get(*name).is_none_or(Value::is_null))
        .map(|name| format!("{name} ({})", declared(name)))
        .collect();
    if !missing.is_empty() { problems.push(format!("missing_required_input: {}", missing.join(", "))); }
    for (name, prop) in &props {
        let Some(want) = prop["type"].as_str() else { continue };
        match given.get(name) {
            None | Some(Value::Null) => continue,
            Some(value) if !is_type(value, want) => problems.push(format!("wrong_input_type: {name} must be {want}, given {}", kind_of(value))),
            Some(_) => {}
        }
    }
    problems
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("find") => find(&a[2..]),
        Some("kinds") => list_kinds(&a[2..]),
        Some("start") if a.len() > 2 => {
            let id = &a[2];
            // A definition file (a path ending .json) runs as it is: how wf's own checks run without a row.
            let def = if id.ends_with(".json") && std::path::Path::new(id).exists() { read(id) } else { definition_named(id) };
            let id = &(if id.ends_with(".json") { def["id"].as_str().unwrap_or("workflow:from-a-file").to_string() } else { id.clone() });
            if def.is_null() { eprintln!("no workflow {id} on Workshop main or kept in the person's own stores; find one with wf find WORDS"); std::process::exit(1); }
            // A workflow another names (an action or loop step's definition_id) is read from where it is kept, its own row
            // first, and kept with the run as it is now: one row every workflow names, never a copy in each definition.
            let mut def = def;
            // Every definition the run carries is walked: its own steps and those of each workflow kept in its uses, at any depth.
            let carried = workflow_engine::uses::with_uses(def.clone()).unwrap_or_else(|why| { eprintln!("{why}"); std::process::exit(1) });
            let mut have: BTreeSet<String> = carried.iter().filter_map(|u| u["id"].as_str().map(String::from)).collect();
            let mut todo: Vec<Value> = carried;
            while let Some(next) = todo.pop() {
                // A step names one workflow (definition_id), or lists those a row may choose among (definition_refs).
                for named in workflow_engine::uses::missing(&[next.clone()]) {
                    if !have.insert(named.clone()) { continue; }
                    let kept = definition_named(&named);
                    if kept.is_null() { eprintln!("{id} names {named}, which is on neither Workshop main nor in the person's own stores"); std::process::exit(1); }
                    if !def["uses"].is_array() { def["uses"] = json!([]); }
                    def["uses"].as_array_mut().unwrap().push(kept.clone());
                    // A workflow read from a row brings its own uses, whose steps may name more.
                    for inner in workflow_engine::uses::with_uses(kept).unwrap_or_default() {
                        if let Some(id) = inner["id"].as_str() { have.insert(id.to_string()); }
                        todo.push(inner);
                    }
                }
            }
            let input = a.get(3).map(|given| json_arg(given)).unwrap_or_else(|| "{}".into());
            if serde_json::from_str::<Value>(&input).map(|v| !v.is_object()).unwrap_or(true) { eprintln!("the input is a JSON object, for example '{{\"request\":\"the job in one line\"}}'"); std::process::exit(1); }
            // The input is kept exactly as given before anything is filled, and a fill only ever adds to it. A start whose fill
            // is refused ends cancelled with the reason, so no later wf show or answer walks a run without its input (Nov 21
            // 2026, 9:04 PM CST: three keep-the-content-engine-writing runs whose store had no account row were refused, left
            // with no input.json, and then walked by a later command, failing "no credential_name"). The run folder is made only
            // once the input is complete, and checked against the row's input_schema first: a start the schema refuses writes no
            // folder (Nov 21 2026: workflow:walk-a-clients-facts run 1795320024 started with no credential_name).
            let mut given: Value = serde_json::from_str(&input).unwrap();
            // A read that keeps failing pauses the run with the read error (wf show RUN reads again); see fill_store.
            let filled = match fill_store(&mut given).await {
                Fill::Filled(filled) => filled,
                Fill::Refused(why) => refused_start(id, &def, &input, why),
                Fill::ReadFailed(why) => paused_start(id, &def, &input, why),
            };
            if !filled.is_empty() {
                eprintln!("filled {} from {}", filled.keys().cloned().collect::<Vec<_>>().join(", "),
                    filled.values().filter_map(Value::as_str).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>().join(", "));
            }
            let problems = input_problems(&def["input_schema"], &given);
            if !problems.is_empty() {
                for problem in &problems { eprintln!("{problem}"); }
                eprintln!("the start of {id} is refused: its input does not meet the workflow's input_schema; no run folder was written");
                std::process::exit(1);
            }
            let run_input = if filled.is_empty() { input.clone() } else { given.to_string() };
            let run = make_run(id, &def, &run_input);
            if !filled.is_empty() { std::fs::write(format!("{run}/filled_from.json"), serde_json::to_vec_pretty(&filled).unwrap()).unwrap(); }
            std::fs::write(format!("{run}/started_at.json"), serde_json::to_vec(&now_utc()).unwrap()).unwrap();
            keep_pick(json!({ "command": "start", "workflow": id, "run": run, "by": actor() }));
            go(&run, true).await;
        }
        Some("answer") if a.len() > 4 => {
            let (run, step) = (&run_of(&a[2]), &a[3]);
            if let Some(refusal) = holder_refusal(run) { eprintln!("{refusal}"); std::process::exit(1); }
            if !read(&format!("{run}/cancelled.json")).is_null() { eprintln!("run {run} is cancelled"); std::process::exit(1); }
            let value: Value = match serde_json::from_str(&json_arg(&a[4])) { Ok(v) => v, Err(e) => { eprintln!("the answer is not JSON: {e}"); std::process::exit(1); } };
            // Only a step that waits for whoever holds the run, or one the engine refused, is answered here; a tool's or
            // a program's answer comes from running it, never from a chat.
            let last = read(&format!("{run}/last.json"));
            let waits = last["waiting"].as_array().into_iter().flatten().any(|w| w["step"] == step.as_str() && !w["for"].as_str().unwrap_or("").starts_with("tool:"));
            // Only an answer the engine refused for its shape is handed in again. A tool, program or check that failed is
            // never answered by a chat: that would let a chat hand in a judge's verdict.
            let refused = last["failed"].as_array().into_iter().flatten().any(|f| f["step"] == step.as_str()
                && f["error"].as_str().is_some_and(|e| e.starts_with(&format!("The answer to step {step} does not fit"))));
            if !waits && !refused {
                eprintln!("step {step} is not waiting for you in {run} (status {}); it waits for: {}", last["status"],
                    last["waiting"].as_array().into_iter().flatten().map(|w| format!("{} ({})", w["step"].as_str().unwrap_or(""), w["for"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "));
                std::process::exit(1);
            }
            let mut answers: BTreeMap<String, Value> = serde_json::from_value(read(&format!("{run}/answers.json"))).unwrap_or_default();
            answers.insert(step.clone(), value);
            std::fs::write(format!("{run}/answers.json"), serde_json::to_vec_pretty(&answers).unwrap()).unwrap();
            // Who answered each step, so the review gate can tell a piece's makers from its reviewer.
            let mut answered_by: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_by.json"))).unwrap_or_default();
            answered_by.insert(step.clone(), actor());
            std::fs::write(format!("{run}/answered_by.json"), serde_json::to_vec_pretty(&answered_by).unwrap()).unwrap();
            let mut answered_at: BTreeMap<String, String> = serde_json::from_value(read(&format!("{run}/answered_at.json"))).unwrap_or_default();
            answered_at.insert(step.clone(), now_utc());
            std::fs::write(format!("{run}/answered_at.json"), serde_json::to_vec_pretty(&answered_at).unwrap()).unwrap();
            let shown = go(run, false).await;
            keep_pick(json!({ "command": "answer", "run": run, "step": step, "status": shown["status"], "refused": shown["failed"].as_array().map(|f| f.len()).unwrap_or(0) }));
            // An answer that would end the run while a piece it made has no passing review is not kept: the step waits again,
            // and its maker gets the misses by name (the person sees only what passed).
            if shown["status"] == "held-for-review" {
                answers.remove(step);
                std::fs::write(format!("{run}/answers.json"), serde_json::to_vec_pretty(&answers).unwrap()).unwrap();
                answered_by.remove(step);
                std::fs::write(format!("{run}/answered_by.json"), serde_json::to_vec_pretty(&answered_by).unwrap()).unwrap();
                answered_at.remove(step);
                std::fs::write(format!("{run}/answered_at.json"), serde_json::to_vec_pretty(&answered_at).unwrap()).unwrap();
                let again = go(run, true).await;
                eprintln!("the answer to {step} would end the run before what it made passed review, so it is not kept; the run is {} and {step} waits again. Misses:\n  {}",
                    again["status"], shown["review_misses"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("\n  "));
                std::process::exit(2);
            }
            if let Some(refusal) = shown["failed"].as_array().and_then(|f| f.iter().find(|f| f["step"] == step.as_str())).cloned() {
                // A refused answer is not kept, and the run is run again without it, so the step waits again for an answer
                // that fits and the run is never left failed by a refusal.
                answers.remove(step);
                std::fs::write(format!("{run}/answers.json"), serde_json::to_vec_pretty(&answers).unwrap()).unwrap();
                let again = go(run, true).await;
                eprintln!("the answer to {step} was refused and not kept; the run is {} and {step} waits again: {}", again["status"], refusal["error"]);
                std::process::exit(2);
            }
            if let Some(kept) = answers.get(step) { finish_told_task(run, step, kept); }
            println!("{}", serde_json::to_string_pretty(&shown).unwrap());
            // A run that completes keeps the path its work took, once.
            if shown["status"] == "completed" && read(&format!("{run}/recorded.json")).is_null() {
                match record(run).and_then(|path| keep_path(&path)) {
                    Ok(kept) => { std::fs::write(format!("{run}/recorded.json"), serde_json::to_vec(&json!({ "at": now_utc(), "kept": kept })).unwrap()).ok(); eprintln!("the path this run took is kept in recorded_paths: {kept}"); }
                    Err(e) => eprintln!("the path this run took is not kept yet ({e}); wf record {run} --keep keeps it"),
                }
            }
        }
        Some("audit") => {
            let hours = a.iter().position(|x| x == "--hours").and_then(|i| a.get(i + 1)).and_then(|h| h.parse().ok()).unwrap_or(24);
            let jobs = match audit(hours) { Ok(j) => j, Err(e) => { eprintln!("{e}"); std::process::exit(1); } };
            let by_hand = jobs.iter().filter(|j| j["in_run"] == false).count();
            let unchecked_questions: Vec<Value> = jobs.iter().filter(|j| j["asked_him"].as_u64().unwrap_or(0) > 0 && j["checked_first"] == false)
                .map(|j| json!({ "chat": j["chat"], "session": j["session"], "ask_at": j["ask_at"], "cards": j["asked_him"] })).collect();
            if a.iter().any(|x| x == "--keep") {
                let text = Value::Array(jobs.clone()).to_string();
                let sql = "insert into jobs_seen (session, chat, ask_at, came_from, ask, calls, in_run, asked_him, checked_first) select j->>'session', j->>'chat', (j->>'ask_at')::timestamptz, j->>'from', j->>'ask', (j->>'calls')::int, (j->>'in_run')::boolean, (j->>'asked_him')::int, (j->>'checked_first')::boolean from jsonb_array_elements($1::jsonb) j on conflict (session, ask_at) do update set calls = excluded.calls, in_run = excluded.in_run, asked_him = excluded.asked_him, checked_first = excluded.checked_first returning 1";
                match sql_rows(&setting("runs_database"), &sql, json!([text])) { Ok(rows) => eprintln!("kept {} jobs in jobs_seen", rows.len()), Err(e) => { eprintln!("not kept: {e}"); std::process::exit(1); } }
            }
            println!("{}", serde_json::to_string_pretty(&json!({ "hours": hours, "jobs": jobs.len(), "by_hand": by_hand, "in_a_run": jobs.len() - by_hand, "questions_put_to_him_unchecked": unchecked_questions,
                "chats": jobs.iter().fold(BTreeMap::<String, (u64, u64)>::new(), |mut m, j| { let e = m.entry(format!("{} {}", j["chat"].as_str().unwrap_or(""), j["session"].as_str().unwrap_or("").chars().take(8).collect::<String>())).or_default(); if j["in_run"] == true { e.0 += 1 } else { e.1 += 1 }; m })
                    .into_iter().map(|(k, (inside, hand))| json!({ "chat": k, "in_a_run": inside, "by_hand": hand })).collect::<Vec<_>>() })).unwrap());
        }
        Some("record") if a.len() > 2 => {
            let run = run_of(&a[2]);
            let path = match record(&run) { Ok(p) => p, Err(e) => { eprintln!("{e}"); std::process::exit(1); } };
            if a.iter().any(|x| x == "--keep") {
                match keep_path(&path) {
                    Ok(kept) => { std::fs::write(format!("{run}/recorded.json"), serde_json::to_vec(&json!({ "at": now_utc(), "kept": kept })).unwrap()).ok(); println!("{kept}"); }
                    Err(e) => { eprintln!("not kept: {e}"); std::process::exit(1); }
                }
            } else { println!("{}", serde_json::to_string_pretty(&path).unwrap()); }
        }
        Some("show") if a.len() > 2 => { go(&run_of(&a[2]), true).await; }
        Some("cancel") if a.len() > 2 => {
            let run = run_of(&a[2]);
            let owner = read(&format!("{run}/started_by.json")).as_str().unwrap_or_default().to_string();
            if !owner.is_empty() && !actor().is_empty() && owner != actor() { eprintln!("run {run} was started by {owner}, not by this chat"); std::process::exit(1); }
            std::fs::write(format!("{run}/cancelled.json"), serde_json::to_vec(&json!({ "at": now_utc(), "by": actor() })).unwrap()).unwrap();
            keep_pick(json!({ "command": "cancel", "run": run, "by": actor() }));
            // The run's row says cancelled too, so a landing or another computer never reads it as still paused (Nov 21 2026).
            let id = read(&format!("{run}/definition.json"))["id"].as_str().unwrap_or_default().to_string();
            let started = read(&format!("{run}/started_at.json")).as_str().unwrap_or_default().to_string();
            keep_run_row(&run, &id, &started, &json!({ "status": "cancelled" }));
            println!("{}", serde_json::to_string_pretty(&json!({ "run": run, "status": "cancelled" })).unwrap());
        }
        _ => eprintln!("wf find WORDS [--kinds K1,K2] | wf kinds [WORDS] | wf start WORKFLOW_ID [INPUT_JSON|-|@FILE] | wf answer RUN STEP ANSWER_JSON|-|@FILE | wf show RUN | wf cancel RUN | wf record RUN [--keep]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workflow_the_words_name_scores_and_the_others_do_not() {
        let index = vec![
            json!({ "id": "workflow:send-a-tour", "label": "Send a tour", "job": "Show a student the tour", "words": "tour student" }),
            json!({ "id": "workflow:file-taxes", "label": "File taxes", "job": "Prepare the return", "words": "tax form" }),
        ];
        let scores = word_scores(&index, &words_of("tour student"));
        assert!(scores["workflow:send-a-tour"] > 0.0);
        assert!(!scores.contains_key("workflow:file-taxes"));
    }

    #[test]
    fn a_home_relative_path_is_expanded_and_an_absolute_one_is_kept() {
        assert_eq!(expand("~/x/y"), format!("{}/x/y", home()));
        assert_eq!(expand("/abs/z"), "/abs/z");
    }
}

#[cfg(test)]
mod json_arg_tests {
    use super::json_text;

    #[test]
    fn a_dash_reads_standard_input_and_nothing_else() {
        assert_eq!(json_text("-", || Ok("{\"a\":1}".into())).unwrap(), "{\"a\":1}");
        assert!(json_text("-", || Err(std::io::Error::other("closed"))).is_err());
    }

    #[test]
    fn an_at_path_reads_that_file_and_a_missing_one_is_refused() {
        let path = std::env::temp_dir().join(format!("wf-json-arg-{}.json", std::process::id()));
        std::fs::write(&path, "{\"name\":\"x\"}").unwrap();
        let given = format!("@{}", path.display());
        assert_eq!(json_text(&given, || panic!("stdin is not read for @FILE")).unwrap(), "{\"name\":\"x\"}");
        std::fs::remove_file(&path).unwrap();
        let gone = format!("@{}", path.display());
        assert!(json_text(&gone, || panic!("stdin is not read for @FILE")).unwrap_err().contains("could not read the JSON from"));
    }

    #[test]
    fn a_plain_argument_is_passed_as_given_and_non_json_is_left_for_the_parser_to_refuse() {
        let text = json_text("not json", || panic!("stdin is not read for a plain argument")).unwrap();
        assert_eq!(text, "not json");
        assert!(serde_json::from_str::<serde_json::Value>(&text).is_err());
    }
}
