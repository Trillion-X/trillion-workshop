//! Local acceptance of a record command while another computer holds its writer turn.
//!
//! Ports old trillion `src/workspace/quiet-writes.ts` at b8b022848c:601-613
//! (keep the full command before sending), :682-693 (restore pending commands),
//! :747-758 (one unchanged retry key), and :798-816 (known refusal versus retry).
//! Copies owns durability and delivery through its existing settle messages. This
//! adapter owns only the local MCP boundary and the caller's provisional view.
//!
//! Cached sign-in rows admit only this caller's local queue and its own overlay.
//! They never authorize a canonical write, another resource, or a remote read.
//! The writer repeats its current sign-in and native command checks at settle.
//! Nothing here changes account membership or the writer term.

use super::{Computer, ComputerAccount};
use crate::{
    account::computers::copies::{
        pending::{Command, Projection, Terminal},
        Copies,
    },
    account_rights::run_capability,
    mcp::{
        self,
        http::{AuthenticationFailure, BearerAuthenticator},
        CallAnswerer, Operation, OperationFailure, Principal,
    },
    record_write_model::write_command,
    storage::record_store_resources::domains,
};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Request,
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Router,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
    time::Instant,
};
use zeroize::Zeroizing;

/// This layer is mounted only on the hosting app's loopback door, before its
/// ordinary sign-in adapter and inside its parent's credential conversion.
/// Requests outside this exact local queue seam continue to the ordinary door.
pub(crate) fn layer(router: Router, computer: Arc<Computer>, expected_host: String) -> Router {
    router.layer(axum::middleware::from_fn(
        move |request: Request, next: Next| {
            let (computer, expected_host) = (computer.clone(), expected_host.clone());
            async move { dispatch(computer, expected_host, request, next).await }
        },
    ))
}

/// The MCP endpoint of this computer's account: the bare `/mcp` this door has always served, and `/a/<address>/mcp`,
/// the path a tool run's descriptor names (account_rights/run_capability.rs `door_url`). Both are the same endpoint.
fn serves_mcp(path: &str, address: &str) -> bool {
    path == "/mcp" || path.strip_prefix("/a/").and_then(|rest| rest.strip_suffix("/mcp")) == Some(address)
}

fn unique_header(headers: &HeaderMap, name: HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?;
    if values.next().is_some() {
        return None;
    }
    first.to_str().ok()
}

fn response(reply: mcp::http::Response) -> Response {
    let content_type = reply.content_type();
    let cache_control = reply.cache_control();
    let authenticate = reply.www_authenticate;
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let cause = reply.cause.clone();
    let mut answer = (status, Body::from(reply.body.unwrap_or_default())).into_response();
    answer.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    if let Some(content_type) = content_type {
        answer
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    }
    if status.is_client_error() || status.is_server_error() {
        crate::quiet_eprintln!("pending-refusal status={} cause={cause}", status.as_u16());
        answer.headers_mut().insert("x-trillion-refusal-cause", HeaderValue::from_str(&cause.id()).expect("source identity is a header value"));
    }
    if authenticate {
        answer
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    answer
}

fn plain_refusal(status: StatusCode, cause: crate::refusal_cause::Cause) -> Response {
    crate::quiet_eprintln!("pending-refusal status={} cause={cause}", status.as_u16());
    let mut answer = status.into_response();
    answer.headers_mut().insert("x-trillion-refusal-cause", HeaderValue::from_str(&cause.id()).expect("source identity is a header value"));
    answer
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    answer
}

#[track_caller]
fn unavailable() -> Response { plain_refusal(StatusCode::SERVICE_UNAVAILABLE, crate::refusal_cause::Cause::from_caller()) }

/// Looking at the operation only chooses whether this adapter has work. The
/// shared MCP parser and HTTP preflight still admit and encode the actual call.
fn local_operation(body: &[u8]) -> Option<(Value, Option<Operation>)> {
    let request: Value = serde_json::from_slice(body).ok()?;
    if request.get("jsonrpc")?.as_str()? != "2.0" {
        return None;
    }
    let method = request.get("method")?.as_str()?;
    // A client must reach the queue after relaunch, including when copied
    // sign-in freshness has ended. These standard protocol replies contain
    // only the shared tool contract; this answerer reads no account records.
    if ["initialize", "ping", "tools/list"].contains(&method) {
        return Some((request, None));
    }
    if method != "tools/call"
        || request.get("params")?.get("name")?.as_str()? != "run_resource_operation"
    {
        return None;
    }
    let operation = mcp::parse_operation(request.get("params")?.get("arguments")?).ok()?;
    if operation.resource != "@own-records"
        || !(write_command::Command::is_shipped(&operation.operation)
            || operation.operation == "records:read")
    {
        return None;
    }
    // Historical and shaped reads belong to the canonical reader. An overlay
    // is only a current whole-root view of a command this caller kept here.
    if operation.operation == "records:read"
        && operation.input.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|field| !["id", "type", "scope", "after_byte", "at"].contains(&field.as_str()))
        })
    {
        return None;
    }
    if operation.operation == "records:read"
        && operation.input.get("at").is_some_and(|at| !at.is_null())
    {
        return None;
    }
    Some((request, Some(operation)))
}

