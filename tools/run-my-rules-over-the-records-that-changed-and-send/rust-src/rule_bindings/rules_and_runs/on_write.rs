//! The account's rules and workflow runs, run where every records:write passes (`write_records`), on the same held
//! transaction, after the write itself. Ported one to one from Trillion's automations and workflows (the commit that
//! added this file names the old lines):
//! - Each record the write changed, except the kinds these rules and runs write themselves (Trillion reset its rule
//!   cache on a rule write and kept its rule runs unwatched), is handed with every rule row (`trigger-rule`, the
//!   trigger rule as the crate reads it) to the trigger rules; a send whose payload names `then.workflow_id` starts
//!   that workflow under the send's key (`rule:<rule>:<record>:<content>`), and what the rules wrote about their
//!   sends is kept as `rule-run:<at>:<hash>` rows of the kind each names (`trigger-dispatch-outcome`).
//! - One run per (workflow, request key), id `run:<identity>`, kept as the row `workflow-run:<run id>`; the runner runs
//!   the workflow's definition (the `workflow-recipe:<id>` row's `definition`) with the answers the run holds. A person
//!   starts or goes on with a run by writing its row (`workflow_id`, `input`, `answers`): it is run again unless it is
//!   finished.
//!
//! - A step whose effect is a write of the account's own records (an ask named the DATA `write_ask`: Trillion's
//!   run_tool step, workflows.mjs answerFromTool, whose tool's effect was a records write) is applied on this same held
//!   transaction once its run passes (`apply_step_writes`): each record is read here, the step's `set`/`add`/`remove`
//!   applied to what was read, and the result written over that read (compare-and-set on the version it read), at
//!   most `most_step_writes` records per run. A write that changes nothing is not written. A refused write (a type
//!   other than the record holds, a rules-and-runs row, an `expected` the record no longer is, or one the records
//!   write itself refuses) writes nothing of the run and leaves the run `failed` with its reason.
//! - A rule's send to a tool (`then.tool_id`, not `later`) is kept as a `send_kind` row (`send_prefix` + its identity,
//!   once per tool and send key) for the wake runner (src/wake.rs `sends`), which runs the tool for each tool row that
//!   listens for those sends and the person switched on.
//!
//! What was dropped, and why: Trillion's runs were also answered by its AI, agents and tools; here an ask is answered
//! only from the run's `answers`, and one without an answer leaves the run `working` at that step with the ask in
//! `waiting`, for a person or a tool to answer by writing the run again. Sends a rule makes to anything but a
//! workflow or a tool, and `later` sends, are kept in the rule-run rows as handed to the caller, not run. A step's
//! records write is handed to the rules again (Trillion's run_tool step wrote through the same store write its
//! automations watched), at most `most_rule_rounds` rounds per records write: Trillion bounded a chain only by its
//! send keys, and a bound with no end is an always-on loop on one write. History brought in from elsewhere is not told apart here.
//!
//! Nothing here names a rule, a workflow, a list or a field: limits are `rules_and_runs` DATA and the kinds are the
//! installed tools' (`runs::Kinds`).
use super::*;
use crate::refusal_cause::Caused as _;
use crate::refusal_cause::CodedError;
use crate::record_value;
use super::original_mutations::{Record, Write};
use crate::rule_bindings::rules_and_runs as runs;
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

fn to_json(value: &Value) -> Result<Json> {
    serde_json::from_str(&encode(value)?).map_err(|error| Error::Source(error.cause()))
}
fn from_json(value: &Json) -> Result<Value> {
    parse(&serde_json::to_string(value).map_err(|error| Error::Source(error.cause()))?)
}
fn text(value: &JsString) -> Result<String> {
    value.to_rust_string().map_err(|error| crate::carry_cause!(Error::Invalid, error))
}
fn logical(values: &mut impl record_value::Supply, id: &str, policy: &record_value::OpenPolicy) -> Result<Option<Record>> {
    record_value::read(id, values, policy, Default::default()).map_err(|error| Error::Source(error.cause())).map(|row| row.map(|row| Record { kind: Some(row.record_type().into()), identity: row.sequence().into(), value: row.into_value() }))
}

