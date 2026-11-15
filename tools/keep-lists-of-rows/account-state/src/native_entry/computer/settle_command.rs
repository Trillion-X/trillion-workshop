//! Writer-side execution of a device's pending settle command. The original
//! door remains the sole command admission and commit owner.
use super::*;
use crate::account::computers::copies::{
    pending::{Command, Terminal},
    Copies,
};
use crate::account::NativeAccountOwner as _;
impl Computer {
    pub(super) fn install_pending_writer(
        &self,
        account: &ComputerAccount,
        copies: &std::sync::Arc<Copies>,
    ) {
        let app = account.app.clone();
        let address = account.address.clone();
        let public_origin = self.config.public_origin.clone();
        let executor = self.executor.handle().clone();
        let owner = account.owner.clone();
        let sign_in = account.sign_in.clone();
        let copies_weak = std::sync::Arc::downgrade(copies);
        copies.set_pending_handler(std::sync::Arc::new(move |command: &Command| {
            use tower::ServiceExt as _;
            // The outer proof proves the sending computer only. Nothing in it
            // grants account rights, nor may a sealed payload select another
            // command or principal than the identity kept by the device.
            let operation =
                crate::mcp::parse_operation(command.request.get("params")?.get("arguments")?).ok()?;
            // A system command carries the computer's signed credential instead of a person's bearer: it is verified against the
            // account's computers row below, never admitted as a person.
            let system = command.bearer.starts_with(crate::account::computers::COMMAND_PROOF_PREFIX);
            // A command this handler cannot answer as sent is refused under its own key, never left pending: a pending entry
            // blocks every later command of the account (`settle_pending` runs in order).
            if let Some(mismatch) = settle_mismatch(command, &operation, system, &address) {
                crate::quiet_eprintln!("command-settle-refused field={} resource={} operation={} request_key={}",
                    mismatch.field(), command.resource, command.operation, command.request_key);
                return Some(known_refusal(command, "command_settle_mismatch", mismatch.cause()));
            }
            if system && !copies_weak.upgrade().is_some_and(|copies| system_command_verified(command, &copies.row())) {
                return Some(known_refusal(command, "current_workspace_rights_refused", crate::cause!()));
            }
            // A verified computer's queued held-value write (`Secrets::put_as` or `Secrets::remove_as` at a computer that is not the
            // writer): the sealed input is opened with this computer's key and the same write runs in the account's vault. Nothing
            // else of the command is read.
            if system && crate::secrets::queued_held_operation(&command.operation) {
                let settled: Result<serde_json::Value, (&'static str, crate::refusal_cause::Cause)> = (|| {
                    use base64::Engine as _;
                    let copies = copies_weak.upgrade().ok_or_else(|| ("held_put_refused", crate::cause!()))?;
                    let (account, state_root) = {
                        let selected = owner.lock().map_err(|_| ("held_put_refused", crate::cause!()))?;
                        (selected.account().owner_id, selected.state_root().to_owned())
                    };
                    sealed_put_admitted(copies.is_writer(), &command.owner, &account)?;
                    let sealed = command.input.get("sealed").and_then(serde_json::Value::as_str)
                        .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok())
                        .ok_or_else(|| ("held_put_refused", crate::cause!()))?;
                    let key = copies.computer_key().ok_or_else(|| ("held_put_refused", crate::cause!()))?;
                    let vault = crate::secrets::open_home(&state_root, &account).map_err(|error| ("held_put_refused", error.cause()))?;
                    let id_context = &crate::account::computers::settings().computer_id_context;
                    let body = if command.operation == crate::secrets::HELD_VALUES_PUT_SEALED {
                        vault.settle_sealed_put(&key, id_context, &sealed).map(|()| serde_json::json!({"held": true}))
                    } else {
                        vault.settle_sealed_remove(&key, id_context, &sealed).map(|removed| serde_json::json!({"removed": removed}))
                    };
                    body.map_err(|error| ("held_put_refused", error.cause()))
                })();
                return Some(match settled {
                    Ok(body) => Terminal { cause: crate::cause!(), status: 200, body, refused: false },
                    Err((code, cause)) => known_refusal(command, code, cause),
                });
            }
            let principal = match sign_in.authenticate(command.bearer.as_bytes()) {
                Ok(principal) => principal,
                Err(crate::mcp::http::AuthenticationFailure::Unauthorized(_)) => {
                    return Some(known_refusal(command, "settle_unauthorized", crate::cause!(tokens: settle_unauthorized)));
                }
                Err(
                    crate::mcp::http::AuthenticationFailure::Unavailable(_)
                    | crate::mcp::http::AuthenticationFailure::UnavailableWord(_, _),
                ) => return None,
            };
            if command.operation == "records:write" && principal.sign_in != command.sign_in {
                return Some(known_refusal(command, "client_not_authorized", crate::cause!()));
            }
            match sign_in.admitted(
                command.bearer.as_bytes(),
                &principal,
                &operation.resource,
                &operation.operation,
            ) {
                Ok(_) => {}
                Err(crate::account::account_routes::Refusal::Unavailable(_)) => return None,
                Err(error) => {
                    return Some(known_refusal(command, "current_workspace_rights_refused", error.cause()))
                }
            }
            let mut selected = owner.lock().ok()?;
            selected.assert_source_current().ok()?;
            let (generation, scope) =
                match selected.pending_records_source(&operation.input, &command.owner) {
                    Ok(scope) => scope,
                    Err(error @ (
                        crate::local_account::record_writer::Error::Invalid(_)
                        | crate::local_account::record_writer::Error::Conflict(_)
                        | crate::local_account::record_writer::Error::Refused(_)
                    )) => return Some(known_refusal(command, "original_command_conflict", error.cause())),
                    Err(_) => return None,
                };
            if generation != command.source_generation || scope != command.scope {
                return Some(known_refusal(command, "original_command_conflict", crate::cause!()));
            }
            let witness = crate::mcp::AcceptedCommandSource::new(
                &command.owner,
                &command.resource,
                &command.request_key,
                command.source_generation,
            );
            let witness = if system { witness.system(&command.bearer) } else { witness };
            let origin = url::Url::parse(&public_origin).ok()?;
            let host = match origin.port() {
                Some(port) => format!("{}:{port}", origin.host_str()?),
                None => origin.host_str()?.to_owned(),
            };
            let request = axum::http::Request::builder()
                .method("POST")
                .uri("/mcp")
                .header(axum::http::header::HOST, host)
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {}", command.bearer),
                )
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::ACCEPT,
                    "application/json, text/event-stream",
                )
                .extension(witness)
                .body(axum::body::Body::from(
                    serde_json::to_vec(&command.request).ok()?,
                ))
                .ok()?;
            let app = app.clone();
            executor.block_on(async move {
                let response = app.oneshot(request).await.ok()?;
                let status = response.status().as_u16();
                let response_cause = response.headers().get("x-trillion-refusal-cause")
                    .and_then(|value| value.to_str().ok())
                    .and_then(crate::refusal_cause::Cause::from_wire);
                let bytes = axum::body::to_bytes(response.into_body(), crate::mcp::request_bytes())
                    .await
                    .ok()?;
                let body = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
                // A known refusal is terminal and preserved as such. An actual
                // unknown outcome remains pending under its original key.
                if status >= 500
                    || body
                        .pointer("/result/structuredContent/outcome")
                        .and_then(|v| v.as_str())
                        == Some("unknown")
                {
                    return None;
                }
                let committed = body
                    .pointer("/result/structuredContent/outcome")
                    .and_then(|value| value.as_str())
                    == Some("committed");
                let refused = !committed
                    && (status >= 400
                        || body
                            .pointer("/result/isError")
                            .and_then(|value| value.as_bool())
                            == Some(true)
                        || body.get("error").is_some());
                let cause = body.pointer("/result/structuredContent/cause")
                    .or_else(|| body.pointer("/error/data/cause"))
                    .or_else(|| body.get("cause"))
                    .and_then(serde_json::Value::as_str)
                    .and_then(crate::refusal_cause::Cause::from_wire)
                    .or(response_cause)
                    .unwrap_or_else(|| crate::cause!(settle_reply origin_unrecorded));
                Some(Terminal { cause, status, body, refused })
            })
        }));
    }
}