async fn dispatch(
    computer: Arc<Computer>,
    expected_host: String,
    request: Request,
    next: Next,
) -> Response {
    let Some(account) = computer.hosted_account() else {
        return next.run(request).await;
    };
    if !serves_mcp(request.uri().path(), account.address()) {
        return next.run(request).await;
    }
    let Some(copies) = account.copies().cloned() else {
        return next.run(request).await;
    };
    // Returning writer turns still owe retained command receipts and local
    // projections. A fresh held-writer write may use the ordinary path only
    // after this caller's identity and the queue frontier have been checked.

    // Preserve the local Host/Origin fence before retaining any credential or
    // proposed record value. The shared preflight below repeats these checks.
    if request.method() != axum::http::Method::POST {
        return plain_refusal(StatusCode::METHOD_NOT_ALLOWED, crate::cause!());
    }
    if unique_header(request.headers(), header::HOST)
        .is_none_or(|host| !host.eq_ignore_ascii_case(&expected_host))
    {
        return plain_refusal(StatusCode::MISDIRECTED_REQUEST, crate::cause!());
    }
    if request.headers().contains_key(header::ORIGIN) {
        return plain_refusal(StatusCode::FORBIDDEN, crate::cause!());
    }
    let (parts, body) = request.into_parts();
    let body = match tokio::time::timeout(
        crate::legacy_records::Bounds::default().elapsed,
        to_bytes(body, mcp::request_bytes()),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return response(mcp::http::too_large_problem()),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let Some((original, operation)) = local_operation(&body) else {
        return next.run(Request::from_parts(parts, Body::from(body))).await;
    };
    let host = unique_header(&parts.headers, header::HOST)
        .unwrap_or("")
        .to_owned();
    let content_type = unique_header(&parts.headers, header::CONTENT_TYPE).map(str::to_owned);
    let accept = unique_header(&parts.headers, header::ACCEPT).map(str::to_owned);
    let authorization: Vec<Zeroizing<Vec<u8>>> = parts
        .headers
        .get_all(header::AUTHORIZATION)
        .iter()
        .map(|value| Zeroizing::new(value.as_bytes().to_vec()))
        .collect();
    let method = parts.method.as_str().to_owned();
    let path = "/mcp".to_owned();
    let origin = parts.headers.contains_key(header::ORIGIN);
    let fallback_body = body.clone();
    let fallback_parts = parts.clone();
    let fallback_host = expected_host.clone();
    let read_fallback = operation
        .as_ref()
        .filter(|call| call.operation == "records:read")
        .map(|call| {
            (
                account.clone(),
                copies.clone(),
                original.clone(),
                call.clone(),
            )
        });
    let checked = crate::storage::request_work::spawn_blocking(move || {
        let authenticate = run_capability::Authenticator::new(CachedLocal {
            account: account.clone(),
        });
        let answerer = LocalPending {
            account,
            copies,
            original,
            operation,
        };
        let authorizations = authorization
            .iter()
            .map(|value| value.as_slice())
            .collect::<Vec<_>>();
        mcp::http::handle(
            mcp::http::Request {
                method: &method,
                path: &path,
                host: &host,
                expected_host: &expected_host,
                origin_present: origin,
                authorization: &authorizations,
                content_type: content_type.as_deref(),
                accept: accept.as_deref(),
                body: &body,
            },
            Some(&authenticate),
            Some(&answerer),
        )
    })
    .await;
    match checked {
        Ok(reply) => {
            // No value from this caller's queue: keep the ordinary local read
            // path, including its current copied sign-in and canonical source.
            let code = reply.body.as_deref()
                .and_then(|body| serde_json::from_slice::<Value>(body).ok())
                .and_then(|body| body.pointer("/result/structuredContent/code").and_then(Value::as_str).map(str::to_owned));
            if code.as_deref() == Some("local_command_use_writer") {
                return next.run(Request::from_parts(parts, Body::from(fallback_body))).await;
            }
            let absent = reply
                .body
                .as_deref()
                .and_then(|body| serde_json::from_slice::<Value>(body).ok())
                .and_then(|body| {
                    body.get("result")?
                        .get("structuredContent")?
                        .get("code")?
                        .as_str()
                        .map(str::to_owned)
                })
                .as_deref()
                == Some("local_record_unavailable");
            if absent {
                let local = next.run(Request::from_parts(
                    parts,
                    Body::from(fallback_body.clone()),
                ));
                match read_fallback {
                    Some(read) => {
                        local_then_writer(local, remote_read(read, fallback_parts, fallback_body, fallback_host)).await
                    }
                    None => local.await,
                }
            } else if reply.status == 401 {
                // The pending queue's check knows only the copied sign-in, so a credential it refuses is asked of the
                // ordinary local door first (a share bearer is admitted there, by its sharer's sharing records now);
                // only when that refuses too is the credential tried at the actual writer.
                if let Some(read) = read_fallback {
                    let local = next.run(Request::from_parts(
                        parts,
                        Body::from(fallback_body.clone()),
                    ));
                    local_then_writer(local, remote_read(read, fallback_parts, fallback_body, fallback_host)).await
                } else {
                    response(reply)
                }
            } else {
                response(reply)
            }
        }
        Err(_) => unavailable(),
    }
}

/// Whether an answer says the credential was refused (the one comparison the local-then-writer order turns on).
fn credential_refused(status: StatusCode) -> bool {
    status == StatusCode::UNAUTHORIZED
}

/// The one order a credential the pending queue's check refused is tried in: the ordinary local door first (a share bearer
/// is admitted there, by its sharer's sharing records now), and only a refusal from it goes on to the actual writer.
/// `writer` is not polled unless `local` refused the credential.
async fn local_then_writer(
    local: impl std::future::Future<Output = Response>,
    writer: impl std::future::Future<Output = Response>,
) -> Response {
    let canonical = local.await;
    if credential_refused(canonical.status()) {
        return writer.await;
    }
    canonical
}

/// A key issued at the writer after this computer stopped receiving sign-in
/// rows can still read through the original local door. This uses the same
/// caller-authorized settle seam, without queueing a write or trusting cached
/// rights. Only the actual writer authenticates this read's credential.
async fn remote_read(
    (account, copies, original, operation): (Arc<ComputerAccount>, Arc<Copies>, Value, Operation),
    parts: axum::http::request::Parts,
    body: Bytes,
    expected_host: String,
) -> Response {
    let answered_by = Arc::new(Mutex::new(None::<String>));
    let answer_note = answered_by.clone();
    let checked = crate::storage::request_work::spawn_blocking(move || {
        let host = unique_header(&parts.headers, header::HOST).unwrap_or("");
        let authorization: Vec<Zeroizing<Vec<u8>>> = parts
            .headers
            .get_all(header::AUTHORIZATION)
            .iter()
            .map(|value| Zeroizing::new(value.as_bytes().to_vec()))
            .collect();
        let authorizations = authorization
            .iter()
            .map(|value| value.as_slice())
            .collect::<Vec<_>>();
        let authenticate = AddressedRead {
            account: account.clone(),
        };
        let terminal_http = Arc::new(Mutex::new(None));
        let answerer = RemoteRead {
            pending: LocalPending {
                account,
                copies,
                original,
                operation: Some(operation),
            },
            terminal_http: terminal_http.clone(),
            answered_by: answer_note,
        };
        let checked = mcp::http::handle(
            mcp::http::Request {
                method: parts.method.as_str(),
                path: parts.uri.path(),
                host,
                expected_host: &expected_host,
                origin_present: parts.headers.contains_key(header::ORIGIN),
                authorization: &authorizations,
                content_type: unique_header(&parts.headers, header::CONTENT_TYPE),
                accept: unique_header(&parts.headers, header::ACCEPT),
                body: &body,
            },
            Some(&authenticate),
            Some(&answerer),
        );
        let terminal = terminal_http
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        match terminal {
            Some(terminal) => mcp::http::Response {
                cause: terminal.cause(),
                status: terminal.status,
                body: mcp::encode_bounded(&terminal.body),
                www_authenticate: terminal.status == 401,
            },
            None => checked,
        }
    })
    .await;
    match checked {
        Ok(reply) => {
            let mut reply = response(reply);
            if let Some(computer) = answered_by
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
            {
                if let Ok(value) = HeaderValue::from_str(computer) {
                    reply.headers_mut().insert(
                        crate::account::computers::settings()
                            .answered_by_header
                            .as_str(),
                        value,
                    );
                }
            }
            reply
        }
        Err(_) => unavailable(),
    }
}

/// This principal is only an account-address witness for a remote read. It is
/// never installed on a canonical data owner, and cannot authorize a write.
/// The writer replaces it with the credential's actual admitted principal.
struct AddressedRead {
    account: Arc<ComputerAccount>,
}
impl BearerAuthenticator for AddressedRead {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        let bearer = std::str::from_utf8(bearer).ok()?;
        (crate::account::signed_in::claimed_account(bearer).as_deref()
            == Some(self.account.address()))
        .then(|| Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: self.account.owner_id.clone(),
            sign_in: "key:pending".into(),
            client_id: String::new(),
        })
    }
}
struct RemoteRead {
    pending: LocalPending,
    terminal_http: Arc<Mutex<Option<Terminal>>>,
    answered_by: Arc<Mutex<Option<String>>>,
}
impl CallAnswerer for RemoteRead {
    fn invoke(&self, _: &Principal, _: Operation) -> Result<Value, OperationFailure> {
        Err(refusal("client_not_authorized"))
    }
    fn invoke_with_bearer(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: Operation,
    ) -> Result<Value, OperationFailure> {
        if self.pending.operation.as_ref() != Some(&call)
            || call.operation != "records:read"
            || call.resource != "@own-records"
            || principal.account_id != self.pending.account.owner_id
        {
            return Err(refusal("client_not_authorized"));
        }
        let (source_generation, scope) = self.pending.source(&call)?;
        let command = Command {
            owner: self.pending.account.owner_id.clone(),
            sign_in: principal.sign_in.clone(),
            resource: call.resource,
            operation: call.operation,
            request_key: call.request_key,
            input: call.input,
            scope,
            request: self.pending.original.clone(),
            bearer: std::str::from_utf8(bearer)
                .map_err(|error| reclassified("client_not_authorized", &error))?
                .to_owned(),
            accepted_at_ms: crate::native_entry::computer::now_ms(),
            person_present: call.person_present,
            projection: Vec::new(),
            checked_kinds: Vec::new(),
            source_generation,
        };
        let (computer, terminal) = self
            .pending
            .copies
            .settle_read(command)
            .ok_or_else(|| refusal("current_source_unavailable"))?;
        *self
            .answered_by
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = computer;
        if terminal.status != 200 {
            // Keep a writer's HTTP authentication refusal exact. It was
            // admitted at the writer, and remains a known refusal rather than
            // becoming a transport failure or a fabricated local success.
            let failure = refusal(if terminal.status == 401 {
                "client_not_authorized"
            } else {
                "writer_refused"
            });
            *self
                .terminal_http
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(terminal);
            Err(failure)
        } else {
            terminal_answer(terminal)
        }
    }
}

