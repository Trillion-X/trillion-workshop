// src/forwarder/gateway.rs
//
// Purpose: Compose authenticated MCP HTTP with bounded admitted Mac connections and the existing call answerer.
//
// Non-Negotiable Invariants:
// - Require separate bearer, client-proof and device-registration supplies.
// - Do not publish a new route before its credential check and acknowledgement complete.
// - Keep pending connection checks bounded.
//
// Key Concepts:
// - Gateway composition, shared list of connected computers and RAII connection-check permits.
// - Host-preserving HTTP and Mac resource-connection upgrade.
//
// Security Considerations:
// - The hosting owner supplies authenticated TLS termination and confidential deadline-bound streams.
// - This composition does not establish production account registration or activate a hosted endpoint.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

//! Composition of authenticated MCP HTTP and an admitted Mac resource route.
//! The hosting owner supplies a TLS-terminated listener at its stable address;
//! the Mac transport owner supplies a confidential deadline-bound stream.
//! Account/client proof, bearer identity and device registration are mandatory
//! separate trusted owners. This module does not create any of them.
use crate::refusal_cause::CodedError;
use super::{
    answers::{json, named_path},
    origins::{self, Lookup, OriginBook, OriginProof, OriginsRow},
    connected_computers::{ConnectedComputers, TermCheck},
    session::{ConnectionAdmission, ForwarderConnection},
    websocket::accept_resource_websocket,
    ClientProofIssuer, RouteDirectory, McpForwarder,
};
use crate::{
    account::{computers, rows::tokens, signed_in},
    mcp::{
        http::{axum_adapter::Service, AuthenticationFailure, BearerAuthenticator},
        Operation, OperationFailure, Principal, CallAnswerer,
    },
    resource_authority::Route,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, OnceLock,
    },
};
mod body_custody;
use crate::account::computers::messages::carried_header;

/// Bounds credential and WebSocket upgrade reads before a route is installed.
pub const MAX_PENDING_MAC_ADMISSIONS: usize = 32;

struct PendingAdmission<'a>(&'a AtomicUsize);
impl Drop for PendingAdmission<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Gateway {
    expected_host: String,
    authenticator: Arc<dyn BearerAuthenticator>,
    issuer: Arc<dyn ClientProofIssuer>,
    admission: Arc<dyn ConnectionAdmission>,
    connected_computers: Arc<ConnectedComputers>,
    pending_admissions: AtomicUsize,
    now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    /// The authorization server the MCP resource's RFC 9728 discovery names (the sign-in tool's, src/account/signed_in/settings.json `authorization_server`). None: no
    /// discovery is published and a refused credential hears the plain `Bearer` challenge.
    oauth_issuer_origin: Option<String>,
    /// The origins rows live computers handed in (`origins.rs`), in memory only.
    origins: OriginBook,
    /// The hosting owner's resolver for a person's own domain (`origins::OriginProof`). None: no such domain is believed.
    origin_proof: Option<Arc<dyn OriginProof>>,
    /// The explicit account the account routes that name no account in their path (`origins.json`
    /// `root_account_paths`, the byte routes) go to; that account's computer refuses any credential it did not issue.
    root_account: Option<String>,
    /// What each computer last reported of itself and when (`report_path`, src/account/computers/copy_rule.rs
    /// `OwnReport`), in memory only, like the sessions themselves: answered only while the computer's own session is live.
    reports: std::sync::Mutex<std::collections::HashMap<String, (computers::copy_rule::OwnReport, u64)>>,
}

impl Gateway {
    pub(crate) fn public_host(&self) -> &str {
        &self.expected_host
    }

    /// Whether a request whose Host is `host`, not the forwarder's own, is another origin's: some live account's origins
    /// row names it (`origins::OriginBook::find`, a contested host included, which the route table then answers 409).
    /// The TLS ingress (`ingress.rs`) lets such a request through to the route table and refuses any other foreign Host.
    pub(crate) fn names_origin(&self, host: &str) -> bool {
        !matches!(self.origins.find(host, &|held| self.account_live(held)), Lookup::Unknown)
    }


    pub fn new(
        expected_host: impl Into<String>,
        authenticator: Arc<dyn BearerAuthenticator>,
        issuer: Arc<dyn ClientProofIssuer>,
        admission: Arc<dyn ConnectionAdmission>,
        now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    ) -> Self {
        Self {
            expected_host: expected_host.into(),
            authenticator,
            issuer,
            admission,
            connected_computers: Arc::new(ConnectedComputers::new()),
            pending_admissions: AtomicUsize::new(0),
            now_ms,
            oauth_issuer_origin: None,
            origins: OriginBook::new(),
            origin_proof: None,
            root_account: None,
            reports: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Explicitly choose the account the account routes that name no account in their path go to (`root_account`).
    /// Refused: an address that is not an account's.
    pub fn with_root_account(mut self, address: &str) -> Result<Self, CodedError<&'static str>> {
        if !tokens::owner_text_ok(address) {
            return Err(CodedError::new("root account refused"));
        }
        self.root_account = Some(address.to_owned());
        Ok(self)
    }

    /// The resolver the hosting owner supplies for a person's own domain (`origins::OriginProof`): a domain is believed
    /// only when it reads the domain's TXT proof naming the account. Without one, only names under the name suffixes
    /// (`origins.json` `name_suffixes`) are believed.
    pub fn with_origin_proof(mut self, proof: Arc<dyn OriginProof>) -> Self {
        self.origin_proof = Some(proof);
        self
    }

    /// The forwarder of one account's routes at `door_origin` (its RFC 9728 discovery names the sign-in tool as the
    /// authorization server, not this origin), which also takes sessions from computers that prove their own key (`ComputerAdmission`). Its bearer
    /// check is the one signed-in check (`account::signed_in::verify`, `SignedInAuthenticator`): the JWT's signature,
    /// issuer, audience and times are checked against the sign-in tool's JWKS and its account claim names the account,
    /// with no round trip to any computer. A refused credential is answered 401 with the RFC 9728 challenge. Each
    /// operation then carries the same credential to the account's live computer, which admits it again. The hosting
    /// app's connection is admitted at the account routes' `/devices/resource-connections/admit`. The forwarder stores
    /// no account or route rows; it keeps only what each live computer told.
    pub fn with_door(
        expected_host: impl Into<String>,
        door_origin: &str,
        now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>,
    ) -> Result<Self, CodedError<&'static str>> {
        use super::remote_connection_check::CanonicalConnectionAdmission;
        let mut endpoint = url::Url::parse(door_origin).map_err(|_| CodedError::new("door origin refused"))?;
        if endpoint.scheme() != "https" || endpoint.username() != ""
            || endpoint.password().is_some() || endpoint.path() != "/"
            || endpoint.query().is_some() || endpoint.fragment().is_some()
        { return Err(CodedError::new("door origin refused")); }
        endpoint.set_path("/devices/resource-connections/admit");
        let admission = Arc::new(super::remote_connection_check::DoorOrComputerAdmission::new(
            Some(CanonicalConnectionAdmission::new(endpoint)?)));
        let mut gateway = Self::new(expected_host, Arc::new(SignedInAuthenticator), Arc::new(BearerForwarder), admission, now_ms);
        // The authorization server the MCP door names (RFC 9728) is the sign-in tool's (DATA, src/account/signed_in/settings.json).
        gateway.oauth_issuer_origin = Some(crate::account::signed_in::settings().authorization_server.clone());
        Ok(gateway)
    }

    /// A forwarder that takes sessions only from computers that prove their own key (`ComputerAdmission`), and no account routes'
    /// hosting-app connection, and publishes no authorization server. Everything else is as `with_door`.
    pub fn with_computers(expected_host: impl Into<String>, now_ms: std::sync::Arc<dyn crate::storage::time_source::Clock>) -> Self {
        let admission =
            Arc::new(super::remote_connection_check::DoorOrComputerAdmission::new(None));
        Self::new(expected_host, Arc::new(SignedInAuthenticator), Arc::new(BearerForwarder), admission, now_ms)
    }

