// crates/workflow-core/src/executor/checks.rs
//
// Purpose:
//   The `check` step: holds the values one step handed back against other values in the run (the run's input,
//   earlier steps' outputs, a fixed list) and passes only when every rule holds. A step that fails its checks ends
//   with `WorkflowError::CheckFailed`, every problem said in plain words, so whoever answered that step can fix the
//   answer and send it again.
//
// Non-Negotiable Invariants:
//   1. A rule is DATA: `{ kind, says, path, of?, in?, values?, words?, count?, catalog? }`. Every value is reached by a
//      path, a list of keys where "*" means every item of a list, starting at "this" (the checked step's output),
//      "input" (the run's input) or "steps" then an earlier step's id. `path`, `of` and `in` may each be one path or a
//      list of paths whose values are read together. A missing key reaches nothing, so a rule over it finds nothing.
//   2. The kinds are the ways one set of values can be held against another:
//        subset-of          every value at `path` is one of the values at `of`
//        covers             the values at `path` include every value at `of` (or every value in `values`)
//        mentioned-in       every value at `path` appears, ignoring case, inside some text at `in`
//        excludes-words     no text at `path` contains any of `words`, ignoring case
//        distinct-at-least  the values at `path` hold at least `count` different values
//        exists             every value at `path` names something the host can read in `catalog`
//        lane-jobs          the items at `path` are one per lane in `lanes`, each handing back its lane id (field
//                           `lane`) and the id of the job that ran it (field `job`, which must be `prefix` then the
//                           lane id, so no job stands for two lanes); the host is asked about each job through
//                           `read` of `{"catalog": "ran-job", "id": <job>}`, answering `{"taker": <who finished it>}`,
//                           and a job it cannot answer, or one finished by a taker that finished another lane too, fails
//      Two values are the same when their text (trimmed) or their canonical JSON is the same.
//   3. A path starting at "this" reaches nothing outside a check (a step's input has no "this").
//   4. `exists` asks the host only through `OutsideAccess::read`, with `from` the JSON text
//      `{"catalog": <catalog>, "id": <value>}`; a read that answers means the thing exists.
//   5. Every rule is judged, and each failing rule names at most eight of the values it found wrong.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

use serde_json::Value;

use crate::domain::errors::WorkflowError;
use crate::domain::types::{ExecutionContext, Step, StepHandlerResult, StepOutput, ExecutionStatus};

use super::context::{values_in_run, ExecutorDeps};

/// A value's text for comparing: a string trimmed, anything else as canonical JSON (keys in order).
fn scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        other => canonical(other),
    }
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter().map(|key| format!("{}:{}", Value::String((*key).clone()), canonical(&map[*key]))).collect::<Vec<_>>().join(",")
            )
        }
        other => other.to_string(),
    }
}

fn plain_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// The paths a rule field holds: one path (a list of keys) or a list of paths.
fn paths_of(field: &Value) -> Vec<&[Value]> {
    match field.as_array() {
        Some(items) if items.first().is_some_and(Value::is_array) => items.iter().filter_map(|path| path.as_array().map(Vec::as_slice)).collect(),
        Some(items) => vec![items.as_slice()],
        None => Vec::new(),
    }
}

fn invalid(step: &Step, reason: String) -> WorkflowError {
    WorkflowError::InvalidStep {
        step_id: step.id.clone(),
        reason,
        hint: "A check step's config is { subject: <step id>, rules: [{ kind, says, path, ... }] }; see crates/workflow-core/src/executor/checks.rs.".to_string(),
    }
}