/// These are the same account-owned rows that were copied here, read without
/// activity writes. This authenticator is never installed on public routes.
struct CachedLocal {
    account: Arc<ComputerAccount>,
}
impl BearerAuthenticator for CachedLocal {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        self.authenticate_current(bearer).ok()
    }
    fn authenticate_current(&self, bearer: &[u8]) -> Result<Principal, AuthenticationFailure> {
        let token = std::str::from_utf8(bearer).map_err(|error| crate::carry_cause!(AuthenticationFailure::Unauthorized, error))?;
        let found = crate::account::signed_in::current_bearer(token)
            .map_err(|error| crate::carry_cause!(AuthenticationFailure::Unavailable,error))?
            .filter(|principal| principal.account == self.account.address())
            .ok_or(crate::cause!(AuthenticationFailure::Unauthorized))?;
        let raw = self.account.rows_view.raw();
        if crate::account::erase::deleting(
            &crate::account::rows::store::Store::new(&**raw),
            self.account.sign_in.account(),
        )
        .map_err(|error| crate::carry_cause!(AuthenticationFailure::Unavailable,error))?
        {
            return Err(crate::cause!(AuthenticationFailure::Unauthorized));
        }
        Ok(self.account.sign_in.mcp_principal(&found))
    }
}

struct LocalPending {
    account: Arc<ComputerAccount>,
    copies: Arc<Copies>,
    original: Value,
    operation: Option<Operation>,
}