impl<'db, 's, 'c> NativeTransaction<'db, 's, 'c> {
    fn current_json(&mut self, id: &str, policy: &record_value::OpenPolicy) -> Result<Option<(String, Json)>> {
        match self.with_current_values(|values| logical(values, id, policy))? {
            Some(record) => Ok(Some((record.kind.as_ref().map(text).transpose()?.unwrap_or_default(), to_json(&record.value)?))),
            None => Ok(None),
        }
    }

    /// Every rule that is on, by id after the rule kind's prefix (Trillion `ruleIds`/`views`): the account's own rule rows and
    /// the rules the deploy ships that it holds no row of, at most `most_rules`.
    fn rule_rows(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy) -> Result<Vec<(String, Json)>> {
        let mut ids = Vec::new();
        let mut after = None::<String>;
        loop {
            let page = self.state.external.records(self.db)?.ids_of_type(&kinds.rule, after.as_deref(), (settings.most_rules + 1 - ids.len()).min(crate::records::MAX_PAGE_ITEMS)).map_err(|error| Error::Source(error.cause()))?;
            ids.extend(page.ids);
            if ids.len() > settings.most_rules { return Err(crate::cause!(Error::Bounds)) }
            match page.next { Some(next) => after = Some(next), None => break }
        }
        ids.sort();
        let prefix = format!("{}:", kinds.rule);
        let mut rules = Vec::new();
        for id in ids {
            let Some((_, value)) = self.current_json(&id, policy)? else { continue };
            rules.push((id.strip_prefix(&prefix).unwrap_or(&id).to_string(), value));
        }
        // The rules the deploy ships are read beside these, never written (shipped_rules.rs): a row of the account's own
        // with a shipped rule's id is that rule, switched off or on; a rule switched off is not handed to the trigger rules.
        let shipped = runs::shipped_rules::shipped_rules(self.state.owner.state_root());
        if rules.len() + shipped.len() > settings.most_rules { return Err(crate::cause!(Error::Bounds)) }
        Ok(runs::shipped_rules::rules_with_shipped(rules, shipped))
    }