    /// Build the existing bounded HTTP adapter. The caller must use its own
    /// TLS-terminated listener and must preserve the configured public Host.
    pub fn http_service(self: &Arc<Self>) -> Result<Service, CodedError<&'static str>> {
        let service = Service::new(
            self.expected_host.clone(),
            self.authenticator.clone(),
            self.clone(),
        )?;
        match &self.oauth_issuer_origin {
            Some(issuer) => {
                let scopes: Vec<&str> = signed_in::settings().offered_scopes.iter().map(String::as_str).collect();
                service.with_oauth_issuer(issuer, &scopes)
            }
            None => Ok(service),
        }
    }

    /// The forwarder's whole HTTP route table: MCP (`http_service`), every path under `/a/<address>` (and the
    /// discovery paths that name an address), carried to a live computer of that account (`account_path`), and every
    /// request whose Host a live account's origins row names, carried to the installation that host shows
    /// (`origin_path`). A Host no live account names is the forwarder's own, as before.
    pub fn http_route_table(self: &Arc<Self>) -> Result<axum::Router, CodedError<&'static str>> {
        let gateway = self.clone();
        let route_table = crate::mcp::http::axum_adapter::route_table(self.http_service()?).fallback(move |request: axum::extract::Request| {
            let gateway = gateway.clone();
            async move { gateway.account_path(request).await }
        });
        // A request for another origin never reaches the forwarder's own routes (its MCP path included): it is the
        // installation's request.
        let gateway = self.clone();
        Ok(route_table.layer(axum::middleware::from_fn(move |request: axum::extract::Request, next: axum::middleware::Next| {
            let gateway = gateway.clone();
            async move {
                let Some(host) = gateway.origin_host(&request) else { return next.run(request).await };
                let finder = gateway.clone();
                let lookup = tokio::task::spawn_blocking(move || finder.origins.find(&host, &|held| finder.account_live(held))).await;
                match lookup {
                    Ok(Lookup::Unknown) => next.run(request).await,
                    Ok(lookup) => gateway.origin_path(lookup, request).await,
                    Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
                }
            }
        })))
    }

    /// The request's host, in its one form (`origins::host_of`), when it is a host other than the forwarder's own.
    /// A request with no Host, or the forwarder's own, is `None`.
    fn origin_host(&self, request: &axum::extract::Request) -> Option<String> {
        let asked = request.headers().get(axum::http::header::HOST).and_then(|value| value.to_str().ok())
            .or_else(|| request.uri().authority().map(|authority| authority.as_str()))?;
        let asked = origins::host_of(asked)?;
        (origins::host_of(&self.expected_host).as_deref() != Some(asked.as_str())).then_some(asked)
    }

    /// Whether a computer of the account at `address` is live now (a route the account's believed row lets answer).
    fn account_live(&self, address: &str) -> bool {
        RouteDirectory::current_route(self.connected_computers.as_ref(), address, COMPUTER_RESOURCE).is_some()
    }

    /// Take an origins row the computer `from` of the account at `address` handed in: `from` is a live computer the
    /// account's newest believed computers row names (`ConnectedComputers::computer_route`), and the row is the account's own
    /// (`origins::OriginBook::take`).
    pub(crate) fn take_origins(&self, address: &str, from: &str, row: OriginsRow) -> Result<(), origins::Refusal> {
        if self.connected_computers.computer_route(address, from, from).is_none() {
            return Err(crate::cause!(origins::Refusal::NotBelieved));
        }
        self.origins.take(address, row, self.now_ms.now_ms(), &|held| self.account_live(held), self.origin_proof.as_deref())
    }

    /// Take `from`'s own report (only while its own session is live: a computer that is not connected reports nothing)
    /// and answer every report held of a computer whose own session is live now, at most `copy_rule::most_reports`, by
    /// computer id. Reports of computers no longer live are forgotten.
    pub(crate) fn take_report(&self, from: &str, report: computers::copy_rule::OwnReport) -> Option<Value> {
        if !self.connected_computers.computer_live(from) {
            return None;
        }
        let now = u64::try_from(self.now_ms.now_ms()).unwrap_or(0);
        let mut held = self.reports.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        held.retain(|computer, _| self.connected_computers.computer_live(computer));
        if held.len() < computers::copy_rule::most_reports() || held.contains_key(from) {
            held.insert(from.to_owned(), (report, now));
        }
        let mut reports: Vec<computers::copy_rule::Reported> = held.iter().map(|(computer, (report, at))| computers::copy_rule::Reported {
            sealed_versions: report.sealed_versions.clone(), unit: report.unit.clone(),
            computer: computer.clone(), always_on: report.always_on, takes_new_accounts: report.takes_new_accounts,
            has_room: report.has_room, last_seen: *at,
        }).collect();
        reports.sort_by(|a, b| a.computer.cmp(&b.computer));
        serde_json::to_value(computers::copy_rule::ReportsAnswer { reports }).ok()
    }

    /// A request for another origin: the one live account whose origins row names the host answers it, at its
    /// installation (`origins::computer_target`), carried like any account path (`forward_http`). Two live accounts
    /// naming the host: 409, and neither answers.
    /// A host renamed since (`Origin::moved_to`) sends a page read (GET or HEAD) on to the host it was renamed to,
    /// 301 with its own path and query, as old trillion src/public-app-host.mjs:1315 `moved` did.
    async fn origin_path(self: Arc<Self>, lookup: Lookup, request: axum::extract::Request) -> axum::response::Response {
        let Lookup::Found { address, installation, moved_to } = lookup else {
            return plain(axum::http::StatusCode::CONFLICT, &words().origin_contested, crate::cause!());
        };
        if let Some(to) = moved_to.filter(|_| matches!(*request.method(), axum::http::Method::GET | axum::http::Method::HEAD)) {
            let target = request.uri().path_and_query().map_or("/", |target| target.as_str());
            let location = format!("https://{to}{target}");
            let mut answer = axum::response::Response::new(axum::body::Body::empty());
            *answer.status_mut() = axum::http::StatusCode::MOVED_PERMANENTLY;
            if let Ok(value) = axum::http::HeaderValue::from_str(&location) {
                answer.headers_mut().insert(axum::http::header::LOCATION, value);
            }
            answer.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
            return answer;
        }
        let (mut parts, body) = request.into_parts();
        let target = origins::computer_target(&address, &installation,
            parts.uri.path_and_query().map_or("/", |target| target.as_str()));
        let Ok(uri) = target.parse::<axum::http::Uri>() else {
            return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
        };
        parts.uri = uri;
        self.forward_http(address, axum::extract::Request::from_parts(parts, body)).await
    }

    /// A request for a path that names an account (`answers::named_path`). A message from one computer to another
    /// (`POST /a/<address>/<message_path>/<to>`) is passed on (`messages`); any other request goes, whole, to the live computer
    /// that answers the account now (`ConnectedComputers::current_route`, the writer first), as one `http_operation`
    /// message on that computer's own session, and the computer's answer is the answer. No live computer: 503. A path that
    /// names no account is 404 `no_account`. The forwarder reads nothing of the request but its path and, for a message, the sender's proof.
    async fn account_path(self: Arc<Self>, request: axum::extract::Request) -> axum::response::Response {
        let path = request.uri().path().to_owned();
        if path == origins::settings().certificate_ask_path {
            return self.certificate_ask(request).await;
        }
        // An account route that names no account in its path (`root_account_paths`, the byte routes) goes to the configured
        // root account's live computer, which refuses any credential it did not issue.
        if let Some(root) = self.root_account.clone() {
            if origins::settings().root_account_paths.iter().any(|route| path == *route
                || path.strip_prefix(route.as_str()).is_some_and(|rest| rest.starts_with('/')))
            {
                return self.forward_http(root, request).await;
            }
        }
        let Some((address, inner)) = named_path(&path) else {
            return plain(axum::http::StatusCode::NOT_FOUND, "no_account", crate::cause!());
        };
        let address = address.to_owned();
        if !tokens::owner_text_ok(&address) {
            return plain(axum::http::StatusCode::NOT_FOUND, "no_account", crate::cause!());
        }
        let message_prefix = format!("/{}/", computers::settings().message_path);
        if let Some(to) = inner.strip_prefix(&message_prefix).map(str::to_owned) {
            if request.method() != axum::http::Method::POST {
                return plain(axum::http::StatusCode::METHOD_NOT_ALLOWED, "request_refused", crate::cause!());
            }
            return self.pass_message(address, to, request).await;
        }
        self.forward_http(address, request).await
    }

    /// The question an on-demand TLS terminator in front of the forwarder asks before it makes a certificate for a host
    /// (`GET <certificate_ask_path>?domain=<host>`): 200 when exactly one live account's origins row names the host
    /// (`OriginBook::may_certify`), 404 otherwise. The forwarder makes and keeps no certificate itself: it stores nothing.
    async fn certificate_ask(self: Arc<Self>, request: axum::extract::Request) -> axum::response::Response {
        if !matches!(*request.method(), axum::http::Method::GET | axum::http::Method::HEAD) {
            return plain(axum::http::StatusCode::METHOD_NOT_ALLOWED, "request_refused", crate::cause!());
        }
        let asked = request.uri().query().and_then(|query| url::form_urlencoded::parse(query.as_bytes())
            .find(|(name, _)| name == "domain").map(|(_, value)| value.into_owned()));
        let Some(host) = asked.as_deref().and_then(origins::host_of) else {
            return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
        };
        let gateway = self.clone();
        let may = tokio::task::spawn_blocking(move || gateway.origins.may_certify(&host, &|held| gateway.account_live(held))).await;
        match may {
            Ok(true) => plain(axum::http::StatusCode::OK, "ok", crate::cause!()),
            Ok(false) => plain(axum::http::StatusCode::NOT_FOUND, "no_account", crate::cause!()),
            Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
        }
    }

    async fn forward_http(self: Arc<Self>, address: String, request: axum::extract::Request) -> axum::response::Response {
        // The carried HTTP protocol cannot preserve final trailers. Refuse an
        // explicit measurement preference before forwarding any possible effect;
        // an ordinary request keeps its exact existing transport contract.
        if crate::mcp::work_requested(request.headers()).is_some() {
            let mut response = axum::response::Response::new(axum::body::Body::empty());
            *response.status_mut() = axum::http::StatusCode::NOT_IMPLEMENTED;
            response.headers_mut().insert(crate::mcp::WORK_HEADER, axum::http::HeaderValue::from_static("unavailable"));
            response.headers_mut().insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
            return response;
        }
        use base64::Engine as _;
        // A request for the account is bounded by the account routes' one request limit (src/mcp/settings.json `request_bytes`),
        // not by one message between computers: it crosses the session as one message (`carried_message_bytes`).
        let limit = crate::mcp::request_bytes();
        let (parts, body) = request.into_parts();
        let body = match axum::body::to_bytes(body, limit).await {
            Ok(body) => body,
            Err(error) => {
                let cause = crate::refusal_cause::stored_error_cause(&error)
                    .unwrap_or_else(|| crate::cause!(condition: account_http_body_unavailable_or_exceeds_limit));
                crate::quiet_eprintln!("door-refusal status=413 cause={cause}");
                return json(axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                    &serde_json::json!({"error": crate::mcp::too_large(), "cause": cause.id()}), &[("cache-control", "no-store")]);
            }
        };
        let ask = computers::messages::HttpAsk {
            method: parts.method.as_str().to_owned(),
            target: parts.uri.path_and_query().map_or_else(|| parts.uri.path().to_owned(), |target| target.as_str().to_owned()),
            headers: parts.headers.iter()
                .filter(|(name, _)| carried_header(name.as_str()))
                .filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned())))
                .collect(),
            body: base64::engine::general_purpose::STANDARD.encode(&body),
            // A page read may be a file larger than one answer: the computer answers its first window and the rest is
            // fetched below by byte range.
            stream: parts.method == axum::http::Method::GET,
        };
        let Ok(input) = serde_json::to_value(&ask) else { return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!()) };
        let (gateway, address_asked) = (self.clone(), address.clone());
        let answered = tokio::task::spawn_blocking(move || -> Result<(Value, String), CodedError<axum::http::StatusCode>> {
            let route = gateway.connected_computers.current_route(&address, COMPUTER_RESOURCE).ok_or_else(|| CodedError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE))?;
            let mut answered = route.clone();
            let mut value = gateway.send_computer_message(&route, &computers::settings().http_operation, input.clone(), "http".to_owned(), None)?;
            // A computer that does not hold the account refuses `not_held` (nothing done): the request goes on to each other
            // computer the newest row lets answer, until one holds it.
            if http_not_held(&value) {
                for other in gateway.connected_computers.may_answer_routes(&address).into_iter().filter(|other| other.device_id != route.device_id) {
                    value = gateway.send_computer_message(&other, &computers::settings().http_operation, input.clone(), "http".to_owned(), None)?;
                    answered = other;
                    if !http_not_held(&value) {
                        break;
                    }
                }
            }
            // A computer that does not hold the writer turn refuses with the writer's name (`not_writer`): the request goes once
            // more to that writer, and a second refusal is the answer.
            let named = serde_json::from_value::<computers::messages::HttpAnswer>(value.clone()).ok().and_then(|answer| http_not_writer(&answer));
            match named.and_then(|writer| gateway.connected_computers.answering_route(&address, &writer)) {
                Some(writer_route) if writer_route.device_id != answered.device_id => {
                    let value = gateway.send_computer_message(&writer_route, &computers::settings().http_operation, input, "http".to_owned(), None)?;
                    Ok((value, writer_route.device_id))
                }
                _ => Ok((value, answered.device_id)),
            }
        }).await;
        let (value, answered_by) = match answered {
            Ok(Ok(answered)) => answered,
            Ok(Err(failure)) => return plain(failure.code, failure_word(failure.code), failure.cause()),
            Err(_) => return plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
        };
        let Ok(answer) = serde_json::from_value::<computers::messages::HttpAnswer>(value) else {
            return plain(axum::http::StatusCode::BAD_GATEWAY, &words().no_live_computer, crate::cause!());
        };
        let Ok(body) = base64::engine::general_purpose::STANDARD.decode(answer.body.as_bytes()) else {
            return plain(axum::http::StatusCode::BAD_GATEWAY, &words().no_live_computer, crate::cause!());
        };
        let whole = answer.whole.filter(|whole| answer.status == 200 && *whole > body.len() as u64);
        let mut response = match whole {
            Some(whole) => self.clone().stream_whole(&address_asked, &answered_by, &ask, body, whole),
            None => axum::response::Response::new(axum::body::Body::from(body)),
        };
        *response.status_mut() = axum::http::StatusCode::from_u16(answer.status).unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
        for (name, value) in answer.headers {
            if !carried_header(&name) {
                continue;
            }
            if let (Ok(name), Ok(value)) = (axum::http::HeaderName::from_bytes(name.as_bytes()), axum::http::HeaderValue::from_str(&value)) {
                response.headers_mut().append(name, value);
            }
        }
        // The computer whose session answered, named last so no answer of the computer's own can stand in for it.
        if let (Ok(name), Ok(value)) = (axum::http::HeaderName::from_bytes(computers::settings().answered_by_header.as_bytes()),
            axum::http::HeaderValue::from_str(&answered_by)) {
            response.headers_mut().insert(name, value);
        }
        response
    }

    /// The body of a whole file larger than one computer answer: `first` (the first window the computer answered, of the file's
    /// `whole` bytes) and then each next window, fetched from the same computer by byte range as the visitor's connection
    /// takes the bytes, so no more than one window is held. A window that cannot be fetched ends the body early (the
    /// connection is cut, as a file that failed half way is) rather than sending a short file as a whole one.
    fn stream_whole(self: Arc<Self>, address: &str, computer: &str, ask: &computers::messages::HttpAsk, first: Vec<u8>, whole: u64) -> axum::response::Response {
        use base64::Engine as _;
        use futures::StreamExt as _;
        let window = first.len() as u64;
        let (gateway, address, computer, ask) = (self, address.to_owned(), computer.to_owned(), ask.clone());
        let rest = futures::stream::unfold(Some(first.len() as u64), move |next| {
            let (gateway, address, computer, ask) = (gateway.clone(), address.clone(), computer.clone(), ask.clone());
            async move {
                let offset = next.filter(|offset| *offset < whole)?;
                let last = (offset + window).min(whole) - 1;
                let fetched = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
                    let route = gateway.connected_computers.answering_route(&address, &computer)?;
                    let mut ranged = ask;
                    ranged.stream = false;
                    ranged.headers.retain(|(name, _)| !name.eq_ignore_ascii_case("range"));
                    ranged.headers.push(("range".to_owned(), format!("bytes={offset}-{last}")));
                    let value = gateway.send_computer_message(&route, &computers::settings().http_operation, serde_json::to_value(&ranged).ok()?, "http".to_owned(), None).ok()?;
                    let answer = serde_json::from_value::<computers::messages::HttpAnswer>(value).ok()?;
                    let body = base64::engine::general_purpose::STANDARD.decode(answer.body.as_bytes()).ok()?;
                    (answer.status == 206 && body.len() as u64 == last - offset + 1).then_some(body)
                }).await.ok().flatten();
                match fetched {
                    Some(body) => { let after = offset + body.len() as u64; Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(body)), Some(after))) }
                    None => Some((Err(std::io::Error::other("a window of the file could not be read")), None)),
                }
            }
        });
        let body = futures::stream::once(async move { Ok::<_, std::io::Error>(axum::body::Bytes::from(first)) }).chain(rest);
        let mut response = axum::response::Response::new(axum::body::Body::from_stream(body));
        if let Ok(length) = axum::http::HeaderValue::from_str(&whole.to_string()) {
            response.headers_mut().insert(axum::http::header::CONTENT_LENGTH, length);
        }
        response
    }

    /// Pass a message on from one computer of the account at `address` to its computer `to`. The sender's bearer is its own
    /// computer proof (`trp_`), which must name this account; the forwarder checks both computers are named by the account's
    /// newest believed row (`ConnectedComputers::computer_route`) and refuses a writer's message below the newest writer
    /// term it carried (`ConnectedComputers::term_check`). A command-only settle may come from an omitted computer,
    /// but can reach only a current signed may-answer destination: its writer checks the sealed command's caller
    /// rights. Ordinary record rows and generic parts keep the two-member fence. The receiver checks the proof again.
    async fn pass_message(self: Arc<Self>, address: String, to: String, request: axum::extract::Request) -> axum::response::Response {
        // A post may carry the logical request's key (`Link::send_keyed`) in a header: every try of one request carries the
        // same key, so the answering computer returns the answer it kept for it. A post without it is answered as before.
        let request_key = match request.headers().get(crate::https::REQUEST_KEY_HEADER) {
            None => None,
            Some(value) => match value.to_str() {
                Ok(key) if !key.is_empty() && key.len() <= 128 && key.bytes().all(|byte| byte.is_ascii_alphanumeric()) => Some(key.to_owned()),
                _ => return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!()),
            },
        };
        // Every body is within one message's bound: a longer message travels in parts (`Copies::send`).
        let limit = computers::settings().message_body_bytes;
        let bearer = request.headers().get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned);
        let Some(proof) = bearer else { return plain(axum::http::StatusCode::UNAUTHORIZED, "unauthenticated", crate::cause!()) };
        let from = match computers::read_computer_message_credential(&proof, self.now_ms.now_ms()) {
            Some((computer, account, _)) if account == address => computer,
            _ => return plain(axum::http::StatusCode::UNAUTHORIZED, "unauthenticated", crate::cause!()),
        };
        let Ok(body) = axum::body::to_bytes(request.into_body(), limit).await else {
            return plain(axum::http::StatusCode::PAYLOAD_TOO_LARGE, "request_refused", crate::cause!());
        };
        // The computer tells the account's computers row again (its row was edited while its session stays open): taken
        // for that computer's own live session of the account, believed as a list of kept accounts is.
        // The computer hands in the account's origins row (`origins.rs`): taken for that account while a computer of it is live.
        if to == origins::settings().tell_origins_path {
            let Ok(row) = serde_json::from_slice::<OriginsRow>(&body) else {
                return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
            };
            let gateway = self.clone();
            let taken = tokio::task::spawn_blocking(move || gateway.take_origins(&address, &from, row)).await;
            return match taken {
                Ok(Ok(())) => json(axum::http::StatusCode::OK, &serde_json::json!({"state": "taken"}), &[("cache-control", "no-store")]),
                Ok(Err(refusal)) => plain(axum::http::StatusCode::CONFLICT, &refusal_word(&refusal), refusal.cause()),
                Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
            };
        }
        // A computer posts its own report (always on, takes new accounts, has room) and hears every report held of a
        // computer whose own session is live: how computers learn each other's reports (copy_rule.rs `hear_reports`).
        if to == computers::copy_rule::report_path() {
            let Ok(report) = serde_json::from_slice::<computers::copy_rule::OwnReport>(&body) else {
                return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
            };
            let gateway = self.clone();
            let answered = tokio::task::spawn_blocking(move || gateway.take_report(&from, report)).await;
            return match answered {
                Ok(Some(answer)) => json(axum::http::StatusCode::OK, &answer, &[("cache-control", "no-store")]),
                Ok(None) => plain(axum::http::StatusCode::CONFLICT, "report_refused", crate::cause!()),
                Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
            };
        }
        if to == computers::settings().tell_again_path {
            let Ok(again) = serde_json::from_slice::<computers::messages::TellAgain>(&body) else {
                return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
            };
            let gateway = self.clone();
            let taken = tokio::task::spawn_blocking(move || gateway.connected_computers.tell_again(&address, &from, again.told, again.catching_up)).await;
            return match taken {
                Ok(true) => json(axum::http::StatusCode::OK, &serde_json::json!({"state": "announced"}), &[("cache-control", "no-store")]),
                Ok(false) => plain(axum::http::StatusCode::CONFLICT, "announcement_refused", crate::cause!()),
                Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
            };
        }
        // A writer announces its term on each renewal (`TermAnnouncement`, D10): taken for the computer that sent it, once verified.
        if to == computers::settings().announce_term_path {
            let Ok(announcement) = serde_json::from_slice::<computers::messages::TermAnnouncement>(&body) else {
                return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
            };
            if self.connected_computers.take_term_announcement(&address, &from, &announcement, self.now_ms.now_ms()) {
                return json(axum::http::StatusCode::OK, &serde_json::json!({"state": "announced"}), &[("cache-control", "no-store")]);
            }
            return plain(axum::http::StatusCode::CONFLICT, "announcement_refused", crate::cause!());
        }
        let Ok(post) = serde_json::from_slice::<computers::messages::Post>(&body) else {
            return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
        };
        // Only the explicit command envelope and its dedicated parts may come from an omitted computer. Ordinary
        // settle rows, bucket reads, generic parts, votes and feeds retain the two-member fence; the writer checks
        // the sealed command and refuses a command-part transfer that decodes to any other message.
        let command_settle = post.message.command_settle();
        let writer_term = post.message.writer_term();
        // A pull of the writer's feed by another copy keeper: only the writer answers it with a page, under its term.
        let writer_pull = matches!(post.message, computers::messages::Message::Pull { writer: true, .. });
        if let Some(term) = writer_term {
            match self.connected_computers.term_check(&address, term, self.now_ms.now_ms()) {
                TermCheck::Pass => {}
                TermCheck::Stale => return plain(axum::http::StatusCode::CONFLICT, "stale_writer", crate::cause!()),
                TermCheck::Lapsed => {
                    crate::quiet_eprintln!("connected-computers event=term-lapsed term={term}");
                    return plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!());
                }
            }
        }
        let Ok(input) = serde_json::to_value(computers::messages::MessageFrom { from: from.clone(), message: post.message }) else {
            return plain(axum::http::StatusCode::BAD_REQUEST, "request_refused", crate::cause!());
        };
        let now = self.now_ms.now_ms();
        let gateway = self.clone();
        let answered = tokio::task::spawn_blocking(move || {
            let route = if command_settle {
                gateway.connected_computers.command_settle_route(&address, &to)
            } else {
                gateway.connected_computers.computer_route(&address, &from, &to)
            }.ok_or_else(|| {
                // The sending computer and the account's address name the caller of a refusal (public address only).
                crate::quiet_eprintln!("computer-message event=no-route account={address} from={from} to={to}");
                CodedError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE)
            })?;
            let mut answered_by = to.clone();
            let mut value = gateway.send_computer_message(&route, &computers::settings().message_operation, input.clone(), proof.clone(), request_key.as_deref())?;
            // A computer that does not hold the writer turn names the writer (`not_writer`): the message goes once more to that
            // writer, and a second refusal is the answer.
            if let Some(writer) = not_writer_named(&value).filter(|writer| *writer != to) {
                if let Some(writer_route) = gateway.connected_computers.answering_route(&address, &writer) {
                    value = gateway.send_computer_message(&writer_route, &computers::settings().message_operation, input, proof, request_key.as_deref())?;
                    answered_by = writer;
                }
            }
            // A copy took the writer's message: the forwarder now carries that writer's term.
            if let (Some(term), Ok(answer)) = (writer_term, serde_json::from_value::<computers::messages::Answer>(value.clone())) {
                let taken = matches!(answer, computers::messages::Answer::Applied { .. })
                    || matches!(answer, computers::messages::Answer::Vote { vote, .. } if vote.accepted);
                if taken {
                    gateway.connected_computers.note_writer(&address, &from, term, now);
                }
            }
            // The computer that answered another copy keeper's pull of the writer's feed with a page is the writer at that term:
            // with one voter no writer's message passes here (nothing else votes), so this is how the forwarder learns it.
            if writer_pull {
                if let Ok(computers::messages::Answer::Page { term, .. }) = serde_json::from_value::<computers::messages::Answer>(value.clone()) {
                    if term > 0 {
                        gateway.connected_computers.note_writer(&address, &answered_by, term, now);
                    }
                }
            }
            Ok::<_, CodedError<axum::http::StatusCode>>(value)
        }).await;
        match answered {
            Ok(Ok(value)) => json(axum::http::StatusCode::OK, &value, &[("cache-control", "no-store")]),
            Ok(Err(failure)) => plain(failure.code, failure_word(failure.code), failure.cause()),
            Err(_) => plain(axum::http::StatusCode::SERVICE_UNAVAILABLE, &words().no_live_computer, crate::cause!()),
        }
    }

    /// Send one message of `operation` with `input` on a computer's session `route`, and answer the computer's value. The
    /// failure says what is known of the message: 503 (`no_live_computer`) when it never left (no session stood, or its
    /// deadline passed before it was sent), 504 (`outcome_unknown`) when it may have run (the answer was lost, cannot be
    /// read or is not this message's, or the computer said its outcome is unknown), 502 when the computer refused it.
    /// Before, a lost answer was 503 like a message never sent, so a request that may have run read as one that never
    /// started. The message's deadline is `message_wait_ms`.
    fn send_computer_message(&self, route: &Route, operation: &str, input: Value, authorization: String, request_key: Option<&str>)
        -> Result<Value, CodedError<axum::http::StatusCode>> {
        let mut nonce = [0u8; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce)
            .map_err(|_| CodedError::new(axum::http::StatusCode::SERVICE_UNAVAILABLE))?;
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let wait = i64::try_from(computers::settings().message_wait_ms).unwrap_or(i64::MAX);
        let session_message = crate::resource_authority::InvokeMessage { person_present: None,
            request_id: format!("computer:{nonce}"),
            account_id: route.account_id.clone(),
            device_id: route.device_id.clone(),
            resource_address: route.resource_address.clone(),
            operation_resource: None,
            generation: route.generation.clone(),
            operation: operation.to_owned(),
            input,
            request_key: format!("computer:{}", request_key.unwrap_or(&nonce)),
            client_authorization: authorization,
            deadline_at_ms: self.now_ms.now_ms().saturating_add(wait),
        };
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&session_message).map_err(|_| CodedError::new(axum::http::StatusCode::BAD_REQUEST))?);
        let reply = super::ComputerConnections::invoke(self.connected_computers.as_ref(), route, &bytes);
        computer_reply(&session_message.request_id, (&route.account_id, &route.device_id), reply)
    }

    /// Consume the Mac's credential from a confidential stream with I/O
    /// deadlines, install its exact current route, then acknowledge the connection.
    /// A rejected credential, registration or acknowledgement leaves no new
    /// route. The Mac's dispatcher still checks client rights at commitment.
    pub fn admit_mac_connection<S: Read + Write + Send + 'static>(
        &self,
        stream: S,
    ) -> Result<Route, CodedError<()>> {
        let _permit = self.reserve_admission()?;
        self.admit_mac_connection_inner(stream, "")
    }

    fn reserve_admission(&self) -> Result<PendingAdmission<'_>, CodedError<()>> {
        self.pending_admissions
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_PENDING_MAC_ADMISSIONS).then_some(current + 1)
            })
            .map_err(|_| { let error = CodedError::new(()); crate::quiet_eprintln!("session-admission event=refused reason=busy cause={}", error.cause()); error })?;
        Ok(PendingAdmission(&self.pending_admissions))
    }

    fn admit_mac_connection_inner<S: Read + Write + Send + 'static>(
        &self,
        stream: S,
        peer: &str,
    ) -> Result<Route, CodedError<()>> {
        let session = Arc::new(
            ForwarderConnection::admit_from_stream(stream, self.admission.clone(), self.now_ms.clone())
                .ok_or_else(|| CodedError::new(()))?,
        );
        session.set_peer(peer);
        let route = session.route().clone();
        self.connected_computers.install(session)?;
        Ok(route)
    }

    /// Upgrade the exact resource-connection path on a caller-supplied TLS
    /// stream, then perform the ordinary registration and check into the connected computers.
    pub fn admit_mac_websocket<S: Read + Write + Send + 'static>(
        &self,
        stream: S,
        peer: &str,
    ) -> Result<Route, CodedError<()>> {
        let _permit = self.reserve_admission()?;
        let stream = accept_resource_websocket(stream, &self.expected_host)?;
        self.admit_mac_connection_inner(stream, peer)
    }

    /// Admit the Mac's resource connection whose WebSocket upgrade the door already answered (`ingress.rs`, after
    /// `websocket::upgrade_admissible`): one of the pending slots, then the device credential and registration, as
    /// `admit_mac_websocket` does after its own handshake.
    pub(crate) fn admit_mac_upgraded<S: Read + Write + Send + 'static>(
        &self,
        stream: S,
        peer: &str,
    ) -> Result<Route, CodedError<()>> {
        let _permit = self.reserve_admission()?;
        self.admit_mac_connection_inner(super::websocket::resource_websocket_upgraded(stream), peer)
    }
}

