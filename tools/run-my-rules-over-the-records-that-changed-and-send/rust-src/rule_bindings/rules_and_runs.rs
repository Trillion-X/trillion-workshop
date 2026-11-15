// src/rule_bindings/rules_and_runs.rs
//
// Purpose: A list's formula fields, the account's rules and its workflow runs, as calls the record store makes: the
// formula evaluator (crates/evaluate-over-rows), the trigger rules (Cargo `trigger-rules`) and the workflow runner
// (Cargo `workflow-runs`), each reached the way Trillion reached it (the commit that added this file names the old
// lines):
//   - `derived_values`: a list field whose kind carries a formula (`derive`) worked out from the row's own values, as
//     Trillion's list page did, now on the record store's own read.
//   - `rules_over_records`: rules and the records that changed in, every send the rules made out, with no host.
//   - `run_workflow_definition`: a definition, its input and the answers known so far in, the run out, with no host.
//   - `run_id`, `send_key`, `rule_run_id`: the ids Trillion gave a workflow run, a rule's send and a rule's own write;
//     `send_id` the id of a rule's send to a tool, kept for the wake runner.
//
// Non-Negotiable Invariants:
// - The crates are unchanged and reach nothing themselves: every read a rule makes is answered from the changes and
//   records given, and every send is answered as handed to the caller, who decides what it starts. A workflow ask is
//   answered from `answers` by its step id or name; an ask with no answer pauses the run there and is listed in
//   `waiting`, and a read is refused with the reason, so the caller runs the same definition again with more answers.
// - An ask named the DATA `write_ask` is a step whose effect is a write of the account's own records (Trillion's
//   run_tool step: a tool's effect is a records write). It is never answered from `answers` and never applied here:
//   its input's `records` are listed in the run's `step_writes` (each `{step_id, records}`) and the ask is answered
//   `{planned: <count>}` so the run goes on; the caller applies them once the run passes.
// - The word the workflow runner names its wire ids after is the host's own word (`identity::word`), never written
//   here.
// - No list, rule, record kind or step is named in code: limits are DATA (`rules_and_runs/settings.json`), words are
//   `rules_and_runs/words.json`, and the kinds the rules and runs read and write (`Kinds`) and a field's kind are read
//   from the account's installed tools' record model (its `kinds_section` and `field_kinds`, record_model_policy
//   `installed`). With no installed tool declaring the kinds, no rule runs.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use crate::refusal_cause::CodedError;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

/// The declared product DATA files this owner is read from.
const SETTINGS: &[u8] = include_bytes!("rules_and_runs/settings.json");
const WORDS: &[u8] = include_bytes!("rules_and_runs/words.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    pub list_kind: String,
    pub row_kind_prefix: String,
    pub row_type_field: String,
    pub fields_field: String,
    pub most_lists: usize,
    /// The section of the account's installed record model that names the kinds these rules and runs read and write
    /// (`Kinds`).
    pub kinds_section: String,
    pub rule_partition: String,
    pub workflow_partition: String,
    pub run_id_prefix: String,
    pub recipe_definition_field: String,
    pub rule_run_prefix: String,
    pub most_rules: usize,
    pub run_id_hex: usize,
    pub rule_run_hex: usize,
    pub write_ask: String,
    pub most_step_writes: usize,
    pub most_rule_rounds: usize,
    pub send_prefix: String,
    pub shipped_rules: ShippedRules,
    pub shipped_recipes: ShippedRecipes,
    pub recipe_steps: RecipeSteps,
    pub agent_ask: AgentAsk,
}

/// How an ask answered by an AI is handed over and read back (settings `agent_ask`): an ask whose name starts with
/// `ask_prefix` becomes one job record of `job_kind` (id `id_prefix` and the hex of the handoff key) that any AI, or the
/// one in the ask's `to_field`, takes and finishes; the finished job's `result_field` is the ask's answer.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentAsk {
    pub ask_prefix: String,
    pub job_kind: String,
    pub id_prefix: String,
    pub status_field: String,
    pub waiting: String,
    pub done: Vec<String>,
    pub failed: Vec<String>,
    pub job_field: String,
    pub label_field: String,
    pub to_field: String,
    pub from_field: String,
    pub from_value: String,
    pub priority_field: String,
    pub sent_at_field: String,
    pub run_field: String,
    pub step_field: String,
    pub result_field: String,
    pub error_field: String,
    pub job_input_field: String,
    pub said_input_field: String,
    pub to_input_field: String,
    pub once_per_input_field: String,
    pub priority_input_field: String,
    pub details_input_fields: Vec<String>,
}