    /// The engine definition of `workflow_id`: the account's own recipe row (its `definition` an object, or JSON text,
    /// or empty beside its step rows, DATA `recipe_steps`), else the recipe the deploy ships (shipped_recipes.rs), never
    /// written. The account's row is the engine's own, named by the workflow id or by what follows its first colon
    /// (`workflow:a-b` is row `a-b`), or a row of the person's list of workflows, the recipe kind after `row_kind_prefix`
    /// (`record:workflow-recipe:a-b`, as trillion-workshop recipe-rows.mjs `recipeFromRows` reads it). None when
    /// neither holds it; Some(Err) with the words when the recipe found cannot be run, so the run says why.
    fn recipe_definition(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy, workflow_id: &str) -> Result<Option<std::result::Result<Json, String>>> {
        let short = workflow_id.split_once(':').map_or(workflow_id, |(_, rest)| rest);
        let steps = &settings.recipe_steps;
        let listed = format!("{}{}", settings.row_kind_prefix, kinds.recipe);
        let mut row = None;
        for id in [format!("{}:{workflow_id}", kinds.recipe), format!("{}:{short}", kinds.recipe), format!("{listed}:{short}")] {
            if let Some((_, value)) = self.current_json(&id, policy)? { row = Some(value); break }
        }
        if let Some(row) = row {
            let field = settings.recipe_definition_field.as_str();
            // A definition held as an object runs as the recipe's definition too (workflows.mjs definitionOf), named by the
            // workflow id, so one written without the engine's own id and name runs.
            let mut rows = Vec::new();
            // The step rows are read only for a row whose definition is empty: each is `<row_kind_prefix><kind>:<name>
            // <id_separator><step>` (recipe-rows.mjs), kept as the step kind or as it after `row_kind_prefix`. Ids are read
            // newest first, so the walk starts just above the ids sharing the prefix and stops at the first id outside
            // them: only this recipe's step rows are read, never the account's every step.
            if runs::shipped_recipes::parsed_field(&row[field]).is_ok_and(|held| held.is_none()) {
                let prefix = format!("{}{}:{short}{}", settings.row_kind_prefix, steps.kind, steps.id_separator);
                let ceiling = format!("{prefix}\u{10FFFF}");
                let named = |held: &Json| held.as_str().is_some_and(|name| name == workflow_id || name == short);
                for kind in [steps.kind.clone(), format!("{}{}", settings.row_kind_prefix, steps.kind)] {
                    let mut before = Some(ceiling.clone());
                    'pages: loop {
                        let page = self.state.external.records(self.db)?.ids_of_type(&kind, before.as_deref(), (steps.most_steps + 1).min(crate::records::MAX_PAGE_ITEMS)).map_err(|error| Error::Source(error.cause()))?;
                        for id in &page.ids {
                            if !id.starts_with(&prefix) { break 'pages }
                            let Some((_, value)) = self.current_json(id, policy)? else { continue };
                            let of = &value[steps.recipe_field.as_str()];
                            if named(of) || of.as_array().is_some_and(|names| names.first().is_some_and(named)) { rows.push(value); }
                            if rows.len() > steps.most_steps { return Ok(Some(Err(runs::say("too_many_steps", &[("most", &steps.most_steps.to_string())])))) }
                        }
                        match page.next { Some(next) => before = Some(next), None => break }
                    }
                }
            }
            return Ok(Some(runs::shipped_recipes::payload_from_rows(workflow_id, &row, &rows, &steps.order_field, &steps.id_field, &steps.text_fields, field).and_then(|payload| runs::shipped_recipes::definition_of(&payload))));
        }
        Ok(runs::shipped_recipes::shipped_recipes(self.state.owner.state_root()).get(workflow_id).map(runs::shipped_recipes::definition_of))
    }

    /// The jobs a run's waiting asks answered by an AI (DATA `agent_ask`) become: each ask not yet handed over is one job
    /// record, waiting, that any AI (or the one it names) takes and finishes; the run keeps the job's id under the step
    /// (`handoffs`) so it is not handed over twice, and goes on when the job finishes (`answer_from_jobs`). An item
    /// that names its `once_per` is one job however many runs hand it (Trillion's `agents.handOff`).
    fn hand_off_asks(&mut self, settings: &runs::Settings, policy: &record_value::OpenPolicy, run: &mut Json, at: &str) -> Result<Vec<(String, String, Json)>> {
        let ask = &settings.agent_ask;
        let mut jobs = Vec::new();
        let waiting = run["waiting"].as_array().cloned().unwrap_or_default();
        for entry in waiting {
            let Some(name) = entry["asks"].as_str().and_then(|name| name.strip_prefix(ask.ask_prefix.as_str())) else { continue };
            let step_id = entry["step_id"].as_str().unwrap_or_default().to_string();
            if run["handoffs"][step_id.as_str()].is_string() { continue }
            let input = &entry["input"];
            let key = input[ask.once_per_input_field.as_str()].as_str().filter(|once| !once.trim().is_empty()).map(str::to_string)
                .unwrap_or_else(|| format!("{}:{step_id}", run["run_id"].as_str().unwrap_or_default()));
            let id = runs::handoff_id(&key).map_err(|error| Error::Source(error.cause()))?;
            if self.current_json(&id, policy)?.is_none() {
                let to = Some(name.trim()).filter(|name| !name.is_empty()).or_else(|| input[ask.to_input_field.as_str()].as_str().filter(|to| !to.trim().is_empty())).map(|to| json!(to.trim()));
                let mut text = input[ask.job_input_field.as_str()].as_str().filter(|text| !text.trim().is_empty()).map(str::to_string)
                    .unwrap_or_else(|| format!("Step {step_id} of {}", run["workflow_id"].as_str().unwrap_or_default()));
                for field in &ask.details_input_fields {
                    if !input[field.as_str()].is_null() { text = format!("{text}\n\n{field}: {}", input[field.as_str()]); }
                }
                let mut job = json!({ ask.job_field.as_str(): text, ask.status_field.as_str(): ask.waiting, ask.to_field.as_str(): to.unwrap_or(Json::Null),
                    ask.from_field.as_str(): ask.from_value, ask.sent_at_field.as_str(): at, ask.run_field.as_str(): run["run_id"], ask.step_field.as_str(): step_id });
                if let Some(said) = input[ask.said_input_field.as_str()].as_str().filter(|said| !said.trim().is_empty()) { job[ask.label_field.as_str()] = json!(said); }
                if let Some(priority) = input[ask.priority_input_field.as_str()].as_i64() { job[ask.priority_field.as_str()] = json!(priority); }
                jobs.push((id.clone(), ask.job_kind.clone(), job));
            }
            if !run["handoffs"].is_object() { run["handoffs"] = json!({}); }
            run["handoffs"][step_id.as_str()] = json!(id);
        }
        Ok(jobs)
    }