impl CallAnswerer for Gateway {
    fn invoke_with_disclosure(&self, principal: &Principal, bearer: &[u8], call: Operation,
        disclosure: &crate::mcp::RequestDisclosure) -> Result<Value, OperationFailure> {
        crate::storage::request_work::RequestWork::uncovered();
        self.invoke_guarded(principal, bearer, call, disclosure)
    }

    fn instruction_text_with_disclosure(
        &self, principal: &Principal, bearer: &[u8], part: crate::mcp::instructions::MetadataPart,
        disclosure: &crate::mcp::RequestDisclosure,
    ) -> Option<String> {
        let call = crate::mcp::instructions::metadata_call(part)?;
        self.invoke_with_disclosure(principal, bearer, call, disclosure).ok()?.as_str().map(str::to_owned)
    }

    fn invoke_with_bearer(&self, principal: &Principal, bearer: &[u8], call: Operation) -> Result<Value, OperationFailure> {
        crate::storage::request_work::RequestWork::uncovered();
        CallAnswerer::invoke_with_bearer(
            &McpForwarder { directory: self.connected_computers.as_ref(), issuer: self.issuer.as_ref(),
                      connections: self.connected_computers.as_ref(), now_ms: self.now_ms.clone() },
            principal, bearer, call,
        )
    }

