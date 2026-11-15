//! Browser writes enter the original selected command owner once, then
//! recover that SAME committed binding under the same owner hold, before any
//! response header is sent. Recovery is readback-only: missing, erased or
//! noncommitted commands never dispatch another effect.
//!
//! Every refusal is decided before the headers, so it answers a closed JSON
//! status carrying the request key, never a reset connection. A deadline or
//! cancellation before the effect answers 503 `original_workspace_source_unavailable`
//! (nothing was written; the same request key may be sent again). One after
//! the effect answers 503 `original_command_outcome_unknown` with `next_call`,
//! the same request replayed under its key, which recovers the committed result.
//! Once the headers are sent, the body is the already-recovered bytes only.
use super::{heads::PermitChunk, CancelReadOnDrop, LocalWorkspace};
use crate::{
    ecma_json,
    local_account::record_writer::{Error, Named},
    record_log::CanonicalLogIds,
    record_write_model::write_command,
    workspace::{SupplyFuture, WorkspaceError, WorkspacePermit},
    workspace_domain::{DomainAnswer, DomainCommand, DomainContext},
    workspace_session::owner_wait,
};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    convert::Infallible,
    pin::Pin,
    task::{Context, Poll},
    time::Instant,
};
use zeroize::Zeroizing;

pub(super) const OPERATION: &str = "workspace:write";
pub(super) fn request(input: &serde_json::Value) -> Result<(), WorkspaceError> {
    if input.is_object() {
        Ok(())
    } else {
        Err(crate::cause!(WorkspaceError::Invalid))
    }
}
/// What a refused records write names to the page, as the MCP door names it (`native_boot::mcp_local::write_refusal`):
/// a value outside its field's choices or moves (and the value a refused move changes from), or what the person present
/// would have to confirm (a fresh sign-in pass, `account::person_present`). The person's own words, to
/// their own page; none of it is logged.
fn named_detail(named: Option<&Named>) -> Option<serde_json::Value> {
    match named? {
        Named::Outside(outside) => Some(outside.detail()),
        Named::NeedsPersonPresent(needed) => Some(serde_json::json!({
            "record": needed.requirement.record, "field": needed.requirement.field, "value": needed.requirement.value,
            "marked_changes": needed.marked_changes,
        })),
    }
}
fn failure(error: Error, command: &DomainCommand) -> Result<DomainAnswer, WorkspaceError> {
    failure_naming(error, command, None)
}
fn failure_naming(error: Error, command: &DomainCommand, named: Option<Named>) -> Result<DomainAnswer, WorkspaceError> {
    let (status, code, unknown) = match error {
        Error::OutcomeUnknown(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "original_command_outcome_unknown",
            true,
        ),
        Error::ProtectedResultUnavailable(_) => {
            (StatusCode::GONE, "original_result_unavailable", false)
        }
        Error::Conflict(_) => (StatusCode::CONFLICT, "original_command_conflict", false),
        Error::Invalid(_) | Error::Bounds(_) => {
            (StatusCode::BAD_REQUEST, "original_input_refused", false)
        }
        Error::Refused(_) => (
            StatusCode::UNAUTHORIZED,
            "current_workspace_rights_refused",
            false,
        ),
        Error::Source(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "original_workspace_source_unavailable",
            false,
        ),
        Error::OutsideChoices(_) => (
            StatusCode::BAD_REQUEST,
            "value_outside_choices",
            false,
        ),
        Error::MoveNotDeclared(_) => (
            StatusCode::BAD_REQUEST,
            "move_not_declared",
            false,
        ),
        // The page's write needs a fresh confirmation by the person present (`account::person_present`).
        Error::NeedsPersonPresent(_) => (
            StatusCode::FORBIDDEN,
            crate::account::person_present::REFUSAL_CODE,
            false,
        ),
        Error::NotMigrated(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "own_records_not_migrated",
            false,
        ),
        // Committed, but its answer is withheld: the outcome is known, so the page never retries it as unknown.
        Error::CommittedAnswerWithheld(_) => (
            StatusCode::CONFLICT,
            "original_command_committed_answer_withheld",
            false,
        ),
    };
    crate::quiet_eprintln!("workspace-refusal code={code} cause={}", error.cause());
    let mut body = serde_json::json!({"error":code,"failure_code":code,"cause":error.cause().id(),"outcome_unknown":unknown,"request_key":command.request_key});
    if let Some(detail) = named_detail(named.as_ref()).filter(|_| matches!(error, Error::OutsideChoices(_) | Error::MoveNotDeclared(_) | Error::NeedsPersonPresent(_))) {
        body["detail"] = detail;
    }
    if unknown {
        body["next_call"] = serde_json::json!({"resource":"@own-records","operation":command.operation,"input":command.input,"request_key":command.request_key});
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(DomainAnswer::Http {
        status,
        headers,
        body: serde_json::to_vec(&body).map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?,
    })
}
/// The recovered response bytes, sent as one chunk while the original
/// cancellation permit is retained. Every refusal was answered before the
/// headers, so nothing here can fail and the connection is never reset.
struct WriteBody {
    bytes: Option<Zeroizing<Vec<u8>>>,
    permit: WorkspacePermit,
}
impl HttpBody for WriteBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let Some(bytes) = self.bytes.take() else {
            return Poll::Ready(None);
        };
        let permit = self.permit.clone();
        Poll::Ready(Some(Ok(Frame::data(Bytes::from_owner(PermitChunk { bytes, _permit: permit })))))
    }
    fn is_end_stream(&self) -> bool {
        self.bytes.is_none()
    }
    fn size_hint(&self) -> SizeHint {
        self.bytes.as_ref().map_or_else(|| SizeHint::with_exact(0), |bytes| SizeHint::with_exact(bytes.len() as u64))
    }
}
impl LocalWorkspace {
    pub(super) fn write_workspace(
        &self,
        context: DomainContext,
        command: DomainCommand,
    ) -> SupplyFuture<DomainAnswer> {
        let owner = self.owner.clone();
        let sessions = self.sessions.clone();
        let admission = self.sessions.admission();
        let commands = self.commands.clone();
        Box::pin(async move {
            request(&command.input)?;
            // Only the account's own record write reads whether the person is present: the page's own session pass,
            // issued within Better Auth's fresh-session age. What the page says is never read.
            let person_present = (write_command::Command::is_shipped(&command.operation)
                && crate::account::browser_session_fresh(&context.session.session_id))
                .then(|| serde_json::json!({"fresh_pass": true}));
            sessions.authorize(context.clone()).await?;
            let deadline = Instant::now() + crate::legacy_records::Bounds::default().elapsed;
            let mut cancellation = CancelReadOnDrop(Some(context.permit.clone()));
            let retained = context.clone();
            let mut carried = command.clone();
            // A page's re-set copies stored values: a run's stamp in one is dropped, as at the MCP door, since no run
            // caused this write.
            if write_command::Command::is_shipped(&carried.operation) {
                crate::account_rights::run_capability::unstamp(&carried.operation, &mut carried.input)
                    .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?;
            }
            let prepared = crate::storage::request_work::spawn_blocking(move || {
                // A write of a kind kept in a home of its own goes to that home (records-routes.json `_homes`,
                // Door::to_home), its `home:` row read as a page read is, before the command owner is taken.
                if write_command::Command::is_shipped(&carried.operation) {
                    let door = crate::record_value::account_routes::Door::shipped()
                        .map_err(|error| (crate::carry_cause!(Error::Source, error), None))?;
                    let mut read_home = |id: &str| super::read_home_row(&owner, &retained, deadline, id);
                    let operation = carried.operation.clone();
                    if !door.to_home(&operation, &mut carried.input, true, &mut read_home)
                        .map_err(|error| (crate::carry_cause!(Error::Source, error), None))? {
                        return Err((crate::cause!(Error::Invalid), None));
                    }
                }
                // Records commands borrow only enough of the independent admission owner to create their own
                // mutable context. The ordinary workspace write keeps its original retained output-custody owner.
                let mut command_owner = if write_command::Command::is_shipped(&carried.operation) {
                    let cached = commands.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                    Some(match cached {
                        Some(owner) => owner,
                        None => {
                            let admitted = owner_wait::acquire(admission.as_ref(), || {
                                retained.permit.cancelled() || Instant::now() >= deadline
                            }).map_err(|error| (crate::carry_cause!(Error::Source, error), None))?;
                            admitted.command_owner().map_err(|error| (crate::carry_cause!(Error::Source, error), None))?
                        }
                    })
                } else { None };
                let mut held_owner = if command_owner.is_none() {
                    Some(owner_wait::acquire(owner.as_ref(), || {
                        retained.permit.cancelled() || Instant::now() >= deadline
                    }).map_err(|error| (crate::carry_cause!(Error::Source, error), None))?)
                } else { None };
                let owner = command_owner.as_mut().or_else(|| held_owner.as_deref_mut())
                    .expect("a command owns either its request context or its retained account hold");
                let mut person_present = person_present;
                let mut written = || -> Result<Zeroizing<Vec<u8>>, Error> {
                    let witness = if write_command::Command::is_shipped(&carried.operation) {
                        owner.prepare_browser_records_write(retained.session.clone(), &carried, retained.permit.cancellation_flag(), deadline,
                            person_present.take()).map_err(|cause| {
                                if matches!(&cause,Error::ProtectedResultUnavailable(_)) {crate::quiet_eprintln!("record-writer event=result-unavailable reason=records-prepare cause={}",cause.cause());}
                                cause
                            })?
                    } else {
                        owner.prepare_browser_workspace_write(retained.session.clone(), &carried, retained.permit.cancellation_flag(), deadline)?
                    };
                    // Nothing has been written yet: a missed deadline is a plain retry.
                    if witness.expired() {
                        return Err(crate::cause!(Error::Source));
                    }
                    // A records command already returns its source-free count receipt after its final current-rights
                    // check on a read snapshot. Returning that receipt needs no second IMMEDIATE transaction.
                    let first = owner.execute_browser_workspace_write(
                        &witness,
                        false,
                        &mut CanonicalLogIds::default(),
                    ).map_err(|cause| {
                        if matches!(&cause,Error::ProtectedResultUnavailable(_)) {crate::quiet_eprintln!("record-writer event=result-unavailable reason=command-execute cause={}",cause.cause());}
                        cause
                    })?;
                    if write_command::Command::is_shipped(&carried.operation) {
                        return ecma_json::stringify(&first.value, Default::default())
                            .map(|text| Zeroizing::new(text.into_bytes()))
                            .map_err(|error| crate::carry_cause!(Error::CommittedAnswerWithheld, error));
                    }
                    // Workspace output retains its original protected-result recovery before disclosure.
                    // The effect may be committed: a missed deadline from here is an
                    // unknown outcome, recovered by replaying the same request key.
                    if witness.expired() {
                        return Err(crate::cause!(Error::OutcomeUnknown));
                    }
                    let answer = owner.execute_browser_workspace_write(
                        &witness,
                        true,
                        &mut CanonicalLogIds::default(),
                    )?;
                    // No account/key/policy/source read follows the writer's final
                    // output permit: only encode its just-recovered value.
                    if !answer.duplicate {
                        return Err(crate::cause!(Error::OutcomeUnknown));
                    }
                    ecma_json::stringify(&answer.value, Default::default())
                        .map(|text| Zeroizing::new(text.into_bytes()))
                        .map_err(|error| crate::carry_cause!(Error::OutcomeUnknown, error))
                };
                let outcome = written();
                // A refused records write names what it refused (a value outside its choices, or what the person present
                // must confirm), taken from the account once, under the same owner hold.
                let answer = outcome.map_err(|error| (error, owner.take_browser_write_refusal()));
                if let Some(request_owner) = command_owner.take() {
                    let mut kept = commands.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if kept.is_none() { *kept = Some(request_owner); }
                }
                answer
            })
            .await;
            let bytes = match prepared {
                Ok(Ok(bytes)) => bytes,
                Ok(Err((error, named))) => {
                    cancellation.0.take();
                    return failure_naming(error, &command, named);
                }
                Err(cause) => {
                    let (code, error) = if cause.is_panic() {
                        ("panic", crate::carry_cause!(Error::OutcomeUnknown, cause))
                    } else {
                        ("cancelled", crate::carry_cause!(Error::OutcomeUnknown, cause))
                    };
                    crate::quiet_eprintln!("record-writer event=unknown reason=worker code={code} cause={}",error.cause());
                    cancellation.0.take();
                    return failure(error, &command);
                }
            };
            let request_key =
                HeaderValue::from_str(&command.request_key).map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
            let mut response = Response::new(Body::new(WriteBody {
                bytes: Some(bytes),
                permit: context.permit.clone(),
            }));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
                .headers_mut()
                .insert(crate::workspace_domain::REQUEST_KEY_HEADER, request_key);
            cancellation.0.take();
            Ok(DomainAnswer::Response(response))
        })
    }
}