#[track_caller]
fn refusal(code: &str) -> OperationFailure {
    OperationFailure {
        cause: crate::refusal_cause::Cause::from_caller(),
        code: code.into(),
        outcome_unknown: false,
        detail: None,
    }
}

#[track_caller]
fn reclassified<E: crate::refusal_cause::Caused + ?Sized>(code: &str, error: &E) -> OperationFailure {
    let cause = match error.stored_cause() {
        Some(original) => original,
        None => crate::refusal_cause::Cause::from_caller(),
    };
    OperationFailure { cause, ..refusal(code) }
}

impl LocalPending {
    fn current(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: &Operation,
    ) -> Result<(), OperationFailure> {
        let token = std::str::from_utf8(bearer).map_err(|error| reclassified("client_not_authorized", &error))?;
        let found = crate::account::signed_in::current_bearer(token)
        .map_err(|error| reclassified("current_source_unavailable", &error))?
        .filter(|found| found.account == self.account.address())
        .ok_or_else(|| refusal("client_not_authorized"))?;
        if self.account.sign_in.mcp_principal(&found) != *principal
            || !crate::account::signed_in::permits(&found, &call.resource, &call.operation)
        {
            return Err(refusal("current_workspace_rights_refused"));
        }
        Ok(())
    }

    /// Resolve the same selected history as the native command, under the
    /// selected source's generation. No directory or empty history is invented.
    fn source(
        &self,
        call: &Operation,
    ) -> Result<(i64, Option<domains::Identity>), OperationFailure> {
        let until = Instant::now() + crate::legacy_records::Bounds::default().elapsed;
        let mut owner = crate::workspace_session::owner_wait::acquire(&self.account.owner, || {
            Instant::now() >= until
        })
        .map_err(|error| reclassified("selected_owner_unavailable", &error))?;
        owner
            .pending_records_source(&call.input, &self.account.owner_id)
            .map_err(|error| reclassified("original_command_conflict", &error))
    }