    fn invoke(&self, principal: &Principal, call: Operation) -> Result<Value, OperationFailure> {
        crate::storage::request_work::RequestWork::uncovered();
        CallAnswerer::invoke(
            &McpForwarder {
                directory: self.connected_computers.as_ref(),
                issuer: self.issuer.as_ref(),
                connections: self.connected_computers.as_ref(),
                now_ms: self.now_ms.clone(),
            },
            principal,
            call,
        )
    }
}

/// The resource every computer session is opened on (`remote_connection_check::computer_route`).
const COMPUTER_RESOURCE: &str = "@own-records";

/// A short answer that names no account, address or credential.
fn plain(status: axum::http::StatusCode, word: &str, cause: crate::refusal_cause::Cause) -> axum::response::Response {
    let mut body = serde_json::json!({"error": word});
    if !status.is_success() {
        body["cause"] = serde_json::json!(cause.id());
        crate::quiet_eprintln!("door-refusal status={} cause={cause}", status.as_u16());
    }
    json(status, &body, &[("cache-control", "no-store")])
}

/// Longest bearer the forwarder carries, in bytes.
const MAX_BEARER_BYTES: usize = 8 * 1024;

/// The plain words the forwarder answers with (`words.json`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Words {
    #[serde(rename = "_what")]
    _what: String,
    no_live_computer: String,
    outcome_unknown: String,
    origin_contested: String,
    origin_not_believed: String,
    origin_stale: String,
    origin_taken: String,
    origin_unproven: String,
    origins_full: String,
    origin_reserved: String,
}