/// Where the recipes that ship with the deploy are read (settings `shipped_recipes`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShippedRecipes {
    pub dir: String,
    pub rows: String,
    pub payload_field: String,
    pub id_field: String,
    pub max_bytes: u64,
}

/// The rows a recipe's steps are kept as beside a recipe row whose definition is empty (settings `recipe_steps`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeSteps {
    pub kind: String,
    pub recipe_field: String,
    pub order_field: String,
    pub id_field: String,
    pub text_fields: Vec<String>,
    /// What joins a recipe's name and a step's in a step row's id.
    pub id_separator: String,
    /// The most step rows one recipe is read with.
    pub most_steps: usize,
}

/// Where the rules that ship with the deploy are read (settings `shipped_rules`).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShippedRules {
    pub file: String,
    pub rows: String,
    pub id_field: String,
    pub schedule_id_field: String,
    pub change_field: String,
    pub max_bytes: u64,
}

/// The record kinds the rules and runs read and write, as the tool that keeps the rules declares them in the
/// account's installed record model (settings `kinds_section`): never named here.
#[derive(Clone, Debug, Deserialize)]
pub struct Kinds {
    /// The kind of a rule row; its id is this kind, a colon and the rule's id.
    pub rule: String,
    /// The kind a row the trigger engine writes about its own sends is kept as when it names none.
    pub outcome: String,
    /// The kind of a workflow run's row.
    pub run: String,
    /// The kind of the row holding a workflow's definition.
    pub recipe: String,
    /// The kind of the row a rule's send to a tool is kept as, for the wake runner.
    pub send: String,
    /// Every kind these rules and runs write: a write of one is never handed to the rules as a change.
    pub own: Vec<String>,
}

impl Kinds {
    /// The kinds the account's installed tools declare, or None when no installed tool keeps rules: then no rule
    /// runs. A section that is there but does not read as these kinds is a refusal, never None.
    pub fn of(model: &crate::record_model_policy::Installed) -> Result<Option<Self>, CodedError> {
        let settings = settings()?;
        match model.json().get(&settings.kinds_section) {
            None => Ok(None),
            Some(section) => serde_json::from_value(section.clone()).map(Some).map_err(|error| CodedError::new(error.to_string())),
        }
    }

    /// Whether a write of `kind` is one these rules and runs make themselves.
    pub fn own(&self, kind: &str) -> bool {
        self.own.iter().any(|known| known == kind)
    }
}

/// This owner's DATA, read once.
pub fn settings() -> Result<&'static Settings, CodedError> {
    static ONCE: OnceLock<Result<Settings, CodedError>> = OnceLock::new();
    ONCE.get_or_init(|| serde_json::from_slice(SETTINGS).map_err(|error| CodedError::new(error.to_string()))).as_ref().map_err(Clone::clone)
}

/// One of this owner's words, its `{name}` holes filled.
pub fn say(key: &str, holes: &[(&str, &str)]) -> String {
    static ONCE: OnceLock<Map<String, Value>> = OnceLock::new();
    let words = ONCE.get_or_init(|| serde_json::from_slice(WORDS).unwrap_or_default());
    let mut text = words.get(key).and_then(Value::as_str).unwrap_or(key).to_string();
    for (name, value) in holes {
        text = text.replace(&format!("{{{name}}}"), value);
    }
    text
}

// ---- formula ----