    fn existing_kinds(
        &self,
        call: &Operation,
        ids: &[String],
    ) -> Result<BTreeMap<String, String>, OperationFailure> {
        let until = Instant::now() + crate::legacy_records::Bounds::default().elapsed;
        let mut owner = crate::workspace_session::owner_wait::acquire(&self.account.owner, || {
            Instant::now() >= until
        })
        .map_err(|error| reclassified("selected_owner_unavailable", &error))?;
        owner
            .pending_existing_kinds(&call.input, ids)
            .map_err(|error| reclassified("current_source_unavailable", &error))
    }

    fn write(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: &Operation,
    ) -> Result<Value, OperationFailure> {
        let shipped =
            write_command::Command::shipped().map_err(|error| reclassified("current_source_unavailable", &error))?;
        let writes = shipped
            .parse_json(&call.input)
            .map_err(|error| reclassified("original_input_refused", &error))?;
        let ids = writes
            .iter()
            .map(|write| {
                write
                    .id
                    .to_rust_string()
                    .map_err(|error| reclassified("original_input_refused", &error))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let existing = self.existing_kinds(call, &ids)?;
        let mut checked_kinds = BTreeSet::new();
        for kind in existing.values() {
            if crate::record_model_policy::stays_on_this_device(self.account.state_root(), kind) {
                return Err(refusal("kind_stays_on_this_computer"));
            }
            checked_kinds.insert(kind.clone());
        }
        let mut projection = BTreeMap::new();
        for write in writes {
            let id = write
                .id
                .to_rust_string()
                .map_err(|error| reclassified("original_input_refused", &error))?;
            let mut kind = write
                .kind
                .as_ref()
                .map(|kind| kind.to_rust_string())
                .transpose()
                .map_err(|error| reclassified("original_input_refused", &error))?
                .unwrap_or_default();
            if kind.is_empty() && write.value.is_none() {
                kind = existing.get(&id).cloned().unwrap_or_default();
            }
            if !kind.is_empty() {
                if crate::record_model_policy::stays_on_this_device(
                    self.account.state_root(),
                    &kind,
                ) {
                    return Err(refusal("kind_stays_on_this_computer"));
                }
                checked_kinds.insert(kind.clone());
            }
            // A conditional write may carry the old logical value too. Its
            // kind must pass the same local-only fence before that value can
            // enter a settle submission.
            let expected_kind = match &write.expected {
                write_command::Expected::Present { kind, .. }
                | write_command::Expected::Identity { kind, .. }
                | write_command::Expected::PresentIdentity { kind, .. } => Some(kind),
                write_command::Expected::Unconditional | write_command::Expected::Absent => None,
            };
            if let Some(expected_kind) = expected_kind {
                let expected_kind = expected_kind
                    .to_rust_string()
                    .map_err(|error| reclassified("original_input_refused", &error))?;
                if crate::record_model_policy::stays_on_this_device(
                    self.account.state_root(),
                    &expected_kind,
                ) {
                    return Err(refusal("kind_stays_on_this_computer"));
                }
                checked_kinds.insert(expected_kind);
            }
            let value = write
                .value
                .map(|value| {
                    let text = crate::ecma_json::stringify(&value, Default::default())
                        .map_err(|error| reclassified("original_input_refused", &error))?;
                    serde_json::from_str(&text).map_err(|error| reclassified("original_input_refused", &error))
                })
                .transpose()?;
            projection.insert(id.clone(), Projection { id, kind, value });
        }
        let (source_generation, scope) = self.source(call)?;
        self.current(principal, bearer, call)?;
        let command = Command {
            owner: self.account.owner_id.clone(),
            sign_in: principal.sign_in.clone(),
            resource: call.resource.clone(),
            operation: call.operation.clone(),
            request_key: call.request_key.clone(),
            input: call.input.clone(),
            scope,
            request: self.original.clone(),
            person_present: call.person_present.clone(),
            bearer: std::str::from_utf8(bearer)
                .map_err(|error| reclassified("client_not_authorized", &error))?
                .to_owned(),
            accepted_at_ms: crate::native_entry::computer::now_ms(),
            projection: projection.into_values().collect(),
            checked_kinds: checked_kinds.into_iter().collect(),
            source_generation,
        };
        let queued = self.copies.queue_pending(command).map_err(|error| {
            let mut failure = reclassified(if error.status == 409 {
                "original_command_conflict"
            } else {
                "current_source_unavailable"
            }, &error);
            // The local storage owner can lose a commit acknowledgement too.
            // Retain the original key: only a proved no-effect conflict is a
            // known refusal; an ambiguous durability failure is recoverable.
            failure.outcome_unknown = error.status == 503;
            failure
        })?;
        // Delivery uses the copies' one settle owner. A failed transport leaves
        // the durable entry pending; a known writer refusal is retained and
        // returned here, and never relabelled outcome-unknown.
        self.copies.settle_pending_one(&queued.id);
        // Enqueue already proved local durability. Losing a later result read
        // leaves that known acceptance pending; it cannot turn it into a
        // no-effect refusal or fabricate a canonical commit.
        let terminal = self.copies.pending_result(&queued.id).ok().flatten();
        if let Err(failure) = self.current(principal, bearer, call) {
            if terminal
                .as_ref()
                .is_some_and(|terminal| !terminal.refused && terminal.status == 200)
            {
                return Err(OperationFailure {
                    cause: failure.cause.clone(),
                    ..OperationFailure::committed("original_command_committed_answer_withheld")
                });
            }
            return Err(failure);
        }
        match terminal {
            Some(terminal) => terminal_answer(terminal),
            None => Ok(json!({"accepted":true,"pending":true,"request_key":call.request_key})),
        }
    }

    fn read(&self, principal: &Principal, call: &Operation) -> Result<Value, OperationFailure> {
        let fields = call
            .input
            .as_object()
            .ok_or_else(|| refusal("original_input_refused"))?;
        if fields
            .keys()
            .any(|field| !["id", "type", "scope", "after_byte", "at"].contains(&field.as_str()))
        {
            return Err(refusal("original_input_refused"));
        }
        let id = fields
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| refusal("original_input_refused"))?;
        let kind = match fields.get("type") {
            None | Some(Value::Null) => None,
            Some(Value::String(kind)) if !kind.is_empty() => Some(kind.as_str()),
            Some(_) => return Err(refusal("original_input_refused")),
        };
        let after = fields
            .get("after_byte")
            .map(|after| {
                after
                    .as_u64()
                    .ok_or_else(|| refusal("original_input_refused"))
            })
            .transpose()?;
        let selected = domains::Selection::from_input(&call.input)
            .map_err(|error| reclassified("original_input_refused", &error))?;
        if selected.as_ref().is_some_and(|scope| scope.create) {
            return Err(refusal("original_input_refused"));
        }
        let (generation, scope) = self.source(call)?;
        let projection = self
            .copies
            .pending_projection(&principal.sign_in, id, scope.as_ref(), generation)
            .map_err(|error| reclassified("current_source_unavailable", &error))?
            .ok_or_else(|| refusal("local_record_unavailable"))?;
        let mut answer =
            if kind.is_some_and(|kind| kind != projection.kind) || projection.value.is_none() {
                json!({"id":id,"type":kind,"value":Value::Null})
            } else {
                json!({"id":id,"type":projection.kind,"value":projection.value})
            };
        if let Some(scope) = &scope {
            answer["scope"] =
                serde_json::to_value(scope).map_err(|error| reclassified("current_source_unavailable", &error))?;
        }
        if after.is_none() && mcp::tool_answer_fits(&answer) {
            return Ok(answer);
        }
        let bytes =
            serde_json::to_vec(&answer).map_err(|error| reclassified("current_source_unavailable", &error))?;
        mcp::byte_page(&bytes, after.unwrap_or_default(), &mcp::tool_answer_fits)
            .ok_or_else(|| refusal("original_input_refused"))
    }
}

impl CallAnswerer for LocalPending {
    fn invoke(&self, _: &Principal, _: Operation) -> Result<Value, OperationFailure> {
        Err(refusal("client_not_authorized"))
    }
    fn invoke_with_bearer(
        &self,
        principal: &Principal,
        bearer: &[u8],
        call: Operation,
    ) -> Result<Value, OperationFailure> {
        if self.operation.as_ref() != Some(&call) {
            return Err(refusal("original_command_conflict"));
        }
        // A run capability is admitted as its parent key (`Authenticator`), so the parent's current grant is checked
        // as a person key, and the call is narrowed to what the run's row declared (`Admitted::narrow`).
        let run = run_capability::held(bearer)
            .transpose()
            .map_err(|error| reclassified("client_not_authorized", &error))?;
        let (bearer, call) = match &run {
            None => (bearer, call),
            Some(admitted) => {
                let input = admitted
                    .narrow(principal, &call)
                    .map_err(|error| reclassified("current_workspace_rights_refused", &error))?;
                (admitted.parent.as_slice(), Operation { input, ..call })
            }
        };
        self.current(principal, bearer, &call)?;
        if write_command::Command::is_shipped(&call.operation) {
            if self.copies.holding().is_some() && !self.copies.pending_requires_queue(
                &principal.sign_in, &call.resource, &call.request_key,
            ).map_err(|error| reclassified("current_source_unavailable", &error))? {
                return Err(refusal("local_command_use_writer"));
            }
            self.write(principal, bearer, &call)
        } else {
            self.read(principal, &call)
        }
    }
}

fn terminal_answer(terminal: Terminal) -> Result<Value, OperationFailure> {
    let original_cause = terminal.body.pointer("/result/structuredContent/cause")
        .or_else(|| terminal.body.pointer("/result/structuredContent/detail/cause"))
        .and_then(Value::as_str).and_then(crate::refusal_cause::Cause::from_wire)
        .unwrap_or_else(|| terminal.cause());
    if terminal.status == 200 {
        let result = terminal
            .body
            .get("result")
            .ok_or_else(|| refusal("writer_reply_invalid"))?;
        let content = result
            .get("structuredContent")
            .ok_or_else(|| refusal("writer_reply_invalid"))?
            .clone();
        if result.get("isError") != Some(&Value::Bool(true)) {
            return Ok(content);
        }
        let code = content
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("writer_refused");
        if content.get("outcome").and_then(Value::as_str) == Some("committed") {
            // The writer proved the effect even though its answer was
            // withheld. Preserve that engine declaration through the shared
            // encoder; a plain false uncertainty bit would mean not_started.
            let mut failure = OperationFailure { cause: original_cause.clone(), ..OperationFailure::committed(code) };
            if let Some(detail) = content.get("detail") {
                let mut fields = detail.as_object().cloned().unwrap_or_else(|| {
                    let mut fields = serde_json::Map::new();
                    fields.insert("detail".into(), detail.clone());
                    fields
                });
                fields.insert("_effect_outcome".into(), json!("committed"));
                failure.detail = Some(Value::Object(fields));
            }
            return Err(failure);
        }
        return Err(OperationFailure {
            cause: original_cause.clone(),
            code: code.to_owned(),
            outcome_unknown: content.get("outcome").and_then(Value::as_str) == Some("unknown"),
            detail: content.get("detail").cloned(),
        });
    }
    Err(OperationFailure { cause: original_cause, ..refusal(if terminal.status == 401 {
        "client_not_authorized"
    } else {
        "writer_refused"
    }) })
}

#[cfg(test)]
mod terminal_controls {
    use super::*;

