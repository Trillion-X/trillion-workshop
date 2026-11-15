//! The forwarder connection: the public account routes' operations, carried over this computer's own
//! outbound connection, reach the same selected-account dispatch as the local
//! account routes. The public forwarder decides nothing about the caller: every
//! credential is admitted here, by the account's own sign-in, for the exact
//! operation it asks (src/account/account_routes.rs). A credential the sign-in does not
//! admit is refused `client_not_authorized`, which the forwarder answers as
//! 401 with its protected-resource metadata. No route, detached principal, new
//! signer or second record store supplies authority.
use crate::refusal_cause::{Caused, CodedError};
use super::{mcp_local::LocalSelectedMcp, SelectedAccount};
use crate::{
    account::{account_routes, NativeAccountOwner},
    mcp::{http::{AuthenticationFailure, BearerAuthenticator}, Operation, RequestDisclosure, MAX_MESSAGE_BYTES},
    resource_authority::{decode_message, Route},
};
use axum::body::{Body, Bytes};
use serde_json::json;
use http_body::Body as HttpBody;
use std::{future::poll_fn, pin::Pin, sync::{Arc, Mutex}, time::{Duration, Instant}};
use zeroize::Zeroizing;

/// Bytes retain their original last-message source owner through write/flush.
/// Converting them to a new Vec here would lose that ownership relationship.
pub(crate) struct SelectedConnectionReply {
    bytes: Bytes,
    _request: Option<Arc<RequestDisclosure>>,
    _source_messages: Vec<Bytes>,
}
impl AsRef<[u8]> for SelectedConnectionReply {
    fn as_ref(&self) -> &[u8] { self.bytes.as_ref() }
}

fn refused(request_id: &str, code: &str, cause: impl Into<crate::refusal_cause::ReportedCause>) -> Result<SelectedConnectionReply, CodedError<()>> {
    if code.is_empty() || code.len() > 160
        || !code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') { return Err(CodedError::new(())); }
    let bytes = serde_json::to_vec(&json!({"state":"refused","request_id":request_id,"code":code,"cause":cause.into().id()})).map_err(|_| CodedError::new(()))?;
    if bytes.len() > MAX_MESSAGE_BYTES { return Err(CodedError::new(())); }
    Ok(SelectedConnectionReply { bytes: Bytes::from(bytes), _request: None, _source_messages: Vec::new() })
}

fn outcome_unknown(request_id: &str, cause: impl Into<crate::refusal_cause::ReportedCause>) -> Result<SelectedConnectionReply, CodedError<()>> {
    let bytes = serde_json::to_vec(&crate::forwarder::DeviceReply::OutcomeUnknown { cause: cause.into(),
        request_id: request_id.to_owned(),
    }).map_err(|_| CodedError::new(()))?;
    if bytes.len() > MAX_MESSAGE_BYTES { return Err(CodedError::new(())); }
    Ok(SelectedConnectionReply { bytes: Bytes::from(bytes), _request: None, _source_messages: Vec::new() })
}

/// What a dispatch knows of its message when it fails: the request it named and whether the call began.
#[derive(Default)]
struct Asked {
    request_id: Option<String>,
    started: bool,
}

/// How a failed dispatch ends. A message that named its request is answered for that request alone: refused when its call
/// never began, an unknown outcome when it did (its answer could not be carried), and the session goes on. The failure
/// ends the session only when the message could not be read, or the connection it came on is no longer current.
fn keep_session(asked: &Asked, connection_current: bool, failure: CodedError<()>) -> Result<SelectedConnectionReply, CodedError<()>> {
    match (&asked.request_id, connection_current) {
        (Some(request_id), true) if asked.started => outcome_unknown(request_id, failure.cause()),
        (Some(request_id), true) => refused(request_id, "dispatch_failed", failure.cause()),
        _ => Err(failure),
    }
}

