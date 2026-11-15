//! Native-only computer actions of one live run. The request names a source and its exact metadata observation;
//! the native run binding supplies the account, tool, grant, real folder and platform action. No JSON authority is
//! admitted here, and an ordinary personal key cannot call this route directly.

use super::*;
use crate::account_rights::run_capability::Admitted;
use computer_binding::TrashOutcome;
use serde::Deserialize;
use std::path::Path;

/// Add the original native request pause without changing task facts or ordinary session callbacks.
pub(super) struct ParentActionIssuer<'a> {
    pub(super) parent: &'a dyn crate::account_rights::run_capability::Issuer,
    pub(super) current: account_routes::Current,
}
impl crate::account_rights::run_capability::Issuer for ParentActionIssuer<'_> {
    fn issue(&self, records: &serde_json::Value, lifetime: std::time::Duration)
        -> Result<crate::account_rights::run_capability::Issued, crate::account_rights::run_capability::Refusal> {
        self.parent.issue(records, lifetime)
    }
    fn issue_recordless(&self, declaration: &serde_json::Value, lifetime: std::time::Duration)
        -> Result<crate::account_rights::run_capability::Issued, crate::account_rights::run_capability::Refusal> {
        if !(self.current)() { return Err(crate::cause!(crate::account_rights::run_capability::Refusal::NotGranted)); }
        self.parent.issue_recordless(declaration, lifetime)
    }
    fn recovery_source(&self) -> Result<serde_json::Value, crate::account_rights::run_capability::Refusal> {
        if !(self.current)() { return Err(crate::cause!(crate::account_rights::run_capability::Refusal::NotGranted)); }
        let source = self.parent.recovery_source()?;
        if !(self.current)() { return Err(crate::cause!(crate::account_rights::run_capability::Refusal::NotGranted)); }
        Ok(source)
    }
    fn journals_input(&self) -> bool { self.parent.journals_input() }
    fn task_context(&self) -> Option<crate::tool_runs::tools::task_context::Context> { self.parent.task_context() }
    fn computer_current(&self) -> Option<account_routes::Current> { Some(self.current.clone()) }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TrashRequest {
    path: String,
    expected_generation: String,
}

impl TrashRequest {
    fn parse(input: &serde_json::Value) -> Result<Self, OperationFailure> {
        let asked: Self = serde_json::from_value(input.clone())
            .map_err(|_| refusal("original_input_refused", false))?;
        if asked.path.is_empty() || asked.path.len() > 4096 || asked.path.contains('\0')
            || !Path::new(&asked.path).is_absolute() || asked.expected_generation.is_empty()
            || asked.expected_generation.len() > 16 * 1024 * 1024 {
            return Err(refusal("original_input_refused", false));
        }
        Ok(asked)
    }
}

impl LocalSelectedMcp {
    /// Called only for the exact shipped computer-action route, before ordinary records narrowing. The proof's
    /// current source is the original run admission; the callback's own cancellation/deadline can only shorten it.
    pub(super) fn computer_action_at(principal: &Principal, bearer: &[u8], call: &Operation, run: Option<&Admitted>,
        disclosure: &crate::mcp::RequestDisclosure, parent_current: account_routes::Current,
        deadline_override: Option<Instant>) -> Result<serde_json::Value, OperationFailure> {
        if call.request_key.is_empty() || call.request_key.encode_utf16().count() > 512 {
            return Err(refusal("original_input_refused", false));
        }
        let run = run.ok_or_else(|| refusal("current_workspace_rights_refused", false))?;
        let asked = TrashRequest::parse(&call.input)?;
        let cancel = disclosure.cancellation_flag();
        let limit = disclosure.started_at() + crate::legacy_records::Bounds::default().elapsed;
        let deadline = deadline_override.map_or(limit, |deadline| deadline.min(limit));
        let current: account_routes::Current = Arc::new(move || !cancel.load(std::sync::atomic::Ordering::Acquire)
            && Instant::now() < deadline && parent_current());
        let outcome = run.trash_source(principal, &call.request_key, Path::new(&asked.path), &asked.expected_generation, &*current)
            .map_err(|error| OperationFailure { cause: error.cause(), ..refusal("current_workspace_rights_refused", false) })?;
        match outcome {
            TrashOutcome::Moved if current() => {
                let proof = run.duplicate();
                let actor = principal.clone();
                let source = std::path::PathBuf::from(asked.path);
                let generation = asked.expected_generation;
                let callback_key = call.request_key.clone();
                let output_current = Arc::new(move || proof.computer_action_current(&actor, &callback_key, &source, &generation, &*current));
                disclosure.register_current(principal, bearer, output_current)
                    .map_err(|error| OperationFailure { cause: error.cause(), ..refusal("computer_action_unknown", true) })?;
                Ok(serde_json::json!({"outcome":"moved"}))
            }
            TrashOutcome::Refused => Err(refusal("computer_action_refused", false)),
            TrashOutcome::Moved | TrashOutcome::Unknown => Err(refusal("computer_action_unknown", true)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_actual_action_handler_refuses_raw_credentials_and_record_only_runs() {
        use crate::account_rights::run_capability::{self, Rights, RunOf};
        let account = "8a".repeat(32);
        let principal = Principal { kind: crate::mcp::PrincipalKind::Person, account_id: account.clone(), sign_in: "key:synthetic-parent-action".into(),
            client_id: String::new() };
        let (resource, operation) = crate::tool_runs::tools::computer::shipped().unwrap().trash_source_route();
        let call = Operation { person_present: None, resource: resource.into(), operation: operation.into(),
            request_key: "synthetic-parent-action".into(), input: json!({"path":"/synthetic/source","expected_generation":"[]"}) };
        let disclosure = crate::mcp::RequestDisclosure::default();
        let invoke = |run| LocalSelectedMcp::computer_action_at(&principal, b"synthetic-run", &call, run, &disclosure, Arc::new(|| true), None);
        assert_eq!(invoke(None).unwrap_err().code, "current_workspace_rights_refused");
        let read = crate::record_value::account_routes::Door::shipped().unwrap().read_operation();
        let rights = Rights::declared(&json!({"fd":3,"rights":[{"kind":"note","operations":[read]}]})).unwrap();
        let capability = run_capability::mint(&account, b"synthetic-parent", rights, None, Duration::from_secs(60)).unwrap();
        capability.bind_run(RunOf { tool:"synthetic-computer-tool".into(),request_key:"synthetic-run".into() }).unwrap();
        let run = run_capability::held(capability.token().as_bytes()).unwrap().unwrap();
        assert_eq!(invoke(Some(&run)).unwrap_err().code, "current_workspace_rights_refused");
    }

    #[test]
    fn child_requests_carry_only_an_absolute_source_and_its_exact_observation() {
        let valid = json!({"path":"/synthetic/folder/source", "expected_generation":"[[\"\",\"1\"]]"});
        assert!(TrashRequest::parse(&valid).is_ok());
        for field in ["account", "tool", "request_key", "grant", "scope", "capability", "actor"] {
            let mut forged = valid.clone();
            forged[field] = json!("forged");
            assert!(TrashRequest::parse(&forged).is_err(), "child-supplied {field} is not authority");
        }
        for path in ["", "relative/source", "/synthetic/with\0nul"] {
            let mut invalid = valid.clone();
            invalid["path"] = json!(path);
            assert!(TrashRequest::parse(&invalid).is_err());
        }
    }
}

#[cfg(test)]
#[path = "../../tests/native_computer_actions/sdk_controls.rs"]
mod sdk_controls;