/// The word an origins refusal answers with. The host is not named back: a refusal tells the computer which rule refused.
fn refusal_word(refusal: &origins::Refusal) -> String {
    let words = words();
    match refusal {
        origins::Refusal::NotBelieved(_) => &words.origin_not_believed,
        origins::Refusal::Stale(_) => &words.origin_stale,
        origins::Refusal::Taken(_, _) => &words.origin_taken,
        origins::Refusal::Unproven(_, _) => &words.origin_unproven,
        origins::Refusal::Full(_) => &words.origins_full,
        origins::Refusal::Reserved(_, _) => &words.origin_reserved,
    }.clone()
}

/// What a computer's session answered for one message the forwarder sent it (`send_computer_message`), as the
/// computer's value or the status that says what is known of the message: 503 never sent, 504 outcome unknown, 502
/// refused by the computer.
fn computer_reply(request_id: &str, (account, computer): (&str, &str), reply: Result<Vec<u8>, CodedError<()>>) -> Result<Value, CodedError<axum::http::StatusCode>> {
    let unknown = axum::http::StatusCode::GATEWAY_TIMEOUT;
    let reply = reply.map_err(|error| CodedError::with_cause(unknown, error.cause()))?;
    let read = serde_json::from_slice::<super::DeviceReply>(&reply).map_err(|_| {
        crate::quiet_eprintln!("computer-message event=unreadable-reply {}", super::reply_shape(&reply));
        CodedError::new(unknown)
    })?;
    match read {
        super::DeviceReply::Completed { request_id: id, value } if id == request_id => Ok(value),
        // The session no longer stood, or the message's deadline passed, before it left: no computer was reached.
        super::DeviceReply::Refused { request_id: id, code, cause } if id == request_id
            && (code == super::ROUTE_UNAVAILABLE || code == super::DEADLINE_ELAPSED) =>
        {
            crate::quiet_eprintln!("computer-message event=not-started reason={} cause={cause}", computer_refusal_class(&code));
            Err(CodedError::with_cause(axum::http::StatusCode::SERVICE_UNAVAILABLE, cause))
        }
        super::DeviceReply::Refused { request_id: id, code, cause } if id == request_id => {
            crate::quiet_eprintln!("computer-message event=refused-by-computer reason={} account={account} computer={computer} cause={cause}", computer_refusal_class(&code));
            Err(CodedError::with_cause(axum::http::StatusCode::BAD_GATEWAY, cause))
        }
        super::DeviceReply::OutcomeUnknown { request_id: id, cause } if id == request_id => Err(CodedError::with_cause(unknown, cause)),
        _ => Err(CodedError::new(unknown)),
    }
}

/// The writer a computer's answer to a message names as `not_writer` (`Answer::Refused`), when it names one.
fn not_writer_named(value: &Value) -> Option<String> {
    match serde_json::from_value::<computers::messages::Answer>(value.clone()).ok()? {
        computers::messages::Answer::Refused { code, writer, .. } if code == "not_writer" => writer.map(|writer| writer.computer),
        _ => None,
    }
}

/// Whether an HTTP answer is a computer's `not_held` refusal: a 503 whose body is `{"refused":"not_held"}`
/// (`email_address::not_held`).
fn http_not_held(value: &Value) -> bool {
    use base64::Engine as _;
    let Ok(answer) = serde_json::from_value::<computers::messages::HttpAnswer>(value.clone()) else { return false };
    if answer.status != axum::http::StatusCode::SERVICE_UNAVAILABLE.as_u16() {
        return false;
    }
    let Ok(body) = base64::engine::general_purpose::STANDARD.decode(answer.body.as_bytes()) else { return false };
    serde_json::from_slice::<Value>(&body).ok().and_then(|body| body.get("refused")?.as_str().map(|word| word == computers::messages::NOT_HELD)).unwrap_or(false)
}

/// The writer an HTTP answer names as `not_writer`: a 409 whose body is `{"refused":"not_writer","writer":<computer>}`
/// (`module_computer/object.rs`), when it names one.
fn http_not_writer(answer: &computers::messages::HttpAnswer) -> Option<String> {
    use base64::Engine as _;
    if answer.status != axum::http::StatusCode::CONFLICT.as_u16() {
        return None;
    }
    let body = base64::engine::general_purpose::STANDARD.decode(answer.body.as_bytes()).ok()?;
    let body: Value = serde_json::from_slice(&body).ok()?;
    if body.get("refused")?.as_str()? != "not_writer" {
        return None;
    }
    body.get("writer")?.as_str().map(str::to_owned)
}

/// A fixed diagnostic class only: a peer's arbitrary refusal text may contain private material and is never logged.
fn computer_refusal_class(code: &str) -> &'static str {
    match code {
        super::ROUTE_UNAVAILABLE => "route-unavailable",
        super::DEADLINE_ELAPSED => "deadline-before-send",
        "no_copies_here" => "no-copies-here",
        "not_answering_yet" => "not-answering-yet",
        _ => "other",
    }
}

/// The word of a failed message's status (`computer_reply`).
fn failure_word(status: axum::http::StatusCode) -> &'static str {
    if status == axum::http::StatusCode::GATEWAY_TIMEOUT { &words().outcome_unknown } else { &words().no_live_computer }
}

pub(crate) fn words() -> &'static Words {
    static WORDS: OnceLock<Words> = OnceLock::new();
    WORDS.get_or_init(|| serde_json::from_slice(include_bytes!("words.json")).expect("words.json is valid"))
}