pub(crate) struct SelectedMacDispatcher {
    operations: LocalSelectedMcp,
    /// The account's internal owner id: who every principal its own routes admit is. The route may name the account by
    /// its address instead (a computer's own session; src/account/computers.rs).
    owner_id: String,
    authenticator: Arc<dyn BearerAuthenticator>,
    route: Route,
    parent_connection_current: account_routes::Current,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
}
impl SelectedMacDispatcher {
    /// Isolated test consumers supply their own admitted parent lifetime.
    #[cfg(test)]
    pub(crate) fn new(selected: Arc<Mutex<SelectedAccount>>, route: Route,
        now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>) -> Result<Self, crate::refusal_cause::CodedError<&'static str>> {
        Self::new_with_parent_current(selected, route, Arc::new(|| true), now_ms)
    }

    /// A forwarder connection dispatcher for the account's current outbound connection
    /// (`parent_connection_current` is that connection's registration check).
    pub(crate) fn new_with_parent_current(selected: Arc<Mutex<SelectedAccount>>, route: Route,
        parent_connection_current: account_routes::Current, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>)
        -> Result<Self, crate::refusal_cause::CodedError<&'static str>> {
        let (sign_in, owner_id) = {
            let owner = crate::workspace_session::owner_wait::acquire(&selected, || false).map_err(|error| crate::refusal_cause::CodedError::with_cause("selected owner unavailable", error.cause()))?;
            owner.selection.assert_current().map_err(|error| crate::refusal_cause::CodedError::with_cause("selected source changed", error.cause()))?;
            let owner_id = owner.account().owner_id;
            let sign_in = owner.sign_in().map_err(|error| crate::refusal_cause::CodedError::with_cause("the account's sign-in is not open", error.cause()))?.clone();
            // The route names the account by its internal owner id (the hosting app's admitted connection) or by its
            // address (a computer's own session).
            if owner_id != route.account_id && sign_in.address() != route.account_id {
                return Err(crate::refusal_cause::CodedError::new("selected account does not own route"));
            }
            (sign_in, owner_id)
        };
        Ok(Self {
            operations: LocalSelectedMcp::new(selected)?,
            authenticator: super::mcp_local::authenticator(sign_in, owner_id.clone()),
            owner_id,
            route, parent_connection_current, now_ms,
        })
    }

    /// Whether the client of `bytes` is admitted now, as `dispatch` admits it: its bearer is current for this account. The
    /// session gives an answer it kept for a retry only to a client this admits (`session::serve_mac_session_while`).
    pub(crate) fn readmits(&self, bytes: &[u8]) -> bool {
        let Ok(mut message) = decode_message(bytes) else { return false };
        let bearer = Zeroizing::new(std::mem::take(&mut message.client_authorization).into_bytes());
        self.authenticator.authenticate_current(&bearer).is_ok_and(|principal| principal.account_id == self.owner_id)
    }

    /// A known operation uncertainty has its own correlated, value-free reply;
    /// it must not retire the shared forwarder connection or become a not-started refusal.
    /// Missing replies and transport/custody failures still close the forwarder connection.
    /// Every retry retains its original identity after possible commitment.
    pub(crate) async fn dispatch(&self, bytes: &[u8]) -> Result<SelectedConnectionReply, CodedError<()>> {
        let mut asked = Asked::default();
        let result = self.dispatch_asked(bytes, &mut asked).await;
        // The other requests share this session: one that fails is answered, and only a withdrawn connection ends it.
        match result {
            Err(failure) => keep_session(&asked, (self.parent_connection_current)(), failure),
            answered => answered,
        }
    }

    async fn dispatch_asked(&self, bytes: &[u8], asked: &mut Asked) -> Result<SelectedConnectionReply, CodedError<()>> {
        let mut message = decode_message(bytes).map_err(|error| CodedError::with_cause((), error.cause()))?;
        asked.request_id = Some(message.request_id.clone());
        let bearer = Zeroizing::new(std::mem::take(&mut message.client_authorization).into_bytes());
        if message.account_id != self.route.account_id || message.device_id != self.route.device_id
            || message.resource_address != self.route.resource_address || message.generation != self.route.generation { return Err(CodedError::new(())); }
        let operation_resource = message.operation_resource.take().unwrap_or_else(|| message.resource_address.clone());
        if crate::resource_authority::operation_reach::route_resource(&operation_resource, &message.operation)
            != self.route.resource_address { return Err(CodedError::new(())); }
        let now = self.now_ms.now_ms();
        if now <= 0 { return Err(CodedError::new(())); }
        // A message whose deadline passed before its dispatch began is refused, never started; the session goes on.
        let Some(remaining) = message.deadline_at_ms.checked_sub(now).filter(|left| *left > 0)
            .and_then(|left| u64::try_from(left).ok()) else {
            return refused(&message.request_id, crate::forwarder::DEADLINE_ELAPSED, crate::cause!());
        };
        let deadline = Instant::now().checked_add(Duration::from_millis(remaining)).ok_or_else(|| CodedError::new(()))?;
        if !(self.parent_connection_current)() { return refused(&message.request_id, "resource_connection_withdrawn", crate::cause!()); }
        let principal = match self.authenticator.authenticate_current(&bearer) {
            Ok(principal) => principal,
            Err(AuthenticationFailure::Unauthorized(_)) => return refused(&message.request_id, "client_not_authorized", crate::cause!()),
            Err(AuthenticationFailure::Unavailable(_) | AuthenticationFailure::UnavailableWord(_, _)) => {
                return refused(&message.request_id, "current_source_unavailable", crate::cause!());
            }
        };
        if principal.account_id != self.owner_id { return refused(&message.request_id, "client_not_authorized", crate::cause!()); }
        let call = Operation { resource: operation_resource, operation: message.operation,
            request_key: message.request_key, input: message.input, person_present: message.person_present };
        let disclosure = Arc::new(RequestDisclosure::default());
        asked.started = true;
        let result = self.operations.invoke_at(&principal, &bearer, call, &disclosure,
            self.parent_connection_current.clone(), Some(deadline));
        let value = match result {
            Ok(value) => value,
            Err(failure) if failure.outcome_unknown => return outcome_unknown(&message.request_id, failure.cause),
            Err(failure) => return refused(&message.request_id, &failure.code, failure.cause),
        };
        // The call ran: its answer is produced even when the deadline passed while it ran. The session keeps it by request
        // key (`session::serve_mac_session_while`), so a retry gets it, and the session is not ended for it.
        let encoded = Zeroizing::new(serde_json::to_vec(&json!({
            "state":"completed","request_id":message.request_id,"value":value,
        })).map_err(|_| CodedError::new(()))?);
        if encoded.len() > MAX_MESSAGE_BYTES { return Err(CodedError::new(())); }
        let mut encoded = encoded;
        let body = Body::from(std::mem::take(&mut *encoded));
        let body = match disclosure.take()? {
            Some(custody) => custody.finish(body, &principal, bearer, disclosure.clone())?,
            None => body,
        };
        let (bytes, source_messages) = tokio::time::timeout_at(deadline.into(), async move {
            let mut body = body;
            let mut messages = Vec::new();
            let mut size = 0usize;
            while let Some(message) = poll_fn(|cx| Pin::new(&mut body).poll_frame(cx)).await {
                let data = message.map_err(|_| CodedError::new(()))?.into_data().map_err(|_| CodedError::new(()))?;
                size = size.checked_add(data.len()).filter(|size| *size <= MAX_MESSAGE_BYTES).ok_or_else(|| CodedError::new(()))?;
                messages.push(data);
            }
            let bytes = if messages.len() == 1 { messages[0].clone() } else {
                let mut joined = Vec::with_capacity(size);
                for message in &messages { joined.extend_from_slice(message); }
                Bytes::from(joined)
            };
            // Retain every original owner even if a future body needs joining;
            // correctness does not depend on a collection helper avoiding copies.
            Ok::<_, CodedError<()>>((bytes, messages))
        }).await.map_err(|_| CodedError::new(()))??;
        Ok(SelectedConnectionReply { bytes, _request: Some(disclosure), _source_messages: source_messages })
    }
}