    #[test]
    fn an_existing_write_lane_detail_cause_is_promoted_without_changing_the_detail() {
        let original = crate::cause!(pending_test existing_writer_detail);
        let detail = json!({"cause":original.id()});
        let failure = terminal_answer(Terminal {
            cause: crate::cause!(pending_test historical_terminal_without_cause),
            status: 200,
            body: json!({"result":{"isError":true,"structuredContent":{
                "code":"current_workspace_rights_refused", "outcome":"not_started", "detail":detail
            }}}),
            refused: true,
        }).unwrap_err();
        assert_eq!(failure.code, "current_workspace_rights_refused");
        assert_eq!(failure.cause, original);
        assert_eq!(failure.detail, Some(detail));
        assert!(!failure.outcome_unknown);
    }

    #[test]
    fn a_writer_proved_commit_stays_committed_when_the_local_door_encodes_its_refusal() {
        let original = crate::cause!(pending_test writer_committed);
        let content = json!({
            "cause":original.id(),
            "code":"original_command_committed_answer_withheld", "outcome":"committed",
            "detail":{"field":"state"}
        });
        let refused = terminal_answer(Terminal {
            cause: original.clone(),
            status: 200,
            body: json!({"result":{"isError":true,"structuredContent":content}}),
            refused: false,
        })
        .unwrap_err();
        assert_eq!(mcp::refusal_content(&refused), content);
        assert_eq!(refused.cause, original);
        assert!(!refused.outcome_unknown);
    }

