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
//   2. An ask with no `approval` in its context has no credential to read the settings with, so it is a question and the
//      person is asked. An ask that names a credential but no scope or approver is settled from the master scope '*' and its
//      row's person (the approver the person chose for everything).
//   2b. A kind that is excluded (approval_exclusion) or not recognised as auto (approval_kind with auto true) is never auto-decided.
//   2c. An ask of a named person (`person:<who>`) is settled the same way. An ask that names a person other than the person
//       the rule reads (`person:<who>`, or the approval's own `person`) goes to the rule as the kind `another-person-consent`,
//       so the owner's standing answer never answers for someone else. Which asks are gated comes only from the step's own
//       declared fields (its ask name and its `approval`), never from its words.
//   2d. A rule that refuses the act (the person's last grant for the purpose was withdrawn) fails the step in words: the
//       person is not asked what they already took back. A settled answer names the decision row (`decided_by`).
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

/// The one rule is approval_covers() (tools/workflows/sql/approval-covers.sql, in each store that holds approval_setting):
/// the kind's approval_kind row, then the person's last withdrawn grant for the purpose, then the scope's approval_setting
/// row (else '*'). This statement only asks it, and writes one approval_decision row when it covers the act, in the same
/// statement. The approver ($1, null: the person of the '*' row) is the person the rule reads.
/// Parameters: $1 approver or null, $2 scope, $3 subject (post_id), $4 kind or null, $5 purpose, $6 the person the ask names or
/// null: one other than the rule's person makes the kind `another-person-consent`. `refused` is the rule's withdrawn-grant
/// answer (approval_covers' own reason for it).
const CHECK_SQL: &str = "
WITH who AS (
  SELECT coalesce($1::text, (SELECT person FROM approval_setting WHERE scope = '*' ORDER BY person LIMIT 1)) AS person
), answer AS (
  SELECT who.person, c.covered, c.setting_id, c.reason
  FROM who CROSS JOIN LATERAL approval_covers(who.person, $2,
    CASE WHEN $6::text IS NOT NULL AND $6::text <> who.person THEN 'another-person-consent' ELSE $4::text END, $5) c
), decided AS (
  INSERT INTO approval_decision (id, post_id, person, at, decision, approved_how, setting_id, mode, reason, approved_by)
  SELECT gen_random_uuid()::text, $3, answer.person, now(), 'approved', 'auto-setting', answer.setting_id, 'auto', answer.reason, answer.person
  FROM answer WHERE answer.covered
  RETURNING id
)
SELECT answer.person, answer.covered, answer.setting_id, answer.reason, decided.id AS decision_id,
  (NOT answer.covered AND answer.reason = 'the grant for this purpose was withdrawn') AS refused
FROM answer LEFT JOIN decided ON true";

/// Whether `name` asks a person: one of `PERSON_ASKS`, or a named person (`person:<who>`), with that person.
fn person_ask(name: &str) -> Option<Option<&str>> {
    if PERSON_ASKS.contains(&name) { return Some(None); }
    name.strip_prefix("person:").filter(|who| !who.is_empty()).map(Some)
}

/// The step's key as the host sees it: its authored step id, else its last place in the run.
fn step_key(context: &Value) -> String {
    context["step_id"].as_str().map(str::to_owned)
        .or_else(|| context["_runtime_identity"].as_array().and_then(|path| path.last()).map(Value::to_string))
        .unwrap_or_default()
}

fn approval_text<'a>(approval: &'a Value, key: &str) -> Option<&'a str> {
    approval[key].as_str().map(str::trim).filter(|text| !text.is_empty())
}

fn approval_field<'a>(approval: &'a Value, key: &str, step: &str) -> Result<&'a str, String> {
    approval_text(approval, key).ok_or_else(|| format!(
        "The approval of step {step} names no {key}. Give context.approval its credential_name (the held connection name of the database that holds approval_setting); scope, approver and kind are optional."
    ))
}