    /// A finished job a run waits on answers the run's ask with its result and the run goes on; a job that ended
    /// otherwise fails the run with what it says. `job` is the job record's value; the run's row value, or None when the
    /// job answers no run that is still waiting on it.
    fn answer_from_job(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy, job_id: &str, job: &Json) -> Result<Option<Json>> {
        let ask = &settings.agent_ask;
        let (Some(run_id), Some(step_id), Some(status)) = (job[ask.run_field.as_str()].as_str(), job[ask.step_field.as_str()].as_str(), job[ask.status_field.as_str()].as_str()) else { return Ok(None) };
        let (done, failed) = (ask.done.iter().any(|word| word == status), ask.failed.iter().any(|word| word == status));
        if !done && !failed { return Ok(None) }
        let Some((_, mut run)) = self.current_json(&format!("{}:{run_id}", kinds.run), policy)? else { return Ok(None) };
        if run["state"] == json!("finished") || run["state"] == json!("failed") || run["handoffs"][step_id].as_str() != Some(job_id) { return Ok(None) }
        if failed {
            let said = job[ask.error_field.as_str()].as_str().unwrap_or_default();
            run["state"] = json!("failed");
            run["error"] = json!(runs::say("job_ended", &[("job", job_id), ("status", status), ("said", said)]));
            return Ok(Some(run));
        }
        let result = &job[ask.result_field.as_str()];
        if !run["answers"].is_object() { run["answers"] = json!({}); }
        run["answers"][step_id] = if result.is_object() { result.clone() } else { json!({ ask.result_field.as_str(): result }) };
        Ok(Some(run))
    }