/// Runs a `check` step: every rule over the subject step's output, and `CheckFailed` naming each one that does not hold.
pub async fn execute_check_step(step: &Step, ctx: &ExecutionContext, deps: &ExecutorDeps) -> Result<StepHandlerResult, WorkflowError> {
    let subject = step.config.get("subject").and_then(Value::as_str).ok_or_else(|| invalid(step, "config.subject must name the step whose output is checked".to_string()))?;
    let this = ctx.step_output(subject).map(|output| output.output.clone()).unwrap_or(Value::Null);
    let rules = step.config.get("rules").and_then(Value::as_array).ok_or_else(|| invalid(step, "config.rules must be a list of rules".to_string()))?;
    let mut problems = Vec::new();
    for rule in rules {
        let kind = rule.get("kind").and_then(Value::as_str).unwrap_or_default();
        let said = |name: &str| -> Vec<Value> {
            rule.get(name).map(paths_of).unwrap_or_default().into_iter().flat_map(|path| values_in_run(ctx, Some(&this), path)).collect()
        };
        let found: Vec<String> = match kind {
            "subset-of" => {
                let allowed: std::collections::HashSet<String> = said("of").iter().map(scalar).collect();
                said("path").into_iter().filter(|value| !allowed.contains(&scalar(value))).map(|value| format!("{value} is not one of them")).collect()
            }
            "covers" => {
                let held: std::collections::HashSet<String> = said("path").iter().map(scalar).collect();
                let wanted = match rule.get("values").and_then(Value::as_array) {
                    Some(values) => values.clone(),
                    None => said("of"),
                };
                wanted.into_iter().filter(|value| !held.contains(&scalar(value))).map(|value| format!("{value} is missing")).collect()
            }
            "mentioned-in" => {
                let texts: Vec<String> = said("in").iter().filter_map(Value::as_str).map(str::to_lowercase).collect();
                said("path")
                    .into_iter()
                    .filter(|value| {
                        let wanted = plain_text(value).trim().to_lowercase();
                        !texts.iter().any(|text| text.contains(&wanted))
                    })
                    .map(|value| format!("{value} is not mentioned there"))
                    .collect()
            }
            "excludes-words" => {
                let words: Vec<&str> = rule.get("words").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                said("path")
                    .iter()
                    .filter_map(Value::as_str)
                    .flat_map(|text| {
                        let lower = text.to_lowercase();
                        let quoted: String = text.chars().take(120).collect();
                        words.iter().filter(move |word| lower.contains(&word.to_lowercase())).map(move |word| format!("\"{quoted}\" says \"{word}\"")).collect::<Vec<_>>()
                    })
                    .collect()
            }
            "distinct-at-least" => {
                let count = said("path").iter().map(scalar).collect::<std::collections::HashSet<_>>().len();
                let needed = rule.get("count").and_then(Value::as_u64).ok_or_else(|| invalid(step, "a distinct-at-least rule needs count".to_string()))?;
                if count as u64 >= needed { Vec::new() } else { vec![format!("{count} found, at least {needed} needed")] }
            }
            "exists" => {
                let catalog = rule.get("catalog").and_then(Value::as_str).ok_or_else(|| invalid(step, "an exists rule needs catalog".to_string()))?;
                let mut missing = Vec::new();
                for value in said("path") {
                    let from = serde_json::json!({ "catalog": catalog, "id": plain_text(&value) }).to_string();
                    if deps.outside_access.read(&from, &deps.dispatch_partition).await.is_err() {
                        missing.push(format!("{value} is not a {catalog} this account can find"));
                    }
                }
                missing
            }
            "lane-jobs" => {
                let field = |name: &str| rule.get(name).and_then(Value::as_str).ok_or_else(|| invalid(step, format!("a lane-jobs rule needs {name}")));
                let (lane_field, job_field, prefix) = (field("lane")?, field("job")?, field("prefix")?);
                let lanes: Vec<String> = rule.get("lanes").and_then(Value::as_array).ok_or_else(|| invalid(step, "a lane-jobs rule needs lanes".to_string()))?.iter().map(plain_text).collect();
                let mut problems_found = Vec::new();
                let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                for item in said("path") {
                    let lane = item.get(lane_field).map(plain_text).unwrap_or_default();
                    let job = item.get(job_field).map(plain_text).unwrap_or_default();
                    if !lanes.contains(&lane) { problems_found.push(format!("{lane} is not a lane of this step")); continue; }
                    if seen.contains_key(&lane) { problems_found.push(format!("{lane} is handed back twice")); continue; }
                    if job != format!("{prefix}{lane}") { problems_found.push(format!("{lane} does not name its own job")); continue; }
                    let from = serde_json::json!({ "catalog": "ran-job", "id": job }).to_string();
                    let taker = match deps.outside_access.read(&from, &deps.dispatch_partition).await {
                        Ok(read) => serde_json::from_slice::<Value>(&read.bytes).ok().and_then(|answer| answer.get("taker").and_then(Value::as_str).map(str::to_string)),
                        Err(_) => None,
                    };
                    match taker {
                        Some(taker) => { seen.insert(lane, taker); }
                        None => problems_found.push(format!("{lane}: its job did not run")),
                    }
                }
                for lane in &lanes { if !seen.contains_key(lane) && !problems_found.iter().any(|problem| problem.starts_with(lane.as_str())) { problems_found.push(format!("{lane} is missing")); } }
                let mut by_taker: std::collections::HashMap<&String, Vec<&String>> = std::collections::HashMap::new();
                for (lane, taker) in &seen { by_taker.entry(taker).or_default().push(lane); }
                for (taker, mut shared) in by_taker { if shared.len() > 1 { shared.sort(); problems_found.push(format!("{taker} finished lanes {}", shared.iter().map(|lane| lane.as_str()).collect::<Vec<_>>().join(", "))); } }
                problems_found
            }
            other => return Err(invalid(step, format!("rule kind '{other}' is not one of subset-of, covers, mentioned-in, excludes-words, distinct-at-least, exists, lane-jobs"))),
        };
        if !found.is_empty() {
            let says = rule.get("says").and_then(Value::as_str).unwrap_or(kind);
            let more = if found.len() > 8 { format!("; and {} more", found.len() - 8) } else { String::new() };
            problems.push(format!("{says} ({}{more})", found[..found.len().min(8)].join("; ")));
        }
    }
    if problems.is_empty() {
        Ok(StepHandlerResult::leaf(StepOutput { output: serde_json::json!({ "passed": rules.len() }), status: ExecutionStatus::Completed, error: None, duration_ms: 0 }))
    } else {
        Err(WorkflowError::CheckFailed { step_id: step.id.clone(), problems })
    }
}