/// Settles an ask of the person that names an approval. Ok(None): the person is asked as before. Ok(Some(answer)): the step
/// is answered with it instead (an auto decision, or not-answered-yet while the check itself waits). The scope defaults to
/// the master '*', and the approver to the person of the setting row that decides; a kind is passed to the gate.
pub async fn settle<H: Host + ?Sized>(host: &H, name: &str, context: &Value) -> Result<Option<Value>, String> {
    let Some(named) = person_ask(name) else { return Ok(None) };
    let Some(approval) = context.get("approval").filter(|approval| approval.is_object()) else { return Ok(None) };
    let step = step_key(context);
    let credential = approval_field(approval, "credential_name", &step)?;
    let scope = approval_text(approval, "scope").unwrap_or("*");
    let approver = approval_text(approval, "approver");
    let kind = approval_text(approval, "kind");
    let subject = approval["subject"].as_str().filter(|text| !text.is_empty()).unwrap_or(&step);
    let purpose = approval_text(approval, "purpose").unwrap_or(subject);
    let asked_person = approval_text(approval, "person").or(named);

    let mut check_context = context.clone();
    check_context["step_id"] = json!(format!("{step}{CHECK_SUFFIX}"));
    let asked = json!({ "credential_name": credential, "sql": CHECK_SQL, "params": [approver, scope, subject, kind, purpose, asked_person] });
    let reply = host.ask(CHECK_TOOL, serde_json::to_vec(&asked).map_err(|e| e.to_string())?, Some(serde_json::to_vec(&check_context).map_err(|e| e.to_string())?)).await?;
    let answer: Value = serde_json::from_slice(&reply).map_err(|error| format!("The approval check of step {step} did not answer with JSON: {error}"))?;
    if answer["$kind"] == NOT_ANSWERED_YET { return Ok(Some(answer)); }

    let Some(rows) = answer["rows"].as_array() else {
        return Err(format!("The approval check of step {step} answered without rows, so nothing was decided."));
    };
    let Some(row) = rows.first() else { return Ok(None) };
    if row["refused"] == true {
        return Err(format!("Step {step} is refused by the owner's approval rule ({}): {}, so the person is not asked.",
            row["setting_id"].as_str().unwrap_or_default(), row["reason"].as_str().unwrap_or_default()));
    }
    if row["covered"] != true { return Ok(None); }
    let decision_id = row["decision_id"].as_str().ok_or_else(|| format!("The approval check of step {step} is auto but wrote no decision row."))?;
    Ok(Some(json!({
        "decision": "approved",
        "approved_how": "auto-setting",
        "approved_by": row["person"],
        "setting_id": row["setting_id"],
        "reason": row["reason"],
        "decision_id": decision_id,
        "decided_by": decision_id,
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
        json!({ "columns": ["person", "covered", "setting_id", "reason", "decision_id"], "rows": [{
            "person": "test-person", "covered": true, "setting_id": "approval_setting:test-person:proof-auto-scope", "reason": "lane approval-check proof", "decision_id": "d-1"
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
    async fn an_approval_that_names_no_credential_is_refused() {
        let context = json!({ "step_id": "keep-clip", "approval": { "scope": "s" } });
        assert!(settle(&host(auto_row()), "anyone", &context).await.is_err());
    }

    #[tokio::test]
    async fn an_approval_with_no_scope_or_approver_is_settled_from_the_master_scope() {
        let context = json!({ "step_id": "keep-clip", "approval": { "credential_name": "c" } });
        let answer = settle(&host(auto_row()), "anyone", &context).await.unwrap().expect("settled");
        assert_eq!(answer["approved_how"], "auto-setting");
    }

    #[tokio::test]
    async fn an_excluded_or_unrecognised_kind_is_never_auto_decided() {
        let closed = json!({ "columns": ["covered"], "rows": [{ "person": "test-person", "covered": false, "setting_id": "approval_kind:payment", "reason": "approval_kind payment always asks", "decision_id": null }], "row_count": 1 });
        let context = json!({ "step_id": "keep-clip", "approval": { "credential_name": "c", "kind": "payment" } });
        assert!(settle(&host(closed), "anyone", &context).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_named_persons_ask_is_settled_and_names_its_decision() {
        let settings = host(auto_row());
        let answer = settle(&settings, "person:test-person", &approval_context()).await.unwrap().expect("settled");
        assert_eq!((&answer["decided_by"], &answer["decision_id"]), (&json!("d-1"), &json!("d-1")));
        assert_eq!(*settings.asked.lock().unwrap(), vec![CHECK_TOOL.to_string()], "no task was given");
    }

    /// The asked person goes to the rule, which makes another person's ask the kind another-person-consent (never auto);
    /// an ask with no declared approval is never gated, whatever its words.
    #[tokio::test]
    async fn an_ask_naming_another_person_reaches_the_rule_as_that_person_and_is_given() {
        struct Recorded { asked: Mutex<Vec<Value>> }
        #[async_trait::async_trait]
        impl Host for Recorded {
            async fn ask(&self, name: &str, payload: Vec<u8>, _: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
                if name == CHECK_TOOL { self.asked.lock().unwrap().push(serde_json::from_slice(&payload).unwrap()); }
                let closed = json!({ "rows": [{ "person": "test-person", "covered": false, "setting_id": "approval_kind:another-person-consent",
                    "reason": "approval_kind another-person-consent always asks", "decision_id": null, "refused": false }], "row_count": 1 });
                Ok(serde_json::to_vec(&closed).unwrap())
            }
            async fn read(&self, _: &str) -> Result<Vec<u8>, String> { Ok(b"{}".to_vec()) }
        }
        let recorded = Recorded { asked: Mutex::new(vec![]) };
        assert!(settle(&recorded, "person:a-friend", &approval_context()).await.unwrap().is_none(), "given, never auto-answered");
        let asked = recorded.asked.lock().unwrap();
        assert_eq!(asked[0]["params"][5], json!("a-friend"), "the asked person is the rule's to compare");
        assert!(asked[0]["sql"].as_str().unwrap().contains("'another-person-consent'"));
        let words_only = json!({ "step_id": "pay", "do": "Ask the person to pay with their card" });
        assert!(settle(&host(auto_row()), "person:test-person", &words_only).await.unwrap().is_none(), "no declared approval, no gate");
    }

    #[tokio::test]
    async fn a_rule_that_refuses_fails_the_step_in_words() {
        let refused = json!({ "rows": [{ "person": "test-person", "covered": false, "setting_id": "approval_setting:test-person:*",
            "reason": "the grant for this purpose was withdrawn", "decision_id": null, "refused": true }], "row_count": 1 });
        let said = settle(&host(refused), "anyone", &approval_context()).await.expect_err("refused");
        assert!(said.contains("refused") && said.contains("withdrawn"), "{said}");
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