    /// One run of `workflow_id` (workflows.mjs pass): its definition from the recipe row, run with the answers the run
    /// holds; the run row's new value, or none when its workflow is not kept here (the run says so).
    fn pass_run(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy, run: &mut Json, at: &str) -> Result<Vec<(String, String, Json)>> {
        let workflow_id = run["workflow_id"].as_str().unwrap_or_default().to_string();
        let definition = match self.recipe_definition(settings, kinds, policy, &workflow_id)? {
            Some(Ok(definition)) => definition,
            Some(Err(why)) => {
                // A recipe that is kept but cannot be read as a definition says why on the run, never "not kept".
                run["state"] = json!("failed");
                let refusal = CodedError::new(runs::say("unreadable_recipe", &[("workflow_id", &workflow_id), ("why", &why)]));
                run["error_cause"] = json!(refusal.cause().id());
                run["error"] = json!(refusal.code);
                return Ok(Vec::new());
            }
            None => {
                // A scoped command cannot resolve a required mutable recipe in
                // another history or publish only the first part of that command.
                // Move/activate the complete local rule/recipe closure first.
                if self.state.external.record_domain.is_some() { return Err(crate::cause!(Error::Refused)); }
                run["state"] = json!("failed");
                let refusal = CodedError::new(runs::say("no_recipe", &[("workflow_id", &workflow_id)]));
                run["error_cause"] = json!(refusal.cause().id());
                run["error"] = json!(refusal.code);
                return Ok(Vec::new());
            }
        };
        if run.get("started_at").and_then(Json::as_str).is_none() { run["started_at"] = json!(at); }
        let started_at = run["started_at"].as_str().unwrap_or_default().to_string();
        let answers = run.get("answers").cloned().unwrap_or_else(|| json!({}));
        let input = run.get("input").cloned().unwrap_or_else(|| json!({}));
        match runs::run_workflow_definition(&json!([definition]), &workflow_id, &input, &answers, &settings.workflow_partition, &started_at) {
            Ok(ran) => {
                run["state"] = json!(match ran["status"].as_str() { Some("completed") => "finished", Some("failed") => "failed", _ => "working" });
                run["waiting"] = ran["waiting"].clone();
                run["steps"] = ran["execution_context"]["steps"].clone();
                run["status"] = ran["status"].clone();
                if let Some(error) = ran.get("error").filter(|error| !error.is_null()) { run["error"] = error.clone(); if let Some(cause) = ran.get("cause") { run["error_cause"] = cause.clone(); } }
                // The records its write steps asked for are written only once the run passed.
                if run["state"] == json!("finished") {
                    let asked = ran["step_writes"].as_array().cloned().unwrap_or_default();
                    match self.apply_step_writes(settings, kinds, policy, &asked)? {
                        Ok(wrote) => if !asked.is_empty() { run["wrote"] = json!(wrote); },
                        Err(reason) => { run["state"] = json!("failed"); run["error"] = json!(reason.code); run["error_cause"] = json!(reason.cause().id()); }
                    }
                }
            }
            Err(error) => { run["state"] = json!("failed"); run["error"] = json!(error.code); run["error_cause"] = json!(error.cause().id()); }
        }
        self.hand_off_asks(settings, policy, run, at)
    }