/// The forwarder's bearer check: the one signed-in check (`account::signed_in::verify`). The bearer is a JWT the
/// sign-in tool signed; its signature, issuer, audience and times are checked against that tool's JWKS, and its account
/// claim names the account it signs in to, so no computer is asked who it is. A token that does not check, or names no
/// account, is 401; a JWKS that cannot be read is 503 and never admits. The account's computer admits the same
/// credential again for every operation.
struct SignedInAuthenticator;

impl BearerAuthenticator for SignedInAuthenticator {
    fn authenticate(&self, bearer: &[u8]) -> Option<Principal> {
        self.authenticate_current(bearer).ok()
    }

    fn authenticate_current(&self, bearer: &[u8]) -> Result<Principal, AuthenticationFailure> {
        let Ok(text) = std::str::from_utf8(bearer) else { return Err(crate::cause!(AuthenticationFailure::Unauthorized)) };
        if text.is_empty() || text.len() > MAX_BEARER_BYTES || !text.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(crate::cause!(AuthenticationFailure::Unauthorized));
        }
        let signed = signed_in::verify(text).map_err(|refused| match refused {
            signed_in::Refused::Invalid(cause) => AuthenticationFailure::Unauthorized(cause),
            signed_in::Refused::KeysUnavailable(cause) => AuthenticationFailure::Unavailable(cause),
        })?;
        if !tokens::owner_text_ok(&signed.account) {
            return Err(crate::cause!(AuthenticationFailure::Unauthorized));
        }
        let principal = Principal { kind: crate::mcp::PrincipalKind::Person,
            account_id: signed.account,
            sign_in: signed.sign_in,
            client_id: signed.client_id.unwrap_or_default(),
        };
        if !principal.valid() {
            return Err(crate::cause!(AuthenticationFailure::Unauthorized));
        }
        Ok(principal)
    }
}

/// Carries the exact bearer the account routes admitted for this request into each message of it, for the same account.
/// It is transport custody, not a proof: the account routes admit the credential again for every operation.
struct BearerForwarder;

impl ClientProofIssuer for BearerForwarder {
    fn issue(&self, _principal: &Principal, _message: &crate::resource_authority::InvokeMessage) -> Option<String> {
        None
    }

    fn issue_with_bearer(&self, principal: &Principal, bearer: &[u8], session_message: &crate::resource_authority::InvokeMessage)
        -> Option<String> {
        if !principal.valid() || session_message.account_id != principal.account_id || !session_message.client_authorization.is_empty() {
            return None;
        }
        std::str::from_utf8(bearer).ok().filter(|text| !text.is_empty() && text.len() <= MAX_BEARER_BYTES).map(str::to_owned)
    }
}

#[cfg(test)]
mod door_authenticator_tests {
    use super::*;
    use crate::mcp::http::BearerAuthenticator;

    const ACCOUNT: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn now() -> i64 {
        1_000
    }

    /// A message carried to a computer says what is known of it: never sent (503), may have run (504), refused (502).
    #[test]
    fn a_carried_message_that_may_have_run_is_never_said_to_be_unavailable() {
        use axum::http::StatusCode;
        let id = "computer:one";
        let reply = |value: serde_json::Value| Ok(serde_json::to_vec(&value).unwrap());
        assert_eq!(computer_reply(id, ("account", "computer"), reply(serde_json::json!({"state": "completed", "request_id": id, "value": 7}))).map_err(|failure| failure.code), Ok(serde_json::json!(7)));
        for code in [super::super::ROUTE_UNAVAILABLE, super::super::DEADLINE_ELAPSED] {
            assert_eq!(computer_reply(id, ("account", "computer"), reply(serde_json::json!({"state": "refused", "cause": crate::cause!().id(), "request_id": id, "code": code}))).map_err(|failure| failure.code),
                Err(StatusCode::SERVICE_UNAVAILABLE), "{code}: never sent");
        }
        assert_eq!(computer_reply(id, ("account", "computer"), reply(serde_json::json!({"state": "refused", "cause": crate::cause!().id(), "request_id": id, "code": "no_copies_here"}))).map_err(|failure| failure.code),
            Err(StatusCode::BAD_GATEWAY));
        for unknown in [
            Err(CodedError::new(())),
            Ok(b"not json".to_vec()),
            reply(serde_json::json!({"state": "outcome_unknown", "cause": crate::cause!().id(), "request_id": id})),
            reply(serde_json::json!({"state": "completed", "request_id": "computer:other", "value": 7})),
            reply(serde_json::json!({"state": "refused", "cause": crate::cause!().id(), "request_id": "computer:other", "code": super::super::ROUTE_UNAVAILABLE})),
        ] {
            assert_eq!(computer_reply(id, ("account", "computer"), unknown).map_err(|failure| failure.code), Err(StatusCode::GATEWAY_TIMEOUT));
        }
        assert_eq!(failure_word(StatusCode::GATEWAY_TIMEOUT), "outcome_unknown");
        assert_eq!(failure_word(StatusCode::SERVICE_UNAVAILABLE), "unavailable");
        assert_eq!(computer_refusal_class("no_copies_here"), "no-copies-here");
        assert_eq!(computer_refusal_class("not_answering_yet"), "not-answering-yet");
        assert_eq!(computer_refusal_class("synthetic-peer-controlled-text"), "other");
        assert_eq!(computer_reply(id, ("account", "computer"), reply(serde_json::json!({"state":"refused", "cause": crate::cause!().id(), "request_id":id,
            "code":"synthetic-peer-controlled-text"}))).map_err(|failure| failure.code), Err(StatusCode::BAD_GATEWAY));
    }

    /// Command-only settle routing never substitutes a caller bearer or a routing string for the computer's own
    /// short-lived proof. The ordinary proof check runs before the omitted-sender command route can be selected.
    #[tokio::test]
    async fn a_command_settle_needs_a_current_computer_message_proof_for_its_account() {
        use axum::{body::Body, http::{Request, StatusCode}};
        use crate::{account::computers::ComputerSigner, secrets::secrets_key::ComputerKey};
        let computer = ComputerKey::from_bytes(vec![7; 32]).unwrap();
        let signer = ComputerSigner::of(&computer).unwrap();
        let gateway = Arc::new(Gateway::with_computers("forwarder.example.test", crate::storage::time_source::fixed(now())));
        let body = serde_json::json!({"message":{"kind":"settle_command","request":{"id":"request-one","payload":{"sealed":"opaque"}}}});
        let valid = signer.message_credential(ACCOUNT, now());
        let mut damaged = valid.clone().into_bytes();
        let last = damaged.last_mut().unwrap();
        *last = if *last == b'a' { b'b' } else { b'a' };
        let damaged = String::from_utf8(damaged).unwrap();
        let wrong_account = signer.message_credential("2222222222222222222222222222222222222222222222222222222222222222", now());
        let old = signer.message_credential(ACCOUNT, now() - crate::account::computers::settings().computer_proof_window_ms - 1);
        let session = signer.session_credential(ACCOUNT, now());
        for bearer in [None, Some("not-a-proof"), Some(damaged.as_str()), Some(wrong_account.as_str()), Some(old.as_str()), Some(session.as_str())] {
            let mut request = Request::builder().method("POST");
            if let Some(bearer) = bearer { request = request.header("authorization", format!("Bearer {bearer}")); }
            let response = gateway.clone().pass_message(ACCOUNT.into(), signer.computer_id(),
                request.body(Body::from(body.to_string())).unwrap()).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        let response = gateway.pass_message(ACCOUNT.into(), signer.computer_id(), Request::builder().method("POST")
            .header("authorization", format!("Bearer {valid}")).body(Body::from(body.to_string())).unwrap()).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "a proved sender still needs a live signed destination");
    }

    /// The bearer check reads nothing but the token: a credential that is not a signed JWT (an old opaque token, an old
    /// personal key, nothing) is refused 401 before any key is read or any computer is asked.
    #[test]
    fn a_credential_that_is_not_a_signed_token_is_refused_before_anything_is_read() {
        let old_token = format!("{ACCOUNT}.{}", "a".repeat(43));
        let old_key = format!("nm_{}", "a".repeat(64));
        for presented in [old_token.as_str(), old_key.as_str(), "", "not a credential"] {
            assert_eq!(
                SignedInAuthenticator.authenticate_current(presented.as_bytes()),
                Err(crate::cause!(AuthenticationFailure::Unauthorized)),
                "credential {presented:?}",
            );
        }
        assert_eq!(words().no_live_computer, "unavailable");
    }
}

#[cfg(test)]
mod no_account_tests {
    use super::*;
    use tower::ServiceExt;