/// What this computer tells to the forwarder when its session for the selected account opens, as the computer `me`
/// (its id in computers rows): the account's own computers row and public key, from the account's sign-in
/// (`SignIn::told`). The first row, naming `me`, is written and signed there when the account has none. Empty
/// when the account's signing key is not open, so the forwarder answers that account 503 rather than trust an unsigned row.
pub(crate) fn told(selected: &Arc<Mutex<SelectedAccount>>, me: &str) -> Vec<crate::account::computers::KeptAccount> {
    let Ok(mut owner) = crate::workspace_session::owner_wait::acquire(selected, || false) else { return Vec::new() };
    // This computer's earlier ids: the devices the hosting app's account enrolled in this state (none for a computer).
    // A failed read moves nothing: the kept row is told as it is.
    let succeeds = owner.enrolled_devices().unwrap_or_default();
    match owner.sign_in() {
        Ok(sign_in) => sign_in.told(me, &succeeds),
        Err(_) => Vec::new(),
    }
}

/// Messages for the computer itself rather than for the account's routes (`native_entry/computer.rs` `computer_message`): `None`
/// passes the message on to the account routes' dispatch.
pub(crate) type ComputerMessages = Arc<dyn Fn(&[u8]) -> Option<Result<Vec<u8>, CodedError<()>>> + Send + Sync>;