/// The list rule's field kinds the account's installed tools declare (their joined model's `field_kinds`, from
/// tools/export-records-as-list-rows): which kinds are computed and what a computed kind carries.
pub fn field_kinds(model: &crate::record_model_policy::Installed) -> Vec<Value> {
    model.json().get("field_kinds").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// One computed value: the formula evaluator works out `binding` over `context`, as Trillion's list page asked it.
pub fn evaluate_formula(binding: &Value, context: &Value) -> Result<Value, CodedError> {
    if binding.is_null() {
        return Err(CodedError::new(say("no_formula", &[])));
    }
    super::evaluator::evaluate_request(super::evaluator::EvaluateRequest {
        binding: binding.clone(),
        input: context.clone(),
    }).map_err(|error| CodedError::new(error))
}

/// The values of every computed field of one row, by field id. `fields` are the list's fields (`{id, kind, ...}`),
/// `kinds` the lists DATA `field_kinds`, `row` the row's record value. A field is computed when its kind's row says its
/// value is `computed` and carries `carries.key` (a formula's `derive`): its carried object (the kind row's defaults
/// under the field's own) names the target, the request whose `binding` is the formula, `context_from_fields` (every
/// kept field when left out: those whose value is not computed) and `result_path`. Only the target the kind row's
/// defaults name is answered here (the formula evaluator); a field naming another target, or whose formula fails, reads as
/// null, as one did on Trillion's page (deriveValues: "one that failed reads as empty").
pub fn derived_values(fields: &[Value], kinds: &[Value], row: &Value) -> Map<String, Value> {
    let kind_row = |kind: &Value| kinds.iter().find(|candidate| candidate.get("id") == Some(kind));
    let computed = |field: &Value| {
        kind_row(&field["kind"]).filter(|row| row.get("value").and_then(Value::as_str) == Some("computed"))
    };
    let kept: Vec<&str> = fields.iter().filter(|field| computed(field).is_none()).filter_map(|field| field["id"].as_str()).collect();
    let mut out = Map::new();
    for field in fields {
        let (Some(id), Some(kind)) = (field["id"].as_str(), computed(field)) else { continue };
        let Some(key) = kind["carries"]["key"].as_str() else { continue };
        let defaults = kind["carries"]["defaults"].as_object().cloned().unwrap_or_default();
        let mut carried = defaults.clone();
        if let Some(own) = field.get(key).and_then(Value::as_object) {
            carried.extend(own.clone());
        }
        let answered_here = defaults.get("target").is_some_and(|target| carried.get("target") == Some(target));
        let value = answered_here.then(|| {
            let named: Vec<&str> = match carried.get("context_from_fields").and_then(Value::as_array) {
                Some(named) => named.iter().filter_map(Value::as_str).collect(),
                None => kept.clone(),
            };
            let context: Map<String, Value> = named.iter().map(|name| ((*name).to_string(), row.get(*name).cloned().unwrap_or(Value::Null))).collect();
            let answer = json!({ "value": evaluate_formula(&carried.get("request").map_or(Value::Null, |request| request["binding"].clone()), &Value::Object(context)).ok()? });
            let path = carried.get("result_path").and_then(Value::as_array);
            Some(match path {
                Some(path) => path.iter().try_fold(&answer, |at, part| part.as_str().and_then(|part| at.get(part))).cloned().unwrap_or(Value::Null),
                None => answer,
            })
        });
        out.insert(id.to_string(), value.flatten().unwrap_or(Value::Null));
    }
    out
}

// Dependency callback traits require String errors. Keep their original code
// and a source-only transport marker across that ABI, then restore the code
// unchanged. The marker binds the exact callback failure, including when two
// different conditions report the same code.
// Only error fields are decorated on the returned value; no private field or
// dependency message is used to construct or log a source identity.
#[derive(Default)]
struct CallbackFailures(Mutex<Vec<CodedError>>);
impl CallbackFailures {
    fn marker(error: &CodedError) -> String { format!(" [trillion-refusal-cause:{}]", error.cause().id()) }
    fn capture(&self, error: CodedError) -> String {
        let wire = format!("{}{}", error.code, Self::marker(&error));
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(error);
        wire
    }
    fn take(&self, wire: &str) -> Option<CodedError> {
        let mut errors = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let at = errors.iter().position(|error| wire.contains(&Self::marker(error)))?;
        let error = errors.remove(at);
        let code = wire.replace(&Self::marker(&error), "");
        Some(CodedError::with_cause(code, error.cause()))
    }
    fn attach(&self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                let error = ["error", "reason", "failure"].iter().find_map(|key| fields.get(*key).and_then(Value::as_str).map(|code| (*key, code)));
                if let Some((key, error)) = error.and_then(|(key, code)| self.take(code).map(|error| (key, error))) {
                    fields.insert("cause".into(), json!(error.cause().id()));
                    fields.insert(key.into(), json!(error.code));
                }
                for child in fields.values_mut() { self.attach(child); }
            }
            Value::Array(items) => for item in items { self.attach(item); },
            _ => {},
        }
    }
}

// ---- trigger ----

/// What the rules did with one batch of changes (Trillion rules-over-records.mjs's answer): every send the rules made
/// (`fires`, each `{target, payload, later}`), the rules' own records to keep (`writes`, each `{address, payload}`),
/// and its dispatch failures.
pub struct Fired {
    pub fires: Vec<Value>,
    pub writes: Vec<Value>,
    pub dispatch_failures: Vec<Value>,
}

