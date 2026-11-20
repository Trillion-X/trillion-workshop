// crates/workflow-engine/src/approval.rs
//
// Purpose:
//   The approval check. An ask of the person that names an approval (`context.approval`) is settled here before the person
//   is asked: the person's approval_setting for the step's scope, else the master scope '*', decides. A setting in mode `auto`
//   writes one approval_decision row and the step is answered without the person; any other mode, or no setting, asks the
//   person as before. The check is one statement run through tool:run-sql-in-my-database, so each host reaches it through its
//   own tool path (wf through the account's door, the wake through its door effect) and keeps its answer like any other step.
//
// Non-Negotiable Invariants:
//   1. Only an ask of the person (`anyone`, `whoever-holds-the-run`) is settled here. A tool, a program or an AI is never
//      answered by this check.
//   2. An ask with no `approval` in its context is a question, not an approval: it is never answered by this check.
//   3. Fail closed: a check that cannot be read, or whose answer has no rows, fails the step. Nothing is decided and the
//      person is not asked by mistake.
//   4. The check's answer is kept under its own step key (the step's key with `:approval-check`), so a replay reads the same
//      decision and writes no second row.
//
// Key Concepts:
//   - settle(): the one entry. Ok(None) asks the person; Ok(Some(answer)) is the answer the step gets instead.
//   - CHECK_SQL: the one statement. It reads the setting for the approver and scope (falling back to '*') and, for `auto`,
//     writes the decision row in the same statement.
//
// AI Directive:
//   This file is the single place the approval rule lives. Do not add a second check in a host (wf.rs, the wake) or a tool.
//   A new approval scope is a row in approval_setting, never a branch here.

use serde_json::{json, Value};
use workflow_core::executor::context::NOT_ANSWERED_YET;

use crate::Host;

const PERSON_ASKS: [&str; 2] = ["anyone", "whoever-holds-the-run"];
const CHECK_TOOL: &str = "tool:run-sql-in-my-database";
const CHECK_SUFFIX: &str = ":approval-check";

/// Reads the approver's setting for the scope, else the master scope '*' (a scope row wins). Writes one approval_decision
/// row only when that setting's mode is `auto`, in the same statement. Parameters: $1 approver, $2 scope, $3 subject.
const CHECK_SQL: &str = "
WITH setting AS (
  SELECT person, scope, mode, set_by FROM approval_setting
  WHERE person = $1 AND scope IN ($2, '*')
  ORDER BY scope = $2 DESC
  LIMIT 1
), decided AS (
  INSERT INTO approval_decision (id, post_id, person, at, decision, approved_how, setting_id, mode, reason, approved_by)
  SELECT gen_random_uuid()::text, $3, person, now(), 'approved', 'auto-setting', 'approval_setting:' || person || ':' || scope, mode, set_by, person
  FROM setting WHERE mode = 'auto'
  RETURNING id
)
SELECT setting.person, setting.scope, setting.mode, setting.set_by, decided.id AS decision_id
FROM setting LEFT JOIN decided ON true";

/// The step's key as the host sees it: its authored step id, else its last place in the run.
fn step_key(context: &Value) -> String {
    context["step_id"].as_str().map(str::to_owned)
        .or_else(|| context["_runtime_identity"].as_array().and_then(|path| path.last()).map(Value::to_string))
        .unwrap_or_default()
}

fn approval_field<'a>(approval: &'a Value, key: &str, step: &str) -> Result<&'a str, String> {
    approval[key].as_str().map(str::trim).filter(|text| !text.is_empty()).ok_or_else(|| format!(
        "The approval of step {step} names no {key}. Give context.approval its scope, approver and credential_name (the held connection name of the database that holds approval_setting)."
    ))
}