/// Use the ordinary encoder for a source-qualified no-effect refusal.
#[track_caller]
/// The first field of a queued command that the settle handler cannot answer as sent (`None` when every field matches).
fn settle_mismatch(
    command: &Command,
    operation: &crate::mcp::Operation,
    system: bool,
    address: &str,
) -> Option<SettleMismatch> {
    if operation.resource != command.resource {
        return Some(SettleMismatch::Resource);
    }
    if operation.operation != command.operation {
        return Some(SettleMismatch::Operation);
    }
    if operation.request_key != command.request_key {
        return Some(SettleMismatch::RequestKey);
    }
    if operation.person_present != command.person_present {
        return Some(SettleMismatch::PersonPresent);
    }
    if !system && crate::account::signed_in::claimed_account(&command.bearer).as_deref() != Some(address) {
        return Some(SettleMismatch::BearerAddress);
    }
    None
}

/// Which field of a queued command did not match (`settle_mismatch`), named in the refusal's cause and its event line.
enum SettleMismatch {
    Resource,
    Operation,
    RequestKey,
    PersonPresent,
    BearerAddress,
}

impl SettleMismatch {
    fn field(&self) -> &'static str {
        match self {
            Self::Resource => "resource",
            Self::Operation => "operation",
            Self::RequestKey => "request_key",
            Self::PersonPresent => "person_present",
            Self::BearerAddress => "bearer_address",
        }
    }

    fn cause(&self) -> crate::refusal_cause::Cause {
        match self {
            Self::Resource => crate::cause!(tokens: settle_mismatch_resource),
            Self::Operation => crate::cause!(tokens: settle_mismatch_operation),
            Self::RequestKey => crate::cause!(tokens: settle_mismatch_request_key),
            Self::PersonPresent => crate::cause!(tokens: settle_mismatch_person_present),
            Self::BearerAddress => crate::cause!(tokens: settle_mismatch_bearer_address),
        }
    }
}