/// Rules and the records that changed in, every send the rules made out. `rules` are `(id, rule)`, each the trigger
/// trigger rule as the crate reads it; `changes` are `{address, path?, value}` or `{address, removed: true}`; `records` are other
/// records a rule may read. One rule set is built for the call and handed every rule first (a rule never fires for a
/// record it had not seen), then the changes; nothing is kept between calls (rules-over-records.mjs invariant 1).
/// Without a host, nothing is sent anywhere: each send is answered as handed to the caller, a read from the changes
/// and records given, a list from those same records (invariant 2). `rule_kind` is the kind the rules are kept as
/// (`Kinds::rule`): each rule is addressed `<rule_kind>:<id>`, at the path the engine reads a rule at (its own word,
/// `trigger_rules::RULE_PATH`).
pub fn rules_over_records(partition: &str, rule_kind: &str, rules: &[(String, Value)], changes: &[Value], records: &[Value]) -> Result<Fired, CodedError> {
    let rules: Vec<Value> = rules
        .iter()
        .map(|(id, rule)| json!({ "address": format!("{rule_kind}:{id}"), "path": [trigger_rules::RULE_PATH], "value": rule }))
        .collect();
    let mut known = BTreeMap::<String, Value>::new();
    for item in records.iter().chain(changes.iter().filter(|change| change.get("removed") != Some(&Value::Bool(true)))) {
        if let Some(address) = item["address"].as_str() {
            known.insert(address.to_string(), item.clone());
        }
    }
    let fires = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sent = fires.clone();
    let callback_failures = Arc::new(CallbackFailures::default());
    let callback_source = callback_failures.clone();
    let answer = move |request: &Value| -> Result<Value, String> {
        let answer = (|| -> Result<Value, CodedError> {
        match request["kind"].as_str() {
            Some("send") => {
                sent.lock().map_err(|error| CodedError::new(error.to_string()))?.push(json!({
                    "target": request["target"], "payload": request["payload"], "later": request["later"] == Value::Bool(true),
                }));
                Ok(json!({ "handed_to_caller": true }))
            }
            Some("read") => Ok(request["address"].as_str().and_then(|address| known.get(address)).map_or(Value::Null, |item| item["value"].clone())),
            Some("list") => {
                let addresses: Vec<&str> = request["addresses"].as_array().map(|all| all.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                let entries: Vec<&Value> = known.values().filter(|item| addresses.is_empty() || item["address"].as_str().is_some_and(|address| addresses.contains(&address))).collect();
                let start = request["cursor"].as_u64().unwrap_or(0) as usize;
                let limit = request["limit"].as_u64().unwrap_or(100).max(1) as usize;
                let page: Vec<Value> = entries.iter().skip(start).take(limit)
                    .map(|item| json!({ "address": item["address"], "path": item.get("path").cloned().unwrap_or_else(|| json!([])), "value": item["value"] }))
                    .collect();
                Ok(json!({ "entries": page, "next_cursor": if start + limit < entries.len() { json!(start + limit) } else { Value::Null } }))
            }
            other => Err(CodedError::new(say("unanswered_request", &[("kind", other.unwrap_or(""))]))),
        }
        })();
        answer.map_err(|error| callback_source.capture(error))
    };
    let rule_set = trigger_rules::TriggerEngine::new(partition, Box::new(answer));
    let mut results = Vec::new();
    if !rules.is_empty() {
        results.push(rule_set.apply(&Value::Array(rules)).map_err(|error| callback_failures.take(&error).unwrap_or_else(|| CodedError::new(error)))?);
    }
    if !changes.is_empty() {
        results.push(rule_set.apply(&Value::Array(changes.to_vec())).map_err(|error| callback_failures.take(&error).unwrap_or_else(|| CodedError::new(error)))?);
    }
    let all = |name: &str| results.iter().flat_map(|result| result[name].as_array().cloned().unwrap_or_default()).collect::<Vec<_>>();
    let fires = fires.lock().map_err(|error| CodedError::new(error.to_string()))?.clone();
    let mut dispatch_failures = all("dispatch_failures");
    for failure in &mut dispatch_failures { callback_failures.attach(failure); }
    Ok(Fired { fires, writes: all("writes"), dispatch_failures })
}

// ---- workflow ----

/// The asks' answers by step id or ask name, and the asks still waiting (workflow-definition-runner.mjs, no host).
struct Answers {
    failures: CallbackFailures,
    known: Map<String, Value>,
    waiting: Mutex<Vec<Value>>,
    /// The ask name whose effect is a write of the account's own records (DATA `write_ask`), and what those asks
    /// asked to write, in the order the run asked.
    write_ask: String,
    writes: Mutex<Vec<Value>>,
}

/// The id an ask is answered under (as Trillion's workflow runner chose it): its whole identity when nested,
/// else its step id, else the identity's last part, else the ask's name.
fn answer_identity(context: &Value, name: &str) -> String {
    let identity = context.get("_runtime_identity").and_then(Value::as_array);
    match identity {
        Some(identity) if identity.len() > 1 => Value::Array(identity.clone()).to_string(),
        _ => context["step_id"].as_str().map(str::to_string)
            .or_else(|| identity.and_then(|identity| identity.last()).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| name.to_string()),
    }
}

fn value_of(bytes: Option<&[u8]>) -> Value {
    bytes.and_then(|bytes| serde_json::from_slice(bytes).ok()).unwrap_or_else(|| json!({}))
}

impl Answers {
    fn answer(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, CodedError> {
        let context = value_of(context.as_deref());
        let step = answer_identity(&context, name);
        if name == self.write_ask {
            let input = value_of(Some(&payload));
            let records = input.get("records").cloned().unwrap_or_else(|| json!([]));
            let count = records.as_array().map_or(0, Vec::len);
            self.writes.lock().map_err(|error| CodedError::new(error.to_string()))?.push(json!({ "step_id": step, "records": records }));
            return serde_json::to_vec(&json!({ "planned": count })).map_err(|error| CodedError::new(error.to_string()));
        }
        let known = self.known.get(&step).or_else(|| self.known.get(name));
        if let Some(known) = known {
            return serde_json::to_vec(known).map_err(|error| CodedError::new(error.to_string()));
        }
        self.waiting.lock().map_err(|error| CodedError::new(error.to_string()))?.push(json!({ "step_id": step, "asks": name, "input": value_of(Some(&payload)) }));
        serde_json::to_vec(&json!({ "$kind": "not-answered-yet", "step_id": step })).map_err(|error| CodedError::new(error.to_string()))
    }
}
#[async_trait::async_trait]
impl workflow_runs::Host for Answers {
    async fn ask(&self, name: &str, payload: Vec<u8>, context: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        self.answer(name, payload, context).map_err(|error| self.failures.capture(error))
    }
    async fn read(&self, from: &str) -> Result<Vec<u8>, String> {
        Err(self.failures.capture(CodedError::new(say("unanswered_read", &[("from", from)]))))
    }
}

/// A definition, its input and the answers known so far in, the run out (`{status, execution_context, ..., waiting,
/// step_writes}`): `step_writes` are the records the run's write asks (DATA `write_ask`) asked to write, not applied.
/// The runner runs the definition from the start on every call; an ask it has an answer for goes on, one without
/// pauses the run there, so calling again with more answers goes on from where it stopped (invariant 1 there).
pub fn run_workflow_definition(definitions: &Value, workflow_id: &str, input: &Value, answers: &Value, partition: &str, started_at: &str) -> Result<Value, CodedError> {
    let definitions: Vec<workflow_core::Definition> = serde_json::from_value(definitions.clone()).map_err(|error| CodedError::new(format!("definitions: {error}")))?;
    let word = crate::account_files::identity::word().map_err(|error| CodedError::with_cause(error.to_string(), error.cause()))?;
    let write_ask = settings()?.write_ask.clone();
    let host = Arc::new(Answers { failures: CallbackFailures::default(), known: answers.as_object().cloned().unwrap_or_default(), waiting: Mutex::new(Vec::new()), write_ask, writes: Mutex::new(Vec::new()) });
    let mut run = futures::executor::block_on(workflow_runs::run_definition_with_started_at(
        definitions, workflow_id, input.clone(), partition, word, started_at, host.clone(),
    )).map_err(|error| host.failures.take(&error).unwrap_or_else(|| CodedError::new(error)))?;
    host.failures.attach(&mut run);
    run["waiting"] = Value::Array(host.waiting.lock().map_err(|error| CodedError::new(error.to_string()))?.clone());
    run["step_writes"] = Value::Array(host.writes.lock().map_err(|error| CodedError::new(error.to_string()))?.clone());
    Ok(run)
}

// ---- ids ----

/// BLAKE3 hex of `text`'s bytes.
fn blake3_hex(text: &str) -> String {
    content_crypto::advanced::blake3::hash(text.as_bytes()).to_hex().to_string()
}

/// A workflow run's id: one run per (workflow, request key), the same key naming the run already started (Trillion
/// workflows.mjs start: `run:${identityOf({ workflow_id, request_key }).slice(3, 27)}`, identityOf the BLAKE3 of the
/// canonical JSON with its keys sorted).
pub fn run_id(workflow_id: &str, request_key: &str) -> Result<String, CodedError> {
    let settings = settings()?;
    let canonical = serde_json::to_string(&BTreeMap::from([("request_key", request_key), ("workflow_id", workflow_id)])).map_err(|error| CodedError::new(error.to_string()))?;
    Ok(format!("{}{}", settings.run_id_prefix, &blake3_hex(&canonical)[..settings.run_id_hex]))
}

/// The id of the job record an ask answered by an AI is handed over as: one per handoff key (the item's `once_per`, or
/// the run and step), so however many runs hand one item it is one job.
pub fn handoff_id(key: &str) -> Result<String, CodedError> {
    let settings = settings()?;
    let canonical = serde_json::to_string(&BTreeMap::from([("handoff_key", key)])).map_err(|error| CodedError::new(error.to_string()))?;
    Ok(format!("{}{}", settings.agent_ask.id_prefix, &blake3_hex(&canonical)[..settings.run_id_hex]))
}

/// The id of the row a rule's send to `tool_id` is kept as for the wake runner: one per (tool, request key), the same
/// identity as a run's (`run_id`) under the DATA `send_prefix`.
pub fn send_id(tool_id: &str, request_key: &str) -> Result<String, CodedError> {
    let settings = settings()?;
    let canonical = serde_json::to_string(&BTreeMap::from([("request_key", request_key), ("tool_id", tool_id)])).map_err(|error| CodedError::new(error.to_string()))?;
    Ok(format!("{}{}", settings.send_prefix, &blake3_hex(&canonical)[..settings.run_id_hex]))
}

/// The request key a rule's send runs under (automations.mjs sendKey): its rule, its record and its content.
pub fn send_key(payload: &Value) -> String {
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        Value::Null => "undefined".to_string(),
        other => other.to_string(),
    };
    format!("rule:{}:{}:{}", text(&payload["rule_id"]), text(&payload["record_id"]), text(&payload["content"]))
}

/// The id of one record the trigger rules wrote about their own sends (automations.mjs keep):
/// `rule-run:<at>:<shortHash(address)>`.
pub fn rule_run_id(at: &str, address: &str) -> Result<String, CodedError> {
    let settings = settings()?;
    Ok(format!("{}{at}:{}", settings.rule_run_prefix, &blake3_hex(address)[..settings.rule_run_hex]))
}

pub mod shipped_recipes;
pub mod shipped_rules;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod refusal_cause_tests {
    use super::*;
    use workflow_runs::Host;

    fn host() -> Answers {
        Answers {
            failures: CallbackFailures::default(), known: Map::new(),
            waiting: Mutex::new(Vec::new()), write_ask: "write".into(), writes: Mutex::new(Vec::new()),
        }
    }
    fn poison<T>(lock: &Mutex<T>) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = lock.lock().unwrap();
            panic!("synthetic callback lock failure");
        }));
    }

    #[test]
    fn callback_string_abi_keeps_identical_public_codes_bound_to_their_own_sources() {
        let writes = host();
        let waiting = host();
        poison(&writes.writes);
        poison(&waiting.waiting);
        let write_code = futures::executor::block_on(writes.ask("write", b"{}".to_vec(), None)).unwrap_err();
        let wait_code = futures::executor::block_on(waiting.ask("unknown", b"{}".to_vec(), None)).unwrap_err();
        let write = writes.failures.take(&write_code).unwrap();
        let wait = waiting.failures.take(&wait_code).unwrap();
        assert_eq!(write.code, wait.code, "the public code is restored unchanged after the dependency ABI");
        assert_ne!(write.cause(), wait.cause());
        let source = include_str!("rules_and_runs.rs");
        let line = |text: &str| (source.lines().position(|line| line.contains(text)).unwrap() + 1) as u32;
        assert_eq!(write.cause().line(), line("self.writes.lock().map_err"));
        assert_eq!(wait.cause().line(), line("self.waiting.lock().map_err"));
        let original = write.cause();
        let public_code = write.code.clone();
        let code = writes.failures.capture(write);
        let mut result = json!({"error": code});
        writes.failures.attach(&mut result);
        assert_eq!(result["error"], public_code);
        assert_eq!(result["cause"], original.id());
    }
}