    async fn ask(method: &str, uri: &str) -> (axum::http::StatusCode, String) {
        let gateway = Gateway::with_computers("forwarder.example.test", crate::storage::time_source::fixed(1_000));
        let service = Arc::new(gateway).http_route_table().unwrap();
        let request = axum::http::Request::builder().method(method).uri(uri)
            .header(axum::http::header::HOST, "forwarder.example.test").body(axum::body::Body::empty()).unwrap();
        let response = service.oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1 << 16).await.unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    /// A path that names no account is nobody's: the forwarder answers no sign-in, sign-up or OAuth path of its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_path_that_names_no_account_is_nobodys() {
        for (method, uri) in [("GET", "/"), ("HEAD", "/"), ("POST", "/"), ("GET", "/sign-up"), ("GET", "/sign-in"),
            ("GET", "/authorize"), ("POST", "/oauth/token"), ("GET", "/.well-known/oauth-authorization-server"), ("GET", "/not-a-page")] {
            let (status, body) = ask(method, uri).await;
            assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "{method} {uri}");
            if method != "HEAD" {
                assert!(body.contains("no_account"), "{method} {uri}: {body}");
            }
        }
    }

    /// A path that names an account with no live computer is 503 with the plain word.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn an_account_path_with_no_live_computer_is_unavailable() {
        let (status, body) = ask("GET", &format!("/a/{}/", "a".repeat(64))).await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE);
        assert!(body.contains(&words().no_live_computer), "{body}");
    }

    #[tokio::test]
    async fn computer_refusal_source_reaches_the_http_caller_unchanged() {
        let cause = crate::cause!(condition: synthetic_computer_rights_refused);
        let bytes = serde_json::to_vec(&super::super::DeviceReply::Refused {
            request_id: "synthetic-request".into(),
            code: "current_workspace_rights_refused".into(),
            cause: cause.clone(),
        }).unwrap();
        let failure = computer_reply("synthetic-request", ("account", "computer"), Ok(bytes)).unwrap_err();
        assert_eq!(failure.code, axum::http::StatusCode::BAD_GATEWAY);
        assert_eq!(failure.cause().id(), cause.id());
        let response = plain(failure.code, failure_word(failure.code), failure.cause());
        let bytes = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], failure_word(failure.code));
        assert_eq!(body["cause"], cause.id());
    }

}

#[cfg(test)]
mod not_writer_tests {
    use super::{http_not_writer, not_writer_named};
    use crate::account::computers::messages::{Answer, HttpAnswer, RefusedWriter};
    use base64::Engine as _;

    const WRITER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    /// D09: a copy's message answer names the writer of a `not_writer` refusal, and nothing else is followed.
    #[test]
    fn a_not_writer_message_answer_names_its_writer() {
        let refused = |code: &str, writer: Option<&str>| serde_json::to_value(Answer::Refused {
            code: code.to_owned(),
            cause: crate::cause!(),
            writer: writer.map(|computer| RefusedWriter { computer: computer.to_owned(), term: 2 }),
        }).expect("an answer serializes");
        assert_eq!(not_writer_named(&refused("not_writer", Some(WRITER))).as_deref(), Some(WRITER));
        assert_eq!(not_writer_named(&refused("not_writer", None)), None, "a refusal that names no writer has nothing to follow");
        assert_eq!(not_writer_named(&refused("held_put_not_writer", Some(WRITER))), None, "another refusal is not followed");
        assert_eq!(not_writer_named(&serde_json::json!({"kind": "done"})), None, "an answer that is not a refusal is not followed");
    }

    /// D09: an HTTP answer names the writer of a `not_writer` refusal only when it is that 409 with the writer's name.
    #[test]
    fn an_http_not_writer_answer_names_its_writer() {
        let answer = |status: u16, body: serde_json::Value| HttpAnswer {
            status,
            headers: Vec::new(),
            body: base64::engine::general_purpose::STANDARD.encode(body.to_string()),
            whole: None,
        };
        assert_eq!(http_not_writer(&answer(409, serde_json::json!({"refused": "not_writer", "writer": WRITER}))).as_deref(), Some(WRITER));
        assert_eq!(http_not_writer(&answer(200, serde_json::json!({"refused": "not_writer", "writer": WRITER}))), None,
            "only a 409 is the writer turn refusal");
        assert_eq!(http_not_writer(&answer(409, serde_json::json!({"refused": "not_writer"}))), None, "no name, nothing to follow");
        assert_eq!(http_not_writer(&answer(409, serde_json::json!({"refused": "not_placed"}))), None);
    }
}

#[cfg(test)]
mod writer_follow_tests {
    //! The forwarder's send-and-retry (D09) and the verified writer announcement (D10), end to end through `pass_message` and
    //! `forward_http`: the live computers are fakes that answer the invoke frames the session carries, as a copy would.
    use super::*;
    use crate::account::computers::{AccountKey, ComputerSigner, ComputersRow, KeptAccount, messages::{Answer, HttpAnswer, Message, Post, RefusedWriter, TermAnnouncement}};
    use crate::forwarder::connected_computers::TestComputer;
    use base64::Engine as _;
    use std::sync::atomic::AtomicUsize;

    const NOW: i64 = 1_800_000_000_000;

    fn clock() -> i64 {
        NOW
    }

    fn signer(byte: u8) -> ComputerSigner {
        ComputerSigner::of(&crate::secrets::secrets_key::ComputerKey::from_bytes(vec![byte; 32]).unwrap()).unwrap()
    }

    /// How a fake computer answers: it holds the writer turn, or it refuses a message (and an HTTP request) as `not_writer`
    /// naming the writer it was told of, or it does not hold the account and refuses an HTTP request as `not_held`.
    #[derive(Clone)]
    enum Behaviour {
        Writer,
        Refuses(String),
        Lacks,
        /// Holds a file of this many bytes, `i % 251` at byte i: answers a whole read with its first `BIG_WINDOW` bytes and the
        /// file's size, and a range read with that range, as a computer does for a file larger than one answer.
        Big(u64),
    }

    const BIG_WINDOW: u64 = 1000;

    /// A live computer of the account: what it tells, and how it answers. `calls` counts the frames it was sent.
    struct FakeComputer {
        told: Vec<KeptAccount>,
        behaviour: Behaviour,
        calls: AtomicUsize,
    }

    impl TestComputer for FakeComputer {
        fn told(&self) -> Vec<KeptAccount> {
            self.told.clone()
        }
        fn catching_up(&self, _address: &str) -> bool {
            false
        }
        fn live(&self) -> bool {
            true
        }
        fn reply(&self, message: &[u8]) -> Option<Vec<u8>> {
            self.calls.fetch_add(1, Ordering::AcqRel);
            let frame: Value = serde_json::from_slice(message).ok()?;
            let is_http = frame.get("operation")?.as_str()? == computers::settings().http_operation;
            let value = match (&self.behaviour, is_http) {
                (Behaviour::Writer, false) => serde_json::to_value(Answer::Done).ok()?,
                (Behaviour::Refuses(writer), false) => serde_json::to_value(Answer::Refused {
                    code: "not_writer".into(),
                    cause: crate::cause!(),
                    writer: Some(RefusedWriter { computer: writer.clone(), term: 2 }),
                }).ok()?,
                (Behaviour::Writer, true) => http_answer(200, b"ok"),
                (Behaviour::Refuses(writer), true) => http_answer(409, serde_json::json!({"refused": "not_writer", "writer": writer}).to_string().as_bytes()),
                (Behaviour::Lacks, false) => serde_json::to_value(Answer::Done).ok()?,
                (Behaviour::Lacks, true) => http_answer(503, serde_json::json!({"refused": computers::messages::NOT_HELD}).to_string().as_bytes()),
                (Behaviour::Big(_), false) => serde_json::to_value(Answer::Done).ok()?,
                (Behaviour::Big(total), true) => {
                    let ask: computers::messages::HttpAsk = serde_json::from_value(frame.get("input")?.clone()).ok()?;
                    let bytes = |from: u64, to: u64| (from..=to).map(|index| (index % 251) as u8).collect::<Vec<u8>>();
                    match ask.headers.iter().find(|(name, _)| name == "range") {
                        Some((_, range)) => {
                            let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
                            let (from, to): (u64, u64) = (from.parse().ok()?, to.parse().ok()?);
                            http_answer(206, &bytes(from, to.min(total - 1)))
                        }
                        None if ask.stream => {
                            let mut first = http_answer(200, &bytes(0, BIG_WINDOW - 1));
                            first["whole"] = serde_json::json!(total);
                            first
                        }
                        None => http_answer(413, b"too large"),
                    }
                }
            };
            serde_json::to_vec(&serde_json::json!({"state": "completed", "request_id": frame.get("request_id")?, "value": value})).ok()
        }
    }

    fn http_answer(status: u16, body: &[u8]) -> Value {
        serde_json::to_value(HttpAnswer { status, headers: Vec::new(), body: base64::engine::general_purpose::STANDARD.encode(body), whole: None }).unwrap()
    }

    /// A gateway whose account is held by `live` computers (each told the row that names `holders`), with the account's key
    /// and address. Returns the gateway, the address, and each live computer's fake.
    fn account_with(holders: &[String], live: &[(String, Behaviour)]) -> (Arc<Gateway>, String, Vec<(String, Arc<FakeComputer>)>) {
        let key = AccountKey::generate().expect("key");
        let address = key.address();
        let row = ComputersRow::sign_with_voters(&address, 1, holders, holders, holders, &key).expect("signed row");
        let told = KeptAccount { row, account_key: key.public_hex() };
        let gateway = Arc::new(Gateway::with_computers("forwarder.example.test", crate::storage::time_source::fixed(clock())));
        let mut fakes = Vec::new();
        for (id, behaviour) in live {
            let fake = Arc::new(FakeComputer { told: vec![told.clone()], behaviour: behaviour.clone(), calls: AtomicUsize::new(0) });
            gateway.connected_computers.live_for_test(&address, id, fake.clone());
            fakes.push((id.clone(), fake));
        }
        (gateway, address, fakes)
    }

    fn calls(fakes: &[(String, Arc<FakeComputer>)], id: &str) -> usize {
        fakes.iter().find(|(name, _)| name == id).map_or(0, |(_, fake)| fake.calls.load(Ordering::Acquire))
    }