fn known_refusal(command: &Command, code: &str, cause: crate::refusal_cause::Cause) -> Terminal {
    struct Refused { code: String, cause: crate::refusal_cause::Cause }
    impl crate::mcp::CallAnswerer for Refused {
        fn invoke(
            &self,
            _: &crate::mcp::Principal,
            _: crate::mcp::Operation,
        ) -> Result<serde_json::Value, crate::mcp::OperationFailure> {
            Err(crate::mcp::OperationFailure {
                code: self.code.clone(),
                cause: self.cause.clone(),
                outcome_unknown: false,
                detail: Some(serde_json::json!({"cause": self.cause.id()})),
            })
        }
    }
    let principal = crate::mcp::Principal { kind: crate::mcp::PrincipalKind::Person,        account_id: command.owner.clone(),
        sign_in: command.sign_in.clone(),
        client_id: String::new(),
    };
    let bytes = serde_json::to_vec(&command.request).unwrap_or_default();
    let body =
        crate::mcp::handle_message(&bytes, Some(&principal), Some(&Refused { code: code.to_owned(), cause: cause.clone() }))
            .unwrap_or(serde_json::Value::Null);
    Terminal {
        cause,
        status: 200,
        body,
        refused: true,
    }
}

/// Whether this copy may settle a queued put (`Secrets::put_as` at a computer that is not the writer). Only the writer settles:
/// a copy that is not the writer would queue it again to the writer, and the command would go back and forth. The command must
/// also belong to this copy's account. Answers the refusal code, or `Ok`.
fn sealed_put_admitted(is_writer: bool, command_owner: &str, account: &str) -> Result<(), (&'static str, crate::refusal_cause::Cause)> {
    if !is_writer {
        return Err(("held_put_not_writer", crate::cause!()));
    }
    if command_owner != account {
        return Err(("held_put_other_account", crate::cause!()));
    }
    Ok(())
}

#[cfg(test)]
mod sealed_put_admitted_tests {
    use super::sealed_put_admitted;