    /// The records a passed run's write steps asked for (`asked`: each `{step_id, records}`, every record
    /// `{id, type, set?, add?, remove?, expected?}`), written in one ordered write on this held transaction over what
    /// was read here: `set` replaces those fields, `add` puts each listed item into that array field unless it is
    /// there, `remove` takes each out, and `expected` (as the records write has it: null for absent, or `{type, value}`)
    /// must be what was read. The ids the write changed, in order; or, when one is refused, the reason, with nothing
    /// of the run written.
    fn apply_step_writes(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy, asked: &[Json]) -> Result<std::result::Result<Vec<String>, CodedError>> {
        let records: Vec<&Json> = asked.iter().flat_map(|step| step["records"].as_array().into_iter().flatten()).collect();
        if records.len() > settings.most_step_writes {
            return Ok(Err(CodedError::new(runs::say("too_many_writes", &[("count", &records.len().to_string()), ("most", &settings.most_step_writes.to_string())]))));
        }
        let own_kind = |kind: &str| kinds.own(kind);
        let mut observed = BTreeMap::<String, Option<Record>>::new();
        // What each id holds at this point of the run's writes: (type, value), None when absent.
        let mut now = BTreeMap::<String, Option<(String, Json)>>::new();
        let mut order = Vec::<String>::new();
        for record in records {
            let (Some(id), Some(kind)) = (record["id"].as_str().filter(|id| !id.is_empty()), record["type"].as_str().filter(|kind| !kind.is_empty())) else {
                return Ok(Err(CodedError::new(runs::say("bad_write", &[("id", &record["id"].to_string())]))));
            };
            if !observed.contains_key(id) {
                let current = self.with_current_values(|values| logical(values, id, policy))?;
                let held = match &current { Some(record) => Some((record.kind.as_ref().map(text).transpose()?.unwrap_or_default(), to_json(&record.value)?)), None => None };
                observed.insert(id.to_string(), current);
                now.insert(id.to_string(), held);
            }
            let held = now[id].clone();
            if own_kind(kind) || held.as_ref().is_some_and(|(held, _)| own_kind(held)) {
                return Ok(Err(CodedError::new(runs::say("not_own_write", &[("kind", held.as_ref().map_or(kind, |(held, _)| held.as_str()))]))));
            }
            if let Some((held, _)) = held.as_ref().filter(|(held, _)| held != kind) {
                return Ok(Err(CodedError::new(runs::say("other_type", &[("id", id), ("held", held), ("type", kind)]))));
            }
            if let Some(expected) = record.get("expected") {
                let matches = match (expected, &held) {
                    (Json::Null, None) => true,
                    (expected, Some((held, value))) => expected["type"].as_str() == Some(held.as_str()) && &expected["value"] == value,
                    _ => false,
                };
                if !matches { return Ok(Err(CodedError::new(runs::say("changed_since_read", &[("id", id)])))) }
            }
            let mut value = held.map(|(_, value)| value).unwrap_or_else(|| json!({}));
            let Some(fields) = value.as_object_mut() else { return Ok(Err(CodedError::new(runs::say("bad_write", &[("id", id)])))) };
            for (field, set) in record["set"].as_object().into_iter().flatten() { fields.insert(field.clone(), set.clone()); }
            for (field, items) in record["add"].as_object().into_iter().flatten() {
                let list = fields.entry(field.clone()).or_insert_with(|| json!([]));
                if !list.is_array() { *list = json!([]); }
                let list = list.as_array_mut().ok_or(crate::cause!(Error::Invalid))?;
                for item in items.as_array().into_iter().flatten() { if !list.contains(item) { list.push(item.clone()); } }
            }
            for (field, items) in record["remove"].as_object().into_iter().flatten() {
                if let Some(list) = fields.get_mut(field).and_then(Json::as_array_mut) {
                    let gone: Vec<&Json> = items.as_array().into_iter().flatten().collect();
                    list.retain(|item| !gone.contains(&item));
                }
            }
            now.insert(id.to_string(), Some((kind.to_string(), value)));
            if !order.iter().any(|known| known == id) { order.push(id.to_string()); }
        }
        // Only what differs from what was read is written; a second identical write changes nothing.
        let mut writes = Vec::new();
        let mut wrote = Vec::new();
        for id in order {
            let Some((kind, value)) = now[&id].clone() else { continue };
            let before = match &observed[&id] { Some(record) => Some((record.kind.as_ref().map(text).transpose()?.unwrap_or_default(), to_json(&record.value)?)), None => None };
            if before.as_ref() == Some(&(kind.clone(), value.clone())) { continue }
            writes.push(Write { id: JsString::from(id.as_str()), kind: JsString::from(kind.as_str()), value: Some(from_json(&value)?) });
            wrote.push(id);
        }
        if writes.is_empty() { return Ok(Ok(wrote)) }
        // The records write's own checks (the live record model, the person present) refuse before anything is
        // written; a step never carries the person's confirmation, so a write that needs it is refused.
        match self.write_observed(&observed, &writes, Some(None)) {
            Ok(()) => Ok(Ok(wrote)),
            Err(error @ (Error::Invalid(_) | Error::Refused(_) | Error::Conflict(_) | Error::OutsideChoices(_) | Error::MoveNotDeclared(_) | Error::NeedsPersonPresent(_))) => {
                self.state.external.outside = None;
                Ok(Err(CodedError::with_cause(runs::say("write_refused", &[("why", &error.to_string())]), error.cause())))
            }
            Err(error) => Err(error),
        }
    }