    /// A computer's message to `to`, bearing its own proof for the account.
    fn message_from(sender: &ComputerSigner, address: &str, message: &Message) -> axum::extract::Request {
        let body = serde_json::to_vec(&Post { message: message.clone() }).unwrap();
        axum::extract::Request::builder()
            .method(axum::http::Method::POST)
            .uri("/a/unused/message/unused")
            .header(axum::http::header::AUTHORIZATION, format!("Bearer {}", sender.message_credential(address, NOW)))
            .body(axum::body::Body::from(body))
            .unwrap()
    }

    async fn answer_body(response: axum::response::Response) -> (axum::http::StatusCode, Vec<u8>) {
        let status = response.status();
        (status, axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec())
    }

    /// D09: a computer that does not hold the writer turn names the writer; the message goes once more there and lands.
    #[tokio::test]
    async fn a_message_refused_as_not_writer_lands_once_at_the_named_writer() {
        let (sender, writer, other) = (signer(51), signer(52), signer(53));
        let holders = [sender.computer_id(), writer.computer_id(), other.computer_id()];
        let (gateway, address, fakes) = account_with(&holders, &[
            (sender.computer_id(), Behaviour::Writer),
            (writer.computer_id(), Behaviour::Writer),
            (other.computer_id(), Behaviour::Refuses(writer.computer_id())),
        ]);
        let request = message_from(&sender, &address, &Message::Stamps);
        let (status, body) = answer_body(gateway.clone().pass_message(address.clone(), other.computer_id(), request).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(serde_json::from_slice::<Answer>(&body).unwrap(), Answer::Done, "the writer's answer is the answer");
        assert_eq!((calls(&fakes, &other.computer_id()), calls(&fakes, &writer.computer_id())), (1, 1), "one refusal, one retry");
    }

    /// D09: a second `not_writer` refusal is the answer; the message is not sent a third time.
    #[tokio::test]
    async fn a_second_not_writer_refusal_is_returned_without_another_retry() {
        let (sender, writer, other) = (signer(54), signer(55), signer(56));
        let holders = [sender.computer_id(), writer.computer_id(), other.computer_id()];
        let (gateway, address, fakes) = account_with(&holders, &[
            (sender.computer_id(), Behaviour::Writer),
            (writer.computer_id(), Behaviour::Refuses(other.computer_id())),
            (other.computer_id(), Behaviour::Refuses(writer.computer_id())),
        ]);
        let request = message_from(&sender, &address, &Message::Stamps);
        let (status, body) = answer_body(gateway.clone().pass_message(address.clone(), other.computer_id(), request).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert!(matches!(serde_json::from_slice::<Answer>(&body).unwrap(), Answer::Refused { ref code, .. } if code == "not_writer"));
        assert_eq!((calls(&fakes, &other.computer_id()), calls(&fakes, &writer.computer_id())), (1, 1));
    }

    /// D09: the named writer that has no live session gets no retry; the refusal stands.
    #[tokio::test]
    async fn a_named_writer_with_no_live_session_is_not_retried() {
        let (sender, writer, other) = (signer(57), signer(58), signer(59));
        let holders = [sender.computer_id(), writer.computer_id(), other.computer_id()];
        let (gateway, address, fakes) = account_with(&holders, &[
            (sender.computer_id(), Behaviour::Writer),
            (other.computer_id(), Behaviour::Refuses(writer.computer_id())),
        ]);
        let request = message_from(&sender, &address, &Message::Stamps);
        let (status, body) = answer_body(gateway.clone().pass_message(address.clone(), other.computer_id(), request).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert!(matches!(serde_json::from_slice::<Answer>(&body).unwrap(), Answer::Refused { ref code, .. } if code == "not_writer"));
        assert_eq!(calls(&fakes, &other.computer_id()), 1);
    }

    /// D09 on the HTTP path: the request goes to the writer memory's computer, which refuses with a 409 naming the writer;
    /// the request goes once more to that writer and its answer is the answer.
    #[tokio::test]
    async fn an_http_request_refused_as_not_writer_lands_once_at_the_named_writer() {
        let (writer, other) = (signer(60), signer(61));
        let holders = [writer.computer_id(), other.computer_id()];
        let (gateway, address, fakes) = account_with(&holders, &[
            (writer.computer_id(), Behaviour::Writer),
            (other.computer_id(), Behaviour::Refuses(writer.computer_id())),
        ]);
        // The forwarder carried a writer from the other computer first, so the request is sent there.
        gateway.connected_computers.note_writer(&address, &other.computer_id(), 1, NOW);
        let request = axum::extract::Request::builder().method(axum::http::Method::POST).uri("/records").body(axum::body::Body::empty()).unwrap();
        let (status, body) = answer_body(gateway.clone().forward_http(address.clone(), request).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body, b"ok", "the writer's answer is the answer");
        assert_eq!((calls(&fakes, &other.computer_id()), calls(&fakes, &writer.computer_id())), (1, 1));
    }

    /// A whole read of a file larger than one computer answer is streamed: the computer answers the first window and the file's
    /// size, the forwarder fetches the rest by range from that computer, and the visitor gets one 200 of the file's whole length.
    /// Red before: the answer was the first window alone with a 200.
    #[tokio::test]
    async fn a_whole_read_of_a_file_larger_than_one_answer_is_streamed_whole() {
        let computer = signer(70);
        let total = 2_500u64;
        let (gateway, address, fakes) = account_with(&[computer.computer_id()], &[(computer.computer_id(), Behaviour::Big(total))]);
        let request = axum::extract::Request::builder().method(axum::http::Method::GET).uri("/installations/x/file.bin").body(axum::body::Body::empty()).unwrap();
        let response = gateway.clone().forward_http(address.clone(), request).await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(response.headers().get(axum::http::header::CONTENT_LENGTH).and_then(|length| length.to_str().ok()), Some("2500"));
        let (_, body) = answer_body(response).await;
        let wanted: Vec<u8> = (0..total).map(|index| (index % 251) as u8).collect();
        assert_eq!(body, wanted, "every window, in order");
        assert_eq!(calls(&fakes, &computer.computer_id()), 3, "the first window, then two ranges of at most one window");
    }

    /// A place that does not hold the account refuses the request `not_held` with nothing done; the request goes on to the
    /// computer that holds it, and that computer's answer is the answer.
    #[tokio::test]
    async fn a_request_refused_as_not_held_passes_to_a_computer_that_holds_the_account() {
        let (lacking, holder) = (signer(64), signer(65));
        let holders = [lacking.computer_id(), holder.computer_id()];
        let (gateway, address, fakes) = account_with(&holders, &[
            (lacking.computer_id(), Behaviour::Lacks),
            (holder.computer_id(), Behaviour::Writer),
        ]);
        // The forwarder's first choice is the computer that does not hold the account.
        gateway.connected_computers.note_writer(&address, &lacking.computer_id(), 1, NOW);
        let request = axum::extract::Request::builder().method(axum::http::Method::POST).uri("/sign-in/email-address").body(axum::body::Body::empty()).unwrap();
        let (status, body) = answer_body(gateway.clone().forward_http(address.clone(), request).await).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body, b"ok", "the holder's answer is the answer");
        assert_eq!((calls(&fakes, &lacking.computer_id()), calls(&fakes, &holder.computer_id())), (1, 1), "one refusal, one retry");
    }

    /// D10: a fresh forwarder with no writer carried learns the writer from the writer's own verified announcement, and a
    /// forged announcement from another computer is refused and carries nothing.
    #[tokio::test]
    async fn a_fresh_forwarder_routes_the_first_write_to_the_writer_after_one_announcement() {
        let (writer, other) = (signer(62), signer(63));
        let holders = [writer.computer_id(), other.computer_id()];
        let (gateway, address, _fakes) = account_with(&holders, &[
            (writer.computer_id(), Behaviour::Writer),
            (other.computer_id(), Behaviour::Refuses(writer.computer_id())),
        ]);
        assert_eq!(gateway.connected_computers.writer(&address), None);
        let term_ms = computers::settings().term_ms;
        let announce = |signer: &ComputerSigner, term: u64| {
            let parts = TermAnnouncement::signed_parts(&address, term, NOW + term_ms);
            let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
            TermAnnouncement { term, expires_at_ms: NOW + term_ms, at: NOW, signature: signer.sign_use("term", &parts, NOW).unwrap() }
        };
        let path = computers::settings().announce_term_path.clone();
        let post = |sender: &ComputerSigner, announcement: &TermAnnouncement| {
            axum::extract::Request::builder()
                .method(axum::http::Method::POST)
                .uri("/a/unused/message/unused")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {}", sender.message_credential(&address, NOW)))
                .body(axum::body::Body::from(serde_json::to_vec(announcement).unwrap()))
                .unwrap()
        };
        let forged = gateway.clone().pass_message(address.clone(), path.clone(), post(&other, &announce(&writer, 2))).await;
        assert_eq!(forged.status(), axum::http::StatusCode::CONFLICT, "a writer's signature sent by another computer is refused");
        assert_eq!(gateway.connected_computers.writer(&address), None);
        let verified = gateway.clone().pass_message(address.clone(), path, post(&writer, &announce(&writer, 2))).await;
        assert_eq!(verified.status(), axum::http::StatusCode::OK);
        assert_eq!(gateway.connected_computers.routing_writer(&address), Some((2, writer.computer_id())));
        let routed = RouteDirectory::current_route(gateway.connected_computers.as_ref(), &address, "@own-records");
        assert_eq!(routed.map(|route| route.device_id), Some(writer.computer_id()), "the first write goes to the writer");
    }
}