/// A reply on a computer session: the account routes', or the computer's own.
enum ComputerReply {
    Door(SelectedConnectionReply),
    /// The computer's own reply (`messages`).
    Own(Vec<u8>),
}

impl AsRef<[u8]> for ComputerReply {
    fn as_ref(&self) -> &[u8] {
        match self {
            ComputerReply::Door(reply) => reply.as_ref(),
            ComputerReply::Own(bytes) => bytes,
        }
    }
}

/// One session of the selected account to a forwarder over `stream`, opened with the computer's own credential: the computer
/// tells the account (`told`), then answers the forwarder's messages until the session ends or `current` turns
/// false: messages for the computer itself (`messages`) first, every other one with the account's own dispatch. The caller
/// supplies a confidential stream (the forwarder's verified TLS, or a test's own socket) and the exact route the
/// credential opens.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_computer_session<S: std::io::Read + std::io::Write>(
    stream: S, credential: &[u8], route: &Route,
    selected: Arc<Mutex<SelectedAccount>>, current: account_routes::Current, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    runtime: &tokio::runtime::Handle, messages: Option<ComputerMessages>,
) -> std::io::Result<()> {
    crate::io_operation!(connect_computer_session_catching_up(stream, credential, route, selected, current, now_ms, runtime, messages, &[], None).map_err(into_io))
}

/// Run after the account's routes answered a message on a computer's session, with the account's address: the writer's
/// change of the account stores the call made goes out as records then, before the next message, not only on the next
/// step of its copies (src/native_entry/computer.rs `after_door`).
pub(crate) type AfterDoor = Arc<dyn Fn(&str) + Send + Sync>;

/// The I/O error a session function returned, with its kind and stored cause, as a caller that still returns `std::io::Result`
/// gets it.
pub(crate) fn into_io(error: CodedError<std::io::Error>) -> std::io::Error {
    let cause = error.cause();
    crate::refusal_cause::locate_io(error.code, cause)
}

/// Keeps a session's I/O error with its kind and cause, so the producer's `CodedError` reports the same outcome.
fn session_error(error: std::io::Error) -> CodedError<std::io::Error> {
    let cause = Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!());
    CodedError::with_cause(error, cause)
}

/// `connect_computer_session`, naming in `catching_up` the told accounts (by address) this computer does not answer
/// yet (`computers::kept_accounts_bytes_catching_up`): the forwarder passes this computer over for their calls.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_computer_session_catching_up<S: std::io::Read + std::io::Write>(
    stream: S, credential: &[u8], route: &Route,
    selected: Arc<Mutex<SelectedAccount>>, current: account_routes::Current, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    runtime: &tokio::runtime::Handle, messages: Option<ComputerMessages>, catching_up: &[String], after_door: Option<AfterDoor>,
) -> Result<(), CodedError<std::io::Error>> {
    let told = told(&selected, &route.device_id);
    let dispatcher = SelectedMacDispatcher::new_with_parent_current(selected, route.clone(), current, now_ms.clone())
        .map_err(|error| CodedError::with_cause(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "selected resource unavailable"), error.cause()))?;
    crate::forwarder::session::connect_mac_session_telling_kept_accounts(
        stream, credential, &told, catching_up, route, now_ms.clone(), || Ok(()), |bytes| dispatcher.readmits(bytes), |bytes| {
            if let Some(answer) = messages.as_ref().and_then(|messages| messages(bytes)) {
                return answer.map(ComputerReply::Own);
            }
            let answered = runtime.block_on(dispatcher.dispatch(bytes)).map(ComputerReply::Door);
            if let Some(after) = &after_door {
                after(&route.account_id);
            }
            answered
        },
    ).map_err(session_error)
}