    #[test]
    fn only_the_writer_settles_a_queued_put_and_only_for_its_own_account() {
        let code = |is_writer, owner| sealed_put_admitted(is_writer, owner, "account-a").err().map(|(code, _)| code);
        assert_eq!(code(false, "account-a"), Some("held_put_not_writer"), "a copy that is not the writer does not settle");
        assert_eq!(code(true, "account-b"), Some("held_put_other_account"), "another account's command is refused");
        assert_eq!(code(true, "account-a"), None, "the writer settles its own account's command");
    }
}

/// Whether a system command is one its computer made: its credential names a computer the account\x27s computers row names,
/// the command is a write the `system_principal` DATA allows, and the credential verifies over the command\x27s own parts.
fn system_command_verified(command: &Command, row: &crate::account::computers::ComputersRow) -> bool {
    let Some((computer, at, signature)) = crate::account::computers::read_command_credential(&command.bearer) else {
        return false;
    };
    if !crate::account::computers::names_computer(row, &computer) {
        return false;
    }
    let parts = crate::account::computers::command_parts(
        &command.owner,
        &command.resource,
        &command.operation,
        &command.request_key,
        command.source_generation,
        &command.input,
    );
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    let now = crate::account::rows::now_ms() as i64;
    crate::storage::record_store_resources::declares(&command.resource)
        && crate::account::computers::system_permits(&command.resource, &command.operation, &command.input)
        && crate::account::computers::verify_use("command", &computer, &refs, at, now, &signature)
}

#[cfg(test)]
mod settle_mismatch_tests {
    use super::*;
    use crate::account::computers::copies::pending::{Command, Projection};
    use crate::mcp::Operation;
    use serde_json::json;

    fn queued(input: serde_json::Value, sent: &serde_json::Value) -> Command {
        Command {
            owner: "owner".into(),
            sign_in: "key:test".into(),
            resource: "@own-records".into(),
            operation: "records:write".into(),
            request_key: "claim-key".into(),
            input,
            scope: None,
            source_generation: 1,
            request: json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_resource_operation","arguments":{
                "address":"@own-records","method":"records:write","request_key":"claim-key","input":sent}}}),
            bearer: "PRIVATE_SYNTHETIC_BEARER".into(),
            accepted_at_ms: 1,
            person_present: None,
            checked_kinds: vec!["decision-revision".into()],
            projection: vec![Projection { id: "decision-revision:case".into(), kind: "decision-revision".into(), value: None }],
        }
    }
    fn parsed(sent: &serde_json::Value) -> Operation {
        Operation { resource: "@own-records".into(), operation: "records:write".into(), request_key: "claim-key".into(),
            input: sent.clone(), person_present: None }
    }

    #[test]
    fn a_write_queued_exactly_as_sent_is_not_a_settle_mismatch() {
        let sent = json!({"records":[{"id":"decision-revision:case","type":"decision-revision","value":{"revision":15},
            "expected":{"type":"decision-revision","value":{"revision":14}}}]});
        assert!(settle_mismatch(&queued(sent.clone(), &sent), &parsed(&sent), true, "acct").is_none());
    }

    /// A run's write is stamped with its cause when it is accepted; the caller's request is not. The settle replays the caller's
    /// request through the router, which applies the same narrowing, so the stamped input is not a mismatch.
    #[test]
    fn a_run_stamped_write_queued_for_its_caller_settles_as_the_caller_sent_it() {
        let sent = json!({"records":[{"id":"decision-revision:case","type":"decision-revision","value":{"revision":15},
            "expected":{"type":"decision-revision","value":{"revision":14}}}]});
        let mut stamped = sent.clone();
        stamped["records"][0]["value"]["cause field"] = json!("run-cause-1");
        assert!(settle_mismatch(&queued(stamped, &sent), &parsed(&sent), true, "acct").is_none(),
            "the queued command must settle as its caller sent it");
    }

    /// A command whose identity differs from its accepted request is still refused.
    #[test]
    fn a_command_whose_request_key_differs_from_its_accepted_one_is_refused() {
        let sent = json!({"records":[]});
        let mut other = parsed(&sent);
        other.request_key = "other-key".into();
        assert!(matches!(settle_mismatch(&queued(sent.clone(), &sent), &other, true, "acct"), Some(SettleMismatch::RequestKey)));
    }
}