/// Settles an ask of the person that names an approval. Ok(None): the person is asked as before. Ok(Some(answer)): the step
/// is answered with it instead (an auto decision, or not-answered-yet while the check itself waits).
pub async fn settle<H: Host + ?Sized>(host: &H, name: &str, context: &Value) -> Result<Option<Value>, String> {
    if !PERSON_ASKS.contains(&name) { return Ok(None); }
    let Some(approval) = context.get("approval").filter(|approval| approval.is_object()) else { return Ok(None) };
    let step = step_key(context);
    let scope = approval_field(approval, "scope", &step)?;
    let approver = approval_field(approval, "approver", &step)?;
    let credential = approval_field(approval, "credential_name", &step)?;
    let subject = approval["subject"].as_str().filter(|text| !text.is_empty()).unwrap_or(&step);

    let mut check_context = context.clone();
    check_context["step_id"] = json!(format!("{step}{CHECK_SUFFIX}"));
    let asked = json!({ "credential_name": credential, "sql": CHECK_SQL, "params": [approver, scope, subject] });
    let reply = host.ask(CHECK_TOOL, serde_json::to_vec(&asked).map_err(|e| e.to_string())?, Some(serde_json::to_vec(&check_context).map_err(|e| e.to_string())?)).await?;
    let answer: Value = serde_json::from_slice(&reply).map_err(|error| format!("The approval check of step {step} did not answer with JSON: {error}"))?;
    if answer["$kind"] == NOT_ANSWERED_YET { return Ok(Some(answer)); }

    let Some(rows) = answer["rows"].as_array() else {
        return Err(format!("The approval check of step {step} answered without rows, so nothing was decided."));
    };
    let Some(row) = rows.first() else { return Ok(None) };
    if row["mode"] != "auto" { return Ok(None); }
    let decision_id = row["decision_id"].as_str().ok_or_else(|| format!("The approval check of step {step} is auto but wrote no decision row."))?;
    Ok(Some(json!({
        "decision": "approved",
        "approved_how": "auto-setting",
        "approved_by": row["person"],
        "setting_id": format!("approval_setting:{}:{}", row["person"].as_str().unwrap_or_default(), row["scope"].as_str().unwrap_or_default()),
        "reason": row["set_by"],
        "decision_id": decision_id,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A host whose check answers `check`, and that records every ask it is handed.
    struct Settings { check: Value, asked: Mutex<Vec<String>> }

    #[async_trait::async_trait]
    impl Host for Settings {
        async fn ask(&self, name: &str, _: Vec<u8>, _: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
            self.asked.lock().unwrap().push(name.to_string());
            if name == CHECK_TOOL { return Ok(serde_json::to_vec(&self.check).unwrap()); }
            Ok(serde_json::to_vec(&json!({ "$kind": NOT_ANSWERED_YET })).unwrap())
        }
        async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
    }

    fn host(check: Value) -> Settings { Settings { check, asked: Mutex::new(vec![]) } }

    fn approval_context() -> Value {
        json!({ "step_id": "keep-clip", "approval": { "scope": "proof-auto-scope", "approver": "test-person", "credential_name": "proof-connection" } })
    }

    fn auto_row() -> Value {
        json!({ "columns": ["person", "scope", "mode", "set_by", "decision_id"], "rows": [{
            "person": "test-person", "scope": "proof-auto-scope", "mode": "auto", "set_by": "lane approval-check proof", "decision_id": "d-1"
        }], "row_count": 1 })
    }

    #[tokio::test]
    async fn an_auto_setting_answers_the_person_without_asking_them() {
        let settings = host(auto_row());
        let answer = settle(&settings, "anyone", &approval_context()).await.unwrap().expect("settled");
        assert_eq!(answer["decision"], "approved");
        assert_eq!(answer["approved_how"], "auto-setting");
        assert_eq!(answer["setting_id"], "approval_setting:test-person:proof-auto-scope");
        assert_eq!(answer["reason"], "lane approval-check proof");
        assert_eq!(answer["decision_id"], "d-1");
        assert_eq!(*settings.asked.lock().unwrap(), vec![CHECK_TOOL.to_string()]);
    }

    #[tokio::test]
    async fn a_setting_in_ask_mode_leaves_the_person_asked() {
        let check = json!({ "rows": [{ "person": "test-person", "scope": "proof-ask-scope", "mode": "ask", "set_by": "x", "decision_id": null }], "row_count": 1 });
        assert!(settle(&host(check), "anyone", &approval_context()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn no_setting_leaves_the_person_asked() {
        assert!(settle(&host(json!({ "rows": [], "row_count": 0 })), "anyone", &approval_context()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_question_without_an_approval_is_never_settled_and_never_checked() {
        let settings = host(auto_row());
        let question = json!({ "step_id": "pick-name" });
        assert!(settle(&settings, "anyone", &question).await.unwrap().is_none());
        assert!(settings.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_tool_or_an_ai_is_never_settled_even_with_an_approval() {
        let settings = host(auto_row());
        assert!(settle(&settings, "tool:post-it", &approval_context()).await.unwrap().is_none());
        assert!(settle(&settings, "ai", &approval_context()).await.unwrap().is_none());
        assert!(settings.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_check_still_waiting_waits_the_step() {
        let waiting = json!({ "$kind": NOT_ANSWERED_YET, "step_id": "keep-clip:approval-check" });
        let answer = settle(&host(waiting), "anyone", &approval_context()).await.unwrap().expect("waiting");
        assert_eq!(answer["$kind"], NOT_ANSWERED_YET);
    }

    #[tokio::test]
    async fn a_check_without_rows_fails_the_step_and_decides_nothing() {
        assert!(settle(&host(json!({ "error": "no database" })), "anyone", &approval_context()).await.is_err());
    }

    #[tokio::test]
    async fn an_approval_that_names_no_approver_is_refused() {
        let context = json!({ "step_id": "keep-clip", "approval": { "scope": "s", "credential_name": "c" } });
        assert!(settle(&host(auto_row()), "anyone", &context).await.is_err());
    }

    #[tokio::test]
    async fn a_run_settled_by_an_auto_setting_completes_without_the_person() {
        let definition: crate::Definition = serde_json::from_value(json!({
            "id": "clip", "name": "Clip", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "keep-clip", "kind": "ask", "config": { "name": "anyone", "input": {}, "context": approval_context() } }]
        })).expect("definition decodes");
        let settings = Arc::new(host(auto_row()));
        let run = crate::run_definition(vec![definition], "clip", json!({}), "person:test-person", "example", settings.clone()).await.expect("runs");
        assert_eq!(run["status"], "completed", "{run}");
        assert_eq!(run["execution_context"]["steps"]["keep-clip"]["output"]["decision"], "approved");
        assert_eq!(*settings.asked.lock().unwrap(), vec![CHECK_TOOL.to_string()]);
    }

    #[tokio::test]
    async fn a_run_with_a_setting_in_ask_mode_pauses_for_the_person() {
        let definition: crate::Definition = serde_json::from_value(json!({
            "id": "clip", "name": "Clip", "kind": "workflow", "is_active": true, "version": 1,
            "steps": [{ "id": "keep-clip", "kind": "ask", "config": { "name": "anyone", "input": {}, "context": approval_context() } }]
        })).expect("definition decodes");
        let check = json!({ "rows": [{ "person": "test-person", "scope": "proof-auto-scope", "mode": "ask", "set_by": "x", "decision_id": null }], "row_count": 1 });
        let settings = Arc::new(host(check));
        let run = crate::run_definition(vec![definition], "clip", json!({}), "person:test-person", "example", settings.clone()).await.expect("runs");
        assert_eq!(run["status"], "paused", "{run}");
        assert_eq!(*settings.asked.lock().unwrap(), vec![CHECK_TOOL.to_string(), "anyone".to_string()]);
    }
}