/// One session of an account this computer holds a copy of but serves no account routes for yet (src/native_entry/computer.rs
/// `JoiningAccount`), opened with the computer's own credential: the computer tells `told`, then answers the messages
/// for the computer itself (`messages`); every other message (a call for the account's routes) is answered with a correlated
/// refusal `refusal`, as a message that never started. A message `messages` answers `Err` for ends the session.
pub(crate) fn connect_door_less_session<S: std::io::Read + std::io::Write>(
    stream: S, credential: &[u8], route: &Route, told: &[crate::account::computers::KeptAccount], now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    messages: ComputerMessages, refusal: &str,
) -> Result<(), CodedError<std::io::Error>> {
    // A computer serves no routes for the account yet: it is catching up on every account it tells here, and the
    // forwarder sends their calls to another computer.
    let catching_up: Vec<String> = told.iter().map(|told| told.row.account.clone()).collect();
    crate::forwarder::session::connect_mac_session_telling_kept_accounts(
        stream, credential, told, &catching_up, route, now_ms, || Ok(()), |_| false, |bytes| {
            if let Some(answer) = messages(bytes) {
                return answer;
            }
            let message = decode_message(bytes).map_err(|error| CodedError::with_cause((), error.cause()))?;
            serde_json::to_vec(&crate::forwarder::DeviceReply::Refused { cause: crate::cause!().into(), request_id: message.request_id, code: refusal.to_owned() })
                .map_err(|_| CodedError::new(()))
        },
    ).map_err(session_error)
}

/// The account a computer holds at an address, for its own session (`connect_wide_computer_session`): the account's owner,
/// after the computer has woken it for a request (src/native_entry/computer.rs `wake`). `None` for an address the computer does
/// not serve the account's routes for.
pub(crate) type AccountAt = Arc<dyn Fn(&str) -> Option<Arc<Mutex<SelectedAccount>>> + Send + Sync>;

/// Messages for the computer itself on its own session, with the account each names: `None` passes the message on to that
/// account's routes.
pub(crate) type WideComputerMessages = Arc<dyn Fn(&str, &[u8]) -> Option<Result<Vec<u8>, CodedError<()>>> + Send + Sync>;