    /// After a records:write (`planned` over `observed`): the rules over what it changed, the workflow runs they and the
    /// person started, and every row these write, in one more ordered write on this held transaction. These rows are
    /// written by the rules and runs themselves, so they are never handed to the rules again. What a run's write steps
    /// wrote (the account's own records, never these rows) is handed to the rules again, as Trillion's store handed
    /// every records write to its automations (a run_tool step's write went through the same store write), for at most
    /// `most_rule_rounds` rounds on this one write; a round that wrote nothing new ends it.
    pub(super) fn run_rules_after_write(&mut self, planned: &[Write]) -> Result<()> {
        let settings = runs::settings().map_err(|error| Error::Source(error.cause()))?;
        let model = crate::record_model_policy::installed(self.state.owner.state_root()).map_err(|error| Error::Source(error.cause()))?;
        if self.state.external.record_domain.is_some()
            && !self.state.external.records(self.db)?.command_closure_matches(&model).map_err(|error| Error::Source(error.cause()))? {
            return Err(crate::cause!(Error::Conflict));
        }
        // The kinds come from the tool that keeps the rules; with none installed, no rule runs and no run goes on.
        let Some(kinds) = runs::Kinds::of(&model).map_err(|error| Error::Source(error.cause()))? else { return Ok(()) };
        let kinds = &kinds;
        let policy = model.open_policy().clone();
        let at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(i64::try_from(self.request.sent_at_ms).map_err(|error| crate::carry_cause!(Error::Bounds, error))?)
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).ok_or(crate::cause!(Error::Bounds))?;
        let mut changed = Vec::with_capacity(planned.len());
        for write in planned { changed.push((text(&write.id)?, text(&write.kind)?, write.value.is_some())); }
        for round in 0..settings.most_rule_rounds {
            let wrote = self.rules_round(settings, kinds, &policy, &at, round, &changed)?;
            if wrote.is_empty() { break }
            changed.clear();
            for id in wrote {
                let kind = self.current_json(&id, &policy)?.map(|(kind, _)| kind);
                changed.push((id, kind.unwrap_or_default(), true));
            }
        }
        Ok(())
    }

    /// One round of the rules over `changed` (each id, the kind written, and whether it holds a value now): the runs
    /// it and the person started, passed, and the rows these write. The ids the runs' write steps wrote, in order.
    fn rules_round(&mut self, settings: &runs::Settings, kinds: &runs::Kinds, policy: &record_value::OpenPolicy, at: &str, round: usize, changed: &[(String, String, bool)]) -> Result<Vec<String>> {
        let own_kind = |kind: &str| kinds.own(kind);
        let mut changes = BTreeMap::<String, Json>::new();
        let mut runs = BTreeMap::<String, Json>::new();
        let mut kept = Vec::<(String, String, Json)>::new();
        for (id, kind, written) in changed {
            let (id, kind) = (id.clone(), kind.clone());
            if kind == kinds.run && *written {
                // A person starts a run, or goes on with one, by writing its row; a finished run stays finished.
                if let Some((_, value)) = self.current_json(&id, &policy)? {
                    if value["state"] != json!("finished") && value["workflow_id"].is_string() { runs.insert(id.clone(), value); }
                }
            }
            if kind == settings.agent_ask.job_kind && *written {
                // An AI finishes the job a run waits on by writing its row: the run goes on with its result.
                if let Some((_, job)) = self.current_json(&id, &policy)? {
                    if let Some(run) = self.answer_from_job(settings, kinds, &policy, &id, &job)? {
                        let row = format!("{}:{}", kinds.run, run["run_id"].as_str().unwrap_or_default());
                        if run["state"] == json!("failed") { kept.push((row, kinds.run.clone(), run)); } else { runs.insert(row, run); }
                    }
                }
            }
            if own_kind(&kind) { continue }
            let change = match self.current_json(&id, &policy)? {
                // What a rule sees of a record is `{ kind, id, record }` (Trillion `shaped`), the shape every rule binds.
                Some((kind, value)) => { let shaped = runs::shipped_rules::change_of(&id, &kind, &value); json!({ "address": id, "path": [kind], "value": shaped }) }
                None => json!({ "address": id, "removed": true }),
            };
            changes.insert(id, change);
        }
        let mut sends = Vec::<(String, Json)>::new();
        if !changes.is_empty() {
            let rules = self.rule_rows(settings, kinds, &policy)?;
            if !rules.is_empty() {
                let changes: Vec<Json> = changes.into_values().collect();
                let fired = runs::rules_over_records(&settings.rule_partition, &kinds.rule, &rules, &changes, &[]).map_err(|error| Error::Source(error.cause()))?;
                for fire in &fired.fires {
                    let payload = &fire["payload"];
                    if fire["later"] == Json::Bool(true) { continue }
                    // A send to a tool is kept for the wake runner (src/wake.rs `sends`), once per tool and send key.
                    if let Some(tool_id) = payload["then"]["tool_id"].as_str().filter(|_| payload["then"]["workflow_id"].is_null()) {
                        let request_key = runs::send_key(payload);
                        let id = runs::send_id(tool_id, &request_key).map_err(|error| Error::Source(error.cause()))?;
                        if sends.iter().any(|(known, _)| known == &id) || self.current_json(&id, &policy)?.is_some() { continue }
                        sends.push((id, json!({ "tool_id": tool_id, "request_key": request_key, "input": payload.get("input").cloned().unwrap_or_else(|| json!({})),
                            "rule_id": payload["rule_id"], "sent_at": at })));
                        continue;
                    }
                    let Some(workflow_id) = payload["then"]["workflow_id"].as_str() else { continue };
                    let request_key = runs::send_key(payload);
                    let run_id = runs::run_id(workflow_id, &request_key).map_err(|error| Error::Source(error.cause()))?;
                    let row = format!("{}:{run_id}", kinds.run);
                    if runs.contains_key(&row) || self.current_json(&row, &policy)?.is_some() { continue }
                    runs.insert(row, json!({ "run_id": run_id, "workflow_id": workflow_id, "request_key": request_key,
                        "input": payload.get("input").cloned().unwrap_or_else(|| json!({})), "answers": {}, "started_by": payload["rule_id"] }));
                }
                for write in &fired.writes {
                    let address = write["address"].as_str().unwrap_or_default();
                    let kind = write["payload"]["kind"].as_str().unwrap_or(&kinds.outcome).to_string();
                    let mut value = write["payload"].clone();
                    value["address"] = json!(address);
                    value["recorded_at"] = json!(at);
                    // The run each send started goes beside the rules' outcome for it, as Trillion kept it.
                    if let Some(workflow_id) = value["dispatch"]["then"]["workflow_id"].as_str() {
                        let run_id = runs::run_id(workflow_id, &runs::send_key(&value["dispatch"])).map_err(|error| Error::Source(error.cause()))?;
                        value["started"] = json!({ "run_id": run_id });
                    } else if let Some(tool_id) = value["dispatch"]["then"]["tool_id"].as_str() {
                        value["started"] = json!({ "send": runs::send_id(tool_id, &runs::send_key(&value["dispatch"])).map_err(|error| Error::Source(error.cause()))? });
                    }
                    // A later round's outcome for the same address at the same time is its own row, not the first one's.
                    let named = if round == 0 { address.to_string() } else { format!("{address}#{round}") };
                    kept.push((runs::rule_run_id(&at, &named).map_err(|error| Error::Source(error.cause()))?, kind, value));
                }
            }
        }
        for (id, send) in sends { kept.push((id, kinds.send.clone(), send)); }
        let mut wrote = Vec::<String>::new();
        for (id, run) in runs.iter_mut() {
            let jobs = self.pass_run(settings, kinds, &policy, run, &at)?;
            kept.extend(jobs);
            for written in run["wrote"].as_array().into_iter().flatten().filter_map(Json::as_str) {
                if !wrote.iter().any(|known| known == written) { wrote.push(written.to_string()); }
            }
            kept.push((id.clone(), kinds.run.clone(), run.clone()));
        }
        if kept.is_empty() { return Ok(wrote) }
        let mut observed = BTreeMap::<String, Option<Record>>::new();
        let mut writes = Vec::with_capacity(kept.len());
        for (id, kind, value) in kept {
            if !observed.contains_key(&id) {
                let current = self.with_current_values(|values| logical(values, &id, &policy))?;
                observed.insert(id.clone(), current);
            }
            writes.push(Write { id: JsString::from(id.as_str()), kind: JsString::from(kind.as_str()), value: Some(from_json(&value)?) });
        }
        self.write_observed(&observed, &writes, None)?;
        Ok(wrote)
    }
}