    #[test]
    fn a_writer_proved_refusal_stays_a_known_no_effect_after_local_encoding() {
        let original = crate::cause!(pending_test writer_refused);
        let content = json!({"code":"current_workspace_rights_refused","outcome":"not_started", "cause":original.id()});
        let refused = terminal_answer(Terminal {
            cause: original.clone(),
            status: 200,
            body: json!({"result":{"isError":true,"structuredContent":content}}),
            refused: true,
        })
        .unwrap_err();
        assert_eq!(mcp::refusal_content(&refused), content);
        assert_eq!(refused.cause, original);
        assert!(!refused.outcome_unknown);
    }
}

#[cfg(test)]
mod run_door_controls {
    use super::serves_mcp;

    /// The bare endpoint and the account's own `/a/<address>/mcp` are the same endpoint; another account's address,
    /// a nested path or a different suffix is not served by this computer's door.
    #[test]
    fn this_accounts_mcp_path_is_served_bare_or_by_address_only() {
        assert!(serves_mcp("/mcp", "acct-one"));
        assert!(serves_mcp("/a/acct-one/mcp", "acct-one"));
        assert!(!serves_mcp("/a/acct-two/mcp", "acct-one"));
        assert!(!serves_mcp("/a/acct-one/mcp/extra", "acct-one"));
        assert!(!serves_mcp("/a//mcp", "acct-one"));
        assert!(!serves_mcp("/a/acct-one/files", "acct-one"));
    }
}

#[cfg(test)]
mod routing_tests {
    //! The order a refused credential is tried in (`local_then_writer`): the local door always first, the writer only after
    //! a 401 there, so a share bearer the local door admits never reaches the writer.
    use super::*;
    use std::sync::Mutex;

    async fn route(local: StatusCode) -> (StatusCode, Vec<&'static str>) {
        let calls = Mutex::new(Vec::new());
        let answered = local_then_writer(
            async { calls.lock().unwrap().push("local"); local.into_response() },
            async { calls.lock().unwrap().push("writer"); StatusCode::OK.into_response() },
        )
        .await;
        (answered.status(), calls.into_inner().unwrap())
    }

    #[tokio::test]
    async fn a_credential_the_local_door_admits_never_reaches_the_writer() {
        for admitted in [StatusCode::OK, StatusCode::FORBIDDEN, StatusCode::NOT_FOUND] {
            assert_eq!(route(admitted).await, (admitted, vec!["local"]));
        }
    }

    #[tokio::test]
    async fn only_a_401_from_the_local_door_goes_on_to_the_writer_after_it() {
        assert_eq!(route(StatusCode::UNAUTHORIZED).await, (StatusCode::OK, vec!["local", "writer"]));
    }
}