/// One session of the computer itself to a forwarder over `stream` (src/forwarder/session.rs `computer_wide`: its credential
/// names the computer as the account), carrying every account it holds: the computer tells `told` (each account's
/// signed computers row and key, `catching_up` naming those it does not answer yet), then answers each message for the account the message names: messages for the computer itself
/// (`messages`) first, every other one with that account's own dispatch, made once per account on its first message and
/// bound to the session's route with the account's address. A message for an account the computer does not serve is
/// answered with the correlated refusal `refusal`, and the session goes on.
#[allow(clippy::too_many_arguments)]
pub(crate) fn connect_wide_computer_session<S: std::io::Read + std::io::Write>(
    stream: S, credential: &[u8], route: &Route, told: &[crate::account::computers::KeptAccount], catching_up: &[String],
    account_at: AccountAt, current: account_routes::Current, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>, runtime: &tokio::runtime::Handle,
    messages: WideComputerMessages, refusal: &str, after_door: Option<AfterDoor>,
    on_admitted: impl FnOnce() -> std::io::Result<()>,
) -> Result<(), CodedError<std::io::Error>> {
    let dispatchers: Mutex<std::collections::HashMap<String, Arc<SelectedMacDispatcher>>> = Mutex::new(std::collections::HashMap::new());
    crate::forwarder::session::connect_mac_session_telling_kept_accounts(
        stream, credential, told, catching_up, route, now_ms.clone(), on_admitted,
        |bytes| {
            // An account's kept answer goes only to a client that account's dispatch admits now.
            let Ok(message) = decode_message(bytes) else { return false };
            let known = dispatchers.lock().ok().and_then(|held| held.get(&message.account_id).cloned());
            known.is_some_and(|dispatcher| dispatcher.readmits(bytes))
        },
        |bytes| {
            let mut message = decode_message(bytes).map_err(|error| CodedError::with_cause((), error.cause()))?;
            zeroize::Zeroize::zeroize(&mut message.client_authorization);
            let address = std::mem::take(&mut message.account_id);
            if let Some(answer) = messages(&address, bytes) {
                return answer.map(ComputerReply::Own);
            }
            let refused = |cause: crate::refusal_cause::Cause| serde_json::to_vec(&crate::forwarder::DeviceReply::Refused { cause: cause.into(),
                request_id: message.request_id.clone(), code: refusal.to_owned(),
            }).map(ComputerReply::Own).map_err(|_| CodedError::new(()));
            let Some(selected) = account_at(&address) else { return refused(crate::cause!()) };
            let known = dispatchers.lock().map_err(|_| CodedError::new(()))?.get(&address).cloned();
            let dispatcher = match known {
                Some(dispatcher) => dispatcher,
                None => {
                    let account_route = Route { account_id: address.clone(), ..route.clone() };
                    let Ok(made) = SelectedMacDispatcher::new_with_parent_current(selected, account_route, current.clone(), now_ms.clone()) else {
                        return refused(crate::cause!());
                    };
                    let made = Arc::new(made);
                    dispatchers.lock().map_err(|_| CodedError::new(()))?.insert(address.clone(), made.clone());
                    made
                }
            };
            let answered = runtime.block_on(dispatcher.dispatch(bytes)).map(ComputerReply::Door);
            if let Some(after) = &after_door {
                after(&address);
            }
            answered
        },
    ).map_err(session_error)
}

/// Test transport supplies the confidential stream and registration already
/// admitted by its fixture. Production uses the original outbound owner.
#[cfg(test)]
pub(crate) fn connect_selected_mac_session<S: std::io::Read + std::io::Write>(
    stream: S, credential: &[u8], route: &Route,
    selected: Arc<Mutex<SelectedAccount>>, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    runtime: &tokio::runtime::Handle,
) -> std::io::Result<()> {
    crate::io_operation!(connect_computer_session(stream, credential, route, selected, Arc::new(|| true), now_ms, runtime, None))
}


#[cfg(test)]
mod keep_session_tests {
    //! One failed request answers itself and leaves the session standing (the Mac's computer session dropped in 22 of 68
    //! sessions, 2026-11-13: any `Err` from the dispatch ended the session every request shares).
    use super::*;

    fn failure() -> CodedError<()> { CodedError::new(()) }
    fn body(reply: Result<SelectedConnectionReply, CodedError<()>>) -> serde_json::Value {
        serde_json::from_slice(reply.expect("answered").as_ref()).unwrap()
    }

    #[test]
    fn a_request_that_never_began_is_refused_and_the_session_stands() {
        let asked = Asked { request_id: Some("request:one".into()), started: false };
        let answer = body(keep_session(&asked, true, failure()));
        assert_eq!(answer["state"], "refused");
        assert_eq!(answer["request_id"], "request:one");
    }

    #[test]
    fn a_request_whose_call_began_is_an_unknown_outcome_and_the_session_stands() {
        let asked = Asked { request_id: Some("request:two".into()), started: true };
        let answer = body(keep_session(&asked, true, failure()));
        assert_eq!(answer["request_id"], "request:two");
        assert_ne!(answer["state"], "completed");
        assert_ne!(answer["state"], "refused", "a call that began is never reported as not started");
    }

    #[test]
    fn a_withdrawn_connection_or_an_unreadable_message_still_ends_the_session() {
        let asked = Asked { request_id: Some("request:three".into()), started: true };
        assert!(keep_session(&asked, false, failure()).is_err());
        assert!(keep_session(&Asked::default(), true, failure()).is_err());
    }
}
