//! The sign-in routes, as one axum route table the account's routes merge. Route list (all
//! declared in capabilities.json's row that lets people and AIs in):
//! - GET  /.well-known/oauth-authorization-server
//! - POST /oauth/register, POST /oauth/token, POST /oauth/revoke
//! - GET  /authorize          -> connect page (signed in) or sign-in page
//! - GET  /authorize/continue -> connect page after sign-in
//! - POST /authorize/decide   form: request, allow
//! - GET  /sign-in            sign-in page; with `from_app=<code>`, a web link (`sessions::web_link`) opens a
//!                             signed-in web page the first time
//! - GET  /sign-in/add-passkey?link=<code>  add-a-passkey page (a one-use passkey link,
//!                             or a signed-in person adding another passkey)
//! - POST /passkey/options    {purpose: "sign-in" | "register", code?}
//! - POST /passkey/finish     sign-in or register, with the same code?, name?
//! - POST /sign-out
//! - GET  /sign-in/way?way=<way>&next=   a way's sign-in page (`way_pages.rs`)
//! - POST /sign-in/way/send   send a sign-in code for a way that sends one
//! - POST /sign-in/way        sign in with a way (or approve the waiting AI app with a personal key)
//! - GET  /sign-in/security   the account's Sign-in & security page (signed in)
//! - GET  /sign-in/security/way?way=<way>, POST /sign-in/security/way   add, change or remove a way (a recent sign-in)
//! - POST /sign-in/passkey-link   a one-use passkey link for another device (a recent sign-in)
//! - POST /sign-in/withdraw   withdraw every passkey link, challenge and code still waiting (a recent sign-in)
//!
//! Bodies above `computer().max_body_bytes` are refused with 413. Handlers
//! only parse, call the module function and map its result to HTTP.

use super::oauth;
use super::passkeys;
use super::pages::{self, Notice, Words};
use super::sessions;
use super::way_pages;
use super::ways;
use super::store::{Family, Row, Store};
use super::tokens::{blake3_hex, random_text};
use super::{now_ms, contract, computer, Error, Principal, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, RawQuery, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// What the routes need, supplied by the route table that mounts them.
pub(crate) struct Supplies {
    /// The `sign_in` schema storage.
    pub storage: Arc<dyn crate::storage::Storage + Send + Sync>,
    /// The account these routes serve (the sign-in rows name it).
    pub account: String,
    /// The address of that account (derived from its signing key); every token these routes mint names it.
    pub address: String,
    /// The public origin, "https://host".
    pub origin: String,
    /// The path these routes are served under at its computer, "/a/<address>", or "" for routes served at the origin's root.
    /// Every path these routes write (redirects, form actions, the passkey script's requests, links) starts with it.
    pub base: String,
    /// Runs the tool that sends a way's codes; with none, no code is sent and the pages say so.
    pub sender: Option<Arc<dyn ways::Deliver>>,
}

/// The routes over `supplies`.
pub(crate) fn routes(supplies: Supplies) -> Router {
    Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata).options(preflight))
        .route("/oauth/register", post(register).options(preflight))
        .route("/oauth/token", post(token).options(preflight))
        .route("/oauth/revoke", post(revoke).options(preflight))
        .route("/authorize", get(authorize))
        .route("/authorize/continue", get(continue_authorize))
        .route("/authorize/decide", post(decide))
        .route("/sign-in", get(sign_in_page))
        .route("/sign-in/add-passkey", get(add_passkey_page))
        .route("/sign-in/set-password", get(set_password_page).post(set_password))
        .route("/passkey/options", post(passkey_options))
        .route("/passkey/finish", post(passkey_finish))
        .route("/sign-out", post(sign_out))
        .route("/sign-in/way", get(way_page).post(way_sign_in))
        .route("/sign-in/way/send", post(way_send))
        .route("/sign-in/forgot-password", get(forgot_page))
        .route("/sign-in/add-email", get(add_email_page).post(add_email_step))
        .route("/sign-in/security", get(security_page))
        .route("/sign-in/security/way", get(way_setup_page).post(way_setup))
        .route("/sign-in/passkey-link", post(passkey_link_page))
        .route("/sign-in/withdraw", post(withdraw_page))
        .layer(DefaultBodyLimit::max(computer().max_body_bytes))
        .with_state(Arc::new(supplies))
}

/// The body of a passkey link's row in `Family::Challenges`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct PasskeyLink {
    purpose: String,
}

/// The row id of a passkey link's code: only its hash is stored. The
/// `native-enroll:` prefix is declared in capabilities.json and kept as it is.
fn link_id(code: &str) -> String {
    format!("native-enroll:{}", blake3_hex(code))
}

/// A one-use link, as the full URL at `origin`, that lets `account` add a
/// passkey. It lives the account's `challenge_seconds` (its settings row). The Mac app, already trusted
/// locally, hands it to its owner.
pub(crate) fn passkey_link(store: &Store<'_>, account: &str, origin: &str) -> Result<String> {
    let seconds = super::lists::current(store, account)?.challenge_seconds;
    let code = random_text(32);
    let row = Row {
        id: link_id(&code),
        account: account.to_string(),
        expires_at: now_ms() + seconds.saturating_mul(1000),
        value: PasskeyLink { purpose: "passkey-link".to_string() },
    };
    store.insert(Family::Challenges, &row)?;
    Ok(format!("{origin}/sign-in/add-passkey?link={code}"))
}

/// The account a passkey link belongs to, read without using it.
fn passkey_link_account(store: &Store<'_>, account: &str, code: &str) -> Result<String> {
    let row: Row<PasskeyLink> = store.get(Family::Challenges, &link_id(code))?.ok_or(crate::cause!(Error::Unauthenticated))?;
    if row.value.purpose != "passkey-link" || row.account != account {
        return Err(crate::cause!(Error::Unauthenticated));
    }
    Ok(row.account)
}

/// The one-use things that wait for an account, in the families that hold them: passkey links and passkey ceremonies'
/// challenges, and codes sent or adds waiting for their first right code.
const WAITING_FAMILIES: [Family; 2] = [Family::Challenges, Family::WayCodes];
/// Most rows of one family one listing or withdrawal reads.
const WAITING_AT_MOST: usize = 256;

/// One one-use thing that waits for its account. `handle` names it without being it (the BLAKE3 of its row id, so a
/// listing never shows a ceremony's challenge); `kind` says what it is ("passkey-link", a ceremony's purpose, or a
/// way and what its code is for).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct WaitingOne {
    pub handle: String,
    pub kind: String,
    pub expires_at: u64,
}

fn waiting_rows(store: &Store<'_>, account: &str) -> Result<Vec<(Family, Row<Value>)>> {
    let mut rows = Vec::new();
    for family in WAITING_FAMILIES {
        rows.extend(store.list::<Value>(family, account, WAITING_AT_MOST)?.into_iter().map(|row| (family, row)));
    }
    Ok(rows)
}

/// Every one-use thing that waits for `account`, oldest expiry first.
pub(crate) fn waiting(store: &Store<'_>, account: &str) -> Result<Vec<WaitingOne>> {
    let text = |value: &Value, name: &str| value.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let mut listed: Vec<WaitingOne> = waiting_rows(store, account)?.into_iter().map(|(family, row)| WaitingOne {
        handle: blake3_hex(&row.id),
        kind: match family {
            Family::WayCodes => format!("{} {}", text(&row.value, "way"), text(&row.value, "purpose")),
            _ => text(&row.value, "purpose"),
        },
        expires_at: row.expires_at,
    }).collect();
    listed.sort_by_key(|one| one.expires_at);
    Ok(listed)
}

/// Withdraw what waits for `account`: the one named by `handle`, or every one. A withdrawn link, challenge or code
/// is refused at once, as if it had run out. Answers how many were withdrawn.
pub(crate) fn withdraw(store: &Store<'_>, account: &str, handle: Option<&str>) -> Result<usize> {
    let mut withdrawn = 0;
    for (family, row) in waiting_rows(store, account)? {
        if handle.is_none_or(|handle| blake3_hex(&row.id) == handle) && store.remove(family, &row.id)? {
            withdrawn += 1;
        }
    }
    Ok(withdrawn)
}

/// The path after sign-in, when it is a same-origin path; otherwise the routes' root (`base` + "/").
/// Rejects `//` and `/\` (browsers read both as another host) and control characters.
pub(crate) fn safe_next(next: Option<&str>, base: &str) -> String {
    match next {
        Some(path)
            if path.starts_with('/') && !path.starts_with("//") && !path.starts_with("/\\") && !path.chars().any(char::is_control) =>
        {
            path.to_string()
        }
        _ => format!("{base}/"),
    }
}

/// Whether the request's `Origin` header is exactly the routes' origin (CSRF check).
pub(crate) fn same_origin(headers: &HeaderMap, origin: &str) -> bool {
    headers.get(header::ORIGIN).and_then(|value| value.to_str().ok()) == Some(origin)
}

/// Whether the request's session belongs to `account`.
fn signed_in(store: &Store<'_>, account: &str, headers: &HeaderMap) -> Result<bool> {
    let cookie = headers.get(header::COOKIE).and_then(|value| value.to_str().ok());
    Ok(sessions::current(store, cookie)?.is_some_and(|principal: Principal| principal.account == account))
}

/// Whether a browser request of the person signed in to `account` (its sign-in user id) at this door: its session
/// cookie names a live session of that account, and the request comes from `origin` (a POST must name it; a GET may
/// name none, as a browser's same-origin read does, but never another). A door served at a computer admits the
/// person's own page reads by it (native_entry.rs `door`, the account files page road).
pub(crate) fn person_signed_in(storage: &Arc<dyn crate::storage::Storage + Send + Sync>, account: &str, origin: &str,
    method: &axum::http::Method, headers: &HeaderMap) -> bool {
    let origin_ok = match headers.get(header::ORIGIN) {
        None => *method == axum::http::Method::GET,
        Some(_) => same_origin(headers, origin),
    };
    origin_ok && signed_in(&Store::new(&**storage), account, headers).unwrap_or(false)
}

/// The account of a signed-in person adding a passkey without a link. The
/// request must come from this origin (a cookie is not sent cross-site by
/// script), and its session must belong to the account these routes serve.
fn signed_in_account(store: &Store<'_>, supplies: &Supplies, headers: &HeaderMap) -> Result<String> {
    if !same_origin(headers, &supplies.origin) || !signed_in(store, &supplies.account, headers)? {
        return Err(crate::cause!(Error::Unauthenticated));
    }
    Ok(supplies.account.clone())
}

/// Who a passkey registration adds to: the link's account when a link is
/// given (checked here, used up only later), otherwise the signed-in person.
fn register_account(store: &Store<'_>, supplies: &Supplies, headers: &HeaderMap, code: Option<&str>) -> Result<String> {
    match code {
        Some(code) => passkey_link_account(store, &supplies.account, code),
        None => signed_in_account(store, supplies, headers),
    }
}

fn pairs(bytes: &[u8]) -> Vec<(String, String)> {
    url::form_urlencoded::parse(bytes).map(|(key, value)| (key.into_owned(), value.into_owned())).collect()
}

fn value<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs.iter().find(|(key, _)| key.as_str() == name).map(|(_, value)| value.as_str())
}

pub(crate) fn encoded(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// A response with `headers`. A header value that cannot be sent is a storage-free
/// refusal of the whole answer (503), never a silently dropped header.
fn reply(status: StatusCode, content_type: &'static str, body: Vec<u8>, headers: &[(&'static str, &str)], cause: crate::refusal_cause::Cause) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    for (name, value) in headers {
        match HeaderValue::from_str(value) {
            Ok(value) => {
                response.headers_mut().append(HeaderName::from_static(name), value);
            }
            Err(_) => return named_refusal(StatusCode::SERVICE_UNAVAILABLE.into_response(), crate::cause!(sign_in invalid_response_header)),
        }
    }
    named_refusal(response, cause)
}

/// Only source identity and the status are logged; a body, cookie or location is never formatted.
fn named_refusal(mut response: Response, cause: crate::refusal_cause::Cause) -> Response {
    if response.status().is_client_error() || response.status().is_server_error() {
        response.headers_mut().insert("x-trillion-refusal-cause",
            cause.id().parse().expect("validated source identity is a header value"));
        crate::quiet_eprintln!("sign-in-refusal status={} cause={cause}", response.status().as_u16());
    }
    response
}

/// An HTML page with the sign-in page headers: no caching, no framing, a referrer only to this origin, and the script
/// allowed only by its hash. The referrer policy is `same-origin`, not `no-referrer`: under `no-referrer` a browser
/// sends `Origin: null` with every form post (the Fetch standard's origin header), so each same-origin check of a
/// posted form (`same_origin`) would refuse the person's own page.
#[track_caller]
pub(crate) fn html(status: StatusCode, body: String) -> Response {
    html_to_with_cause(status, body, None, crate::cause!(caller_site: sign_in html_response))
}

pub(crate) fn html_with_cause(status: StatusCode, body: String, cause: crate::refusal_cause::Cause) -> Response {
    html_to_with_cause(status, body, None, cause)
}

/// The CSP source of a redirect URI: its origin for an http(s) address, its scheme (`name:`) for an app's own scheme;
/// None for anything that does not read as one plainly (no source is made from other text).
fn form_source(redirect_uri: &str) -> Option<String> {
    let url = url::Url::parse(redirect_uri).ok()?;
    match url.scheme() {
        "http" | "https" => Some(url.origin().ascii_serialization()).filter(|origin| origin != "null"),
        scheme if scheme.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"+.-".contains(&byte)) => {
            Some(format!("{scheme}:"))
        }
        _ => None,
    }
}

/// The redirect URI of the AI-app connection `request` waits on, when it is still pending.
fn waiting_target(supplies: &Supplies, request: Option<&str>) -> Option<String> {
    let store = Store::new(&*supplies.storage);
    oauth::pending(&store, request?).ok().flatten().map(|(waiting, _)| waiting.redirect_uri)
}

/// `html`, for a page whose form may end at an AI app's own address: the redirect URI of the connection waiting on it
/// (`form_source`). A browser checks a form's `form-action` again at every redirect it follows, so a post that ends at
/// the app is allowed to reach that one address's origin, and nothing else.
#[track_caller]
fn html_to(status: StatusCode, body: String, redirect_uri: Option<&str>) -> Response {
    html_to_with_cause(status, body, redirect_uri, crate::cause!(caller_site: sign_in html_response))
}

fn html_to_with_cause(status: StatusCode, body: String, redirect_uri: Option<&str>, cause: crate::refusal_cause::Cause) -> Response {
    let target = redirect_uri.and_then(form_source).map(|source| format!(" {source}")).unwrap_or_default();
    // The look's faces and mark load from this origin (`shell::Look` stylesheets, the brand mark); its inline rules are
    // the page's own; each inline script is allowed by its hash alone.
    let csp = format!(
        "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src {}; connect-src 'self'; form-action 'self'{target}; frame-ancestors 'none'; base-uri 'none'",
        pages::script_sources()
    );
    reply(
        status,
        "text/html; charset=utf-8",
        body.into_bytes(),
        &[
            ("cache-control", "no-store"),
            ("x-frame-options", "DENY"),
            ("referrer-policy", "same-origin"),
            ("content-security-policy", csp.as_str()),
        ],
        cause,
    )
}

/// A refusal with no detail in the reply: the status and an empty JSON object. Its cause is logged here, at this place,
/// as `sign-in-refusal` and never sent back, so the caller learns the status and nothing about which step failed.
pub(crate) fn refused(status: StatusCode, cause: crate::refusal_cause::Cause) -> Response {
    crate::quiet_eprintln!("sign-in-refusal status={} cause={cause}", status.as_u16());
    let mut response = Response::new(Body::from("{}"));
    *response.status_mut() = status;
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[track_caller]
pub(crate) fn json(status: StatusCode, value: &Value, headers: &[(&'static str, &str)]) -> Response {
    let caller = crate::cause!(caller_site: sign_in json_response);
    let mut refusal;
    let (value, cause) = if status.is_client_error() || status.is_server_error() {
        let cause = value.get("cause").and_then(Value::as_str)
            .and_then(crate::refusal_cause::Cause::from_wire).unwrap_or(caller);
        refusal = value.clone();
        if let Some(fields) = refusal.as_object_mut() { fields.insert("cause".into(), json!(cause.id())); }
        (&refusal, cause)
    } else { (value, caller) };
    reply(status, "application/json", serde_json::to_vec(value).unwrap_or_default(), headers, cause)
}

/// A 303 to `location`, with the session cookie change when there is one.
#[track_caller]
pub(crate) fn redirect(location: &str, cookie: Option<&str>) -> Response {
    let cause = crate::cause!(caller_site: sign_in redirect_response);
    match cookie {
        Some(cookie) => reply(
            StatusCode::SEE_OTHER,
            "text/plain; charset=utf-8",
            Vec::new(),
            &[("location", location), ("cache-control", "no-store"), ("set-cookie", cookie)],
            cause,
        ),
        None => reply(StatusCode::SEE_OTHER, "text/plain; charset=utf-8", Vec::new(), &[("location", location), ("cache-control", "no-store")], cause),
    }
}

/// The return path of a sign-in is held in this cookie, never in an address: the visible URL is the plain page.
pub(crate) const NEXT_COOKIE: &str = "trillion_next";

/// The address of the sign-in page `page` ("/sign-in", "/sign-in/way") under `base`, with `pairs`. A return path is never
/// in it: it is held in the `NEXT_COOKIE` cookie (`next_cookie`).
pub(crate) fn way_in(base: &str, page: &str, pairs: &[(&str, &str)]) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        query.append_pair(name, value);
    }
    match query.finish() {
        query if query.is_empty() => format!("{base}{page}"),
        query => format!("{base}{page}?{query}"),
    }
}

/// The sign-in page's address under `base`.
pub(crate) fn sign_in_address(base: &str) -> String {
    way_in(base, "/sign-in", &[])
}

/// The cookie that holds a sign-in's return path, HttpOnly and Secure, for as long as a sign-in takes: the passkey
/// ceremony's timeout, `challenge_seconds` of the shipped account settings (src/account/sign_in/new-accounts.json
/// `sign_in`), which a person's sign-in is already held to. It is read before any account is known, so it is the shipped row.
pub(crate) fn next_cookie(next: &str) -> String {
    format!("{NEXT_COOKIE}={}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={}", URL_SAFE_NO_PAD.encode(next), super::shipped().sign_in.challenge_seconds)
}

/// The return path a sign-in holds in its cookie, as the request carries it.
pub(crate) fn held_next(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|cookies| cookies.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == NEXT_COOKIE)
        .and_then(|(_, value)| URL_SAFE_NO_PAD.decode(value).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

/// The return path a request carries: the held cookie, else a query `next` from a link sent before the cookie existed,
/// each checked by `safe_next`.
pub(crate) fn next_of(headers: &HeaderMap, query: Option<&str>, base: &str) -> String {
    safe_next(held_next(headers).as_deref().or(query), base)
}

fn sign_in_redirect(base: &str, next: &str) -> Response {
    redirect(&sign_in_address(base), Some(&next_cookie(next)))
}

/// A JSON refusal. OAuth refusals keep their RFC 6749 body; the rest are short codes.
fn refusal(error: Error, headers: &[(&'static str, &str)]) -> Response {
    let (status, mut body) = match &error {
        Error::Storage(_) | Error::SourceNotCurrent(_) => (StatusCode::SERVICE_UNAVAILABLE, json!({"error": "temporarily_unavailable"})),
        Error::TooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, json!({"error": "request_too_large"})),
        Error::SettingsMissing(_) => (StatusCode::SERVICE_UNAVAILABLE, oauth::error_body(&error)),
        Error::Unauthenticated(_) => (StatusCode::UNAUTHORIZED, json!({"error": "unauthenticated"})),
        Error::PasskeyRefused(_) => (StatusCode::BAD_REQUEST, json!({"error": "passkey_refused"})),
        Error::InvalidClient(_) => (StatusCode::UNAUTHORIZED, oauth::error_body(&error)),
        _ => (StatusCode::BAD_REQUEST, oauth::error_body(&error)),
    };
    body["cause"] = json!(error.cause().id());
    crate::quiet_eprintln!("sign-in-refusal status={} cause={}", status.as_u16(), error.cause());
    json(status, &body, headers)
}

/// The account's words (its words row, `words_row.rs`), when it has them and they could be read.
fn words_of(store: &Store<'_>, supplies: &Supplies) -> Option<Words> {
    super::words_row::current(store, &supplies.account).ok().flatten()
}

/// What a page answers when the account has no words row: the status the page would have had and the code
/// `sign_in_words_missing` alone, never words from anywhere else.
#[track_caller]
fn without_words(status: StatusCode) -> Response {
    without_words_with_cause(status, crate::cause!(caller_site: sign_in words_missing))
}
fn without_words_with_cause(status: StatusCode, cause: crate::refusal_cause::Cause) -> Response {
    reply(status, "text/plain; charset=utf-8", super::words_row::MISSING.as_bytes().to_vec(), &[("cache-control", "no-store")], cause)
}

/// A notice page in the account's words (`words`), or its code alone without them.
#[track_caller]
fn notice_page(words: Option<&Words>, status: StatusCode, which: Notice) -> Response {
    notice_page_with_cause(words, status, which, crate::cause!(caller_site: sign_in notice_refusal))
}
fn notice_page_with_cause(words: Option<&Words>, status: StatusCode, which: Notice, cause: crate::refusal_cause::Cause) -> Response {
    match words {
        Some(words) => html_with_cause(status, pages::notice(words, which), cause),
        None => without_words_with_cause(status, cause),
    }
}

/// An HTML refusal page for the person's own browser.
fn page_error(words: Option<&Words>, error: Error) -> Response {
    let cause = error.cause();
    crate::quiet_eprintln!("sign-in-page-refusal cause={cause}");
    match error {
        Error::Storage(_) | Error::SourceNotCurrent(_) | Error::SettingsMissing(_) => notice_page_with_cause(words, StatusCode::SERVICE_UNAVAILABLE, Notice::Unavailable, cause),
        Error::WordsMissing(_) => without_words_with_cause(StatusCode::SERVICE_UNAVAILABLE, cause),
        Error::Unauthenticated(_) => notice_page_with_cause(words, StatusCode::UNAUTHORIZED, Notice::Refused, cause),
        _ => notice_page_with_cause(words, StatusCode::BAD_REQUEST, Notice::Refused, cause),
    }
}

#[track_caller]
fn refused_page(words: Option<&Words>) -> Response {
    notice_page(words, StatusCode::BAD_REQUEST, Notice::Refused)
}

/// The cross-origin refusal of a form post.
#[track_caller]
fn forbidden_page(store: &Store<'_>, supplies: &Supplies) -> Response {
    notice_page(words_of(store, supplies).as_ref(), StatusCode::FORBIDDEN, Notice::Refused)
}

/// The consent page for `request`, when the request is pending.
fn connect_page(store: &Store<'_>, supplies: &Supplies, request: &str) -> Response {
    let Some(words) = words_of(store, supplies) else { return without_words(StatusCode::SERVICE_UNAVAILABLE) };
    match oauth::pending(store, request) {
        Ok(Some((waiting, client))) => html_to(StatusCode::OK, pages::connect(&words, request, &client.client_name, &supplies.base), Some(&waiting.redirect_uri)),
        Ok(None) => refused_page(Some(&words)),
        Err(error) => page_error(Some(&words), error),
    }
}

/// The consent page for a signed-in person; otherwise sign in first, then come back here.
fn consent_or_sign_in(store: &Store<'_>, supplies: &Supplies, headers: &HeaderMap, request: &str) -> Response {
    match signed_in(store, &supplies.account, headers) {
        Ok(true) => connect_page(store, supplies, request),
        Ok(false) => sign_in_redirect(&supplies.base, &format!("{}/authorize/continue?request={request}", supplies.base)),
        Err(error) => page_error(words_of(store, supplies).as_ref(), error),
    }
}

const CORS: [(&str, &str); 1] = [("access-control-allow-origin", "*")];

async fn preflight() -> Response {
    (
        StatusCode::NO_CONTENT,
        [
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS"),
            (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type, authorization"),
        ],
    )
        .into_response()
}

async fn metadata(State(supplies): State<Arc<Supplies>>) -> Response {
    json(StatusCode::OK, &oauth::metadata(&format!("{}{}", supplies.origin, supplies.base)), &[("cache-control", "max-age=3600"), CORS[0]])
}

/// The address a path names and the path inside that account's routes. The
/// computer (`native_entry/computer.rs`) and the forwarder (`forwarder/gateway.rs`) read paths the same way. `/a/<address>/rest` names `<address>` and `/rest`;
/// the discovery paths `/.well-known/<name>/a/<address>/rest` name it and map to `/.well-known/<name>/rest` (RFC 8414
/// and 9728 put the well-known part before the path of the issuer or resource). None when the path names no account.
pub(crate) fn named_path(path: &str) -> Option<(&str, String)> {
    fn split(rest: &str) -> (&str, String) {
        let end = rest.find('/').unwrap_or(rest.len());
        let (address, tail) = rest.split_at(end);
        (address, if tail.is_empty() { "/".to_string() } else { tail.to_string() })
    }
    if let Some(rest) = path.strip_prefix("/a/") {
        return Some(split(rest));
    }
    for name in [".well-known/oauth-authorization-server", ".well-known/oauth-protected-resource"] {
        if let Some(rest) = path.strip_prefix(&format!("/{name}/a/")) {
            let (address, inner) = split(rest);
            let suffix = if inner == "/" { String::new() } else { inner };
            return Some((address, format!("/{name}{suffix}")));
        }
    }
    None
}

/// RFC 9728 metadata of an account's MCP resource, for the routes served at `origin` + `base`: the resource is the
/// account's `/mcp` under its base, and its authorization server is the account's issuer. The computer answers it (the
/// MCP server's own discovery is the forwarder's, not a computer's).
pub(crate) fn resource_metadata(origin: &str, base: &str) -> Value {
    let issuer = format!("{origin}{base}");
    json!({
        "resource": format!("{issuer}/mcp"),
        "authorization_servers": [issuer],
        "scopes_supported": contract().scopes,
        "bearer_methods_supported": ["header"],
    })
}

async fn register(State(supplies): State<Arc<Supplies>>, body: Bytes) -> Response {
    let store = Store::new(&*supplies.storage);
    match oauth::register(&store, &supplies.account, &body) {
        Ok(client) => json(StatusCode::CREATED, &client, &[("cache-control", "no-store"), CORS[0]]),
        Err(error) => refusal(error, &[("cache-control", "no-store"), CORS[0]]),
    }
}

async fn token(State(supplies): State<Arc<Supplies>>, body: Bytes) -> Response {
    let store = Store::new(&*supplies.storage);
    match oauth::token(&store, &supplies.account, &supplies.address, &pairs(&body)) {
        Ok(tokens) => json(StatusCode::OK, &tokens, &[("cache-control", "no-store"), CORS[0]]),
        Err(error) => refusal(error, &[("cache-control", "no-store"), CORS[0]]),
    }
}

async fn revoke(State(supplies): State<Arc<Supplies>>, body: Bytes) -> Response {
    let store = Store::new(&*supplies.storage);
    match oauth::revoke(&store, &pairs(&body)) {
        Ok(()) => json(StatusCode::OK, &json!({}), &[("cache-control", "no-store"), CORS[0]]),
        Err(error) => refusal(error, &[("cache-control", "no-store"), CORS[0]]),
    }
}

async fn authorize(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, RawQuery(raw): RawQuery) -> Response {
    let query = pairs(raw.as_deref().unwrap_or("").as_bytes());
    let store = Store::new(&*supplies.storage);
    match oauth::authorize(&store, &supplies.account, &query) {
        Ok(request) => consent_or_sign_in(&store, &supplies, &headers, &request),
        Err(error) => match oauth::error_redirect(&store, &supplies.account, &query, &error) {
            Some(url) => redirect(&url, None),
            None => page_error(words_of(&store, &supplies).as_ref(), error),
        },
    }
}

async fn continue_authorize(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, RawQuery(raw): RawQuery) -> Response {
    let query = pairs(raw.as_deref().unwrap_or("").as_bytes());
    let store = Store::new(&*supplies.storage);
    let Some(request) = value(&query, "request") else { return refused_page(words_of(&store, &supplies).as_ref()) };
    consent_or_sign_in(&store, &supplies, &headers, request)
}

async fn decide(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    let store = Store::new(&*supplies.storage);
    let words = words_of(&store, &supplies);
    let page_error = |error| page_error(words.as_ref(), error);
    if !same_origin(&headers, &supplies.origin) {
        return notice_page(words.as_ref(), StatusCode::FORBIDDEN, Notice::Refused);
    }
    match signed_in(&store, &supplies.account, &headers) {
        Ok(true) => {}
        Ok(false) => return notice_page(words.as_ref(), StatusCode::UNAUTHORIZED, Notice::Refused),
        Err(error) => return page_error(error),
    }
    let form = pairs(&body);
    let Some(request) = value(&form, "request") else { return refused_page(words.as_ref()) };
    let allow = match value(&form, "allow") {
        Some("yes") => true,
        Some("no") => false,
        _ => return refused_page(words.as_ref()),
    };
    // How the person approved it is kept on the grant (`calls.rs` picks its tier by it).
    let cookie = headers.get(header::COOKIE).and_then(|value| value.to_str().ok());
    let method = match sessions::current_row(&store, cookie) {
        Ok(row) => row.map(|row| row.value.method),
        Err(error) => return page_error(error),
    };
    match oauth::decide_by(&store, &supplies.account, request, allow, None,
        method.as_deref(),
        Some(&supplies.address),
    ) {
        Ok(url) => redirect(&url, None),
        Err(error) => page_error(error),
    }
}

/// The set-password form's answer (old src/worker.mjs setPassword 3198): the typed email must be the account's confirmed
/// email, the confirmation must match, and the password is added or changed by the password way's own add, the same
/// checks (length, the current password when one is held) as the security page. Done, the person goes to `next` (or the
/// Sign-in & security page).
async fn set_password(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let typed = typed_form(&body);
    let (words, ways, way) = match way_of(&Store::new(&*supplies.storage), &supplies, Some("password")) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let back = format!("{}/sign-in/set-password", supplies.base);
    let session = match changing_session(&Store::new(&*supplies.storage), &ways, &supplies, &headers, &back) {
        Ok(session) => session,
        Err(answer) => return *answer,
    };
    let held = match ways::held(&Store::new(&*supplies.storage), &supplies.account) {
        Ok(held) => held,
        Err(error) => return page_error(Some(&words), crate::carry_cause!(Error::Storage, error)),
    };
    let Some(email) = held.iter().find(|row| row.value.way == "email-code").and_then(|row| row.value.name.clone()) else {
        return refused_page(Some(&words));
    };
    let next = next_of(&headers, typed.get("next").map(String::as_str), &supplies.base);
    let password = typed.get(ways::NEW_SECRET_FIELD).cloned().unwrap_or_default();
    let again = typed.get("password_again").cloned().unwrap_or_default();
    if typed.get("username").map(String::as_str) != Some(email.as_str()) || again != password {
        let changing = held.iter().any(|row| row.value.way == "password");
        let offered = typed.get("next").map(|next| safe_next(Some(next), &supplies.base));
        return html(StatusCode::BAD_REQUEST, super::set_password::page(&words, &ways, &supplies.base, &email, changing, offered.as_deref(), Some(&words.set_password.not_the_same)));
    }
    let mut form = ways::Typed::new();
    form.insert(ways::name_field_of(&ways, "email").unwrap_or_else(|| "sign_in_email".to_string()), email.clone());
    form.insert(ways::NEW_SECRET_FIELD.to_string(), password);
    if let Some(current) = typed.get(ways::CURRENT_SECRET_FIELD) {
        form.insert(ways::CURRENT_SECRET_FIELD.to_string(), current.clone());
    }
    let issuer = url::Url::parse(&supplies.origin).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
    let method = session.value.method.clone();
    let work = {
        let (supplies, way, ways, form, issuer) = (supplies.clone(), way.clone(), ways.clone(), form, issuer);
        move || -> std::result::Result<(), ways::Refused> {
            let store = Store::new(&*supplies.storage);
            let who = ways::Adding { account: &supplies.account, address: &supplies.address, method: &method, issuer: &issuer };
            ways::add(&store, &ways, &who, &way, &form, supplies.sender.as_deref()).map(|_| ())
        }
    };
    match blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage))) {
        Ok(()) => {
            let security = format!("{}/sign-in/security", supplies.base);
            redirect(if next.starts_with(&supplies.base) { &next } else { &security }, None)
        }
        Err(refused) => {
            let message = way_pages::refused_words(&words, &ways, &refused, &way);
            let changing = held.iter().any(|row| row.value.way == "password");
            let page = super::set_password::page(&words, &ways, &supplies.base, &email, changing, None, Some(&message));
            html_to_with_cause(way_status(&refused), page, None, refused.cause())
        }
    }
}

#[derive(Deserialize)]
struct NextQuery {
    next: Option<String>,
    /// A web link's code (`sessions::web_link`).
    from_app: Option<String>,
}

/// The query field a web link's code rides in on the sign-in page (old trillion src/web-sign-in.mjs:28 put it on a
/// route of its own, `/sign-in/from-app?code=`; the account routes' row in capabilities.json lists no such route, and a link that does not open falls
/// back to this page anyway, old :39).
pub(crate) const WEB_LINK_FIELD: &str = "from_app";

/// The sign-in page's path under `base`.
pub(crate) fn sign_in_path(base: &str) -> String {
    format!("{base}/sign-in")
}

async fn sign_in_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<NextQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    if let Some(code) = query.from_app.as_deref() {
        // A web link opened: signed in and sent on the first time; the sign-in page otherwise (old :37-45).
        match sessions::open_web_link(&store, &supplies.account, code) {
            Ok(Some((cookie, next))) => return with_session_cookie(redirect(&next, None), &cookie, &supplies.address),
            Ok(None) => {}
            Err(error) => return page_error(words_of(&store, &supplies).as_ref(), error),
        }
    }
    let next = next_of(&headers, query.next.as_deref(), &supplies.base);
    let connecting = request_of(&next, &supplies.base).is_some();
    match offered_with_words(&store, &supplies) {
        Ok((words, ways)) => html(StatusCode::OK, pages::sign_in(&words, &next, &supplies.base, connecting, ways.as_ref())),
        Err(answer) => *answer,
    }
}

/// The AI-app connection a `next` path waits on (`/authorize/continue?request=<id>` under the routes' base), if any.
fn request_of(next: &str, base: &str) -> Option<String> {
    let query = next.strip_prefix(&format!("{base}/authorize/continue?"))?;
    value(&pairs(query.as_bytes()), "request").filter(|request| !request.is_empty()).map(str::to_string)
}

/// A posted form, first value of each field.
fn typed_form(bytes: &[u8]) -> ways::Typed {
    let mut form = ways::Typed::new();
    for (name, text) in pairs(bytes) {
        form.entry(name).or_insert(text);
    }
    form
}

/// The HTTP status of a refused way step.
fn way_status(refused: &ways::Refused) -> StatusCode {
    match refused {
        ways::Refused::Wrong(_) => StatusCode::UNAUTHORIZED,
        ways::Refused::TooMany(_, _) | ways::Refused::Limited(_, _) => StatusCode::TOO_MANY_REQUESTS,
        ways::Refused::NotSent(_) | ways::Refused::DeliveryUnknown(_) | ways::Refused::Missing(_) | ways::Refused::WordsMissing(_) | ways::Refused::Storage(_) => StatusCode::SERVICE_UNAVAILABLE,
        ways::Refused::NotFresh(_) | ways::Refused::NotThisSession(_) | ways::Refused::NeedsKnownPasskey(_) => StatusCode::FORBIDDEN,
        ways::Refused::HeldWhileWaiting(_) => StatusCode::CONFLICT,
        _ => StatusCode::BAD_REQUEST,
    }
}

/// Run sign-in work that blocks (a key made at a memory-hard cost, a tool that sends a code) off the async workers.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(work).await.ok()
}

/// The account's words and the ways its pages offer (`offered_of`), or the page that answers: its code alone when it
/// has no words row or its words leave an offered way without words (`Words::covers`).
fn offered_with_words(store: &Store<'_>, supplies: &Supplies) -> std::result::Result<(Words, Option<ways::WaySettings>), Box<Response>> {
    let Some(words) = words_of(store, supplies) else { return Err(Box::new(without_words(StatusCode::SERVICE_UNAVAILABLE))) };
    match offered_of(store, supplies) {
        Ok(Some(ways)) if !words.covers(&ways) => Err(Box::new(without_words(StatusCode::SERVICE_UNAVAILABLE))),
        Ok(ways) => Ok((words, ways)),
        Err(error) => Err(Box::new(page_error(Some(&words), error))),
    }
}

/// The account's words and ways, or the page that answers when it has no ways row (unavailable), no words for them,
/// or they cannot be read.
fn ways_of(store: &Store<'_>, supplies: &Supplies) -> std::result::Result<(Words, ways::WaySettings), Box<Response>> {
    match offered_with_words(store, supplies)? {
        (words, Some(ways)) => Ok((words, ways)),
        (words, None) => Err(Box::new(page_error(Some(&words), crate::cause!(Error::SettingsMissing)))),
    }
}

/// The account's ways as its pages offer them (`WaySettings::offering`): a sent way whose channel has no tool picked
/// to send its codes, or any sent way at routes with no sender, is not offered. None when the account has no ways row.
fn offered_of(store: &Store<'_>, supplies: &Supplies) -> Result<Option<ways::WaySettings>> {
    // The ways a page offers are its text: a computer that may not admit shows none, and every way it is asked to take
    // stays refused (`ways_of` reads the same row through the gate).
    let row = match ways::read_typed(store, &supplies.account) {
        Ok(row) => row,
        Err(Error::SourceNotCurrent(_)) => return Ok(None),
        Err(error) => return Err(crate::carry_cause!(Error::Storage, error)),
    };
    let Some(row) = row else { return Ok(None) };
    let delivered: Vec<String> = match supplies.sender {
        Some(_) => ways::deliveries(store, &supplies.account).map_err(|error| crate::carry_cause!(Error::Storage, error))?.into_iter().map(|delivery| delivery.channel).collect(),
        None => Vec::new(),
    };
    Ok(Some(row.value.ways.offering(&delivered)))
}

/// The account's ways and the row of `way` among them, or the page that answers: `ways_of`'s, or refused when `way`
/// is not one of them.
fn way_of(store: &Store<'_>, supplies: &Supplies, way: Option<&str>) -> std::result::Result<(Words, ways::WaySettings, ways::WayRow), Box<Response>> {
    let (words, ways) = ways_of(store, supplies)?;
    let row = way.and_then(|way| ways.row(way)).cloned().ok_or_else(|| Box::new(refused_page(Some(&words))))?;
    Ok((words, ways, row))
}

#[derive(Deserialize)]
struct WayQuery {
    way: Option<String>,
    next: Option<String>,
}

/// A way's sign-in page.
async fn way_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<WayQuery>) -> Response {
    let (words, ways, way) = match way_of(&Store::new(&*supplies.storage), &supplies, query.way.as_deref()) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let next = next_of(&headers, query.next.as_deref(), &supplies.base);
    let request = request_of(&next, &supplies.base);
    let kept = ways::Typed::new();
    let focus = way.named.as_deref().unwrap_or(way.proof.field());
    let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: request.as_deref(), kept: &kept, message: None, focus: Some(focus) };
    html_to(StatusCode::OK, way_pages::sign_in(&way, None, &form), waiting_target(&supplies, request.as_deref()).as_deref())
}

/// Send a sign-in code for a `sent` way, then ask for it.
async fn way_send(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let typed = typed_form(&body);
    let (words, ways, way) = match way_of(&Store::new(&*supplies.storage), &supplies, typed.get("way").map(String::as_str)) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let next = next_of(&headers, typed.get("next").map(String::as_str), &supplies.base);
    let request = request_of(&next, &supplies.base);
    let work = {
        let (supplies, typed, ways, way) = (supplies.clone(), typed.clone(), ways.clone(), way.clone());
        move || ways::send_code(&Store::new(&*supplies.storage), &ways, &supplies.account, &way, &typed, supplies.sender.as_deref())
    };
    let answer = blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage)));
    let uncertain_name = if matches!(answer, Err(ways::Refused::DeliveryUnknown(_))) {
        way.named.as_deref().and_then(|kind| {
            let field = ways::name_field_of(&ways, kind)?;
            ways::normal_name(&ways, kind, typed.get(&field).map(String::as_str).unwrap_or_default())
        })
    } else { None };
    let (status, sent_to, message, focus) = match &answer {
        Ok(name) => (StatusCode::OK, Some(name.clone()), way_pages::said(&words.ways.code_sent, &[("name", name), ("digits", &ways.code.digits.to_string()),
            ("minutes", &ways.code.seconds.div_ceil(60).to_string())]), ways::CODE_FIELD),
        Err(refused @ ways::Refused::DeliveryUnknown(_)) => (way_status(refused), uncertain_name,
            way_pages::refused_words(&words, &ways, refused, &way), ways::CODE_FIELD),
        Err(refused) => (way_status(refused), None, way_pages::refused_words(&words, &ways, refused, &way), way_pages::focus_for(refused, &way, false)),
    };
    let cause = answer.as_ref().err().map(ways::Refused::cause)
        .unwrap_or_else(|| crate::cause!(sign_in way_reply));
    if typed.get("reset").map(String::as_str) == Some("1") {
        let page = match (&answer, sent_to.as_deref()) {
            (Ok(_), Some(name)) => way_pages::reset_code(&words, &ways, &supplies.base, &next, name, &message, Some(focus)),
            _ => way_pages::reset_ask(&words, &ways, &supplies.base, &next, Some(&message)),
        };
        return match page {
            Some(page) => html_to_with_cause(status, page, None, cause),
            None => refused_page(Some(&words)),
        };
    }
    let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: request.as_deref(), kept: &typed, message: Some(message), focus: Some(focus) };
    html_to_with_cause(status, way_pages::sign_in(&way, sent_to.as_deref(), &form), waiting_target(&supplies, request.as_deref()).as_deref(), cause)
}

/// The password reset's first step (old src/pages.mjs `forgotPasswordPage`): an email box and Email me a code.
async fn forgot_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<NextQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways) = match ways_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let next = next_of(&headers, query.next.as_deref(), &supplies.base);
    match way_pages::reset_ask(&words, &ways, &supplies.base, &next, None) {
        Some(page) => html(StatusCode::OK, page),
        None => refused_page(Some(&words)),
    }
}

/// The password reset's last step (old src/worker.mjs passwordResetFinish): a right code, with a password that can be
/// used, keeps the new password, ends the account's other browser sessions and starts one.
async fn reset_finish(supplies: Arc<Supplies>, words: Words, ways: ways::WaySettings, way: ways::WayRow, typed: ways::Typed, next: String) -> Response {
    let sent_to = reset_name(&ways, &way, &typed);
    let password = typed.get(ways::NEW_SECRET_FIELD).cloned().unwrap_or_default();
    let answer = match ways::chosen_length(&ways, &password) {
        Err(refused) => Err(refused),
        Ok(()) => {
            let work = {
                let (supplies, ways, way, typed) = (supplies.clone(), ways.clone(), way.clone(), typed.clone());
                move || reset_session(&supplies, &ways, &way, &typed)
            };
            blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage)))
        }
    };
    match answer {
        Ok(cookie) => with_session_cookie(html(StatusCode::OK, way_pages::notice(&words, &words.ways.reset.done, &next)), &cookie, &supplies.address),
        Err(refused) => {
            let message = way_pages::refused_words(&words, &ways, &refused, &way);
            let focus = if matches!(refused, ways::Refused::TooShort(_)) { ways::NEW_SECRET_FIELD } else { ways::CODE_FIELD };
            let page = match sent_to {
                Some(name) => way_pages::reset_code(&words, &ways, &supplies.base, &next, &name, &message, Some(focus)),
                None => way_pages::reset_ask(&words, &ways, &supplies.base, &next, Some(&message)),
            };
            match page {
                Some(page) => html_to_with_cause(way_status(&refused), page, None, refused.cause()),
                None => refused_page(Some(&words)),
            }
        }
    }
}

/// The work of the reset's last step on one store: the code proves the way, the account's other browser sessions end,
/// the new password is kept (a session started by a way that recovers it sets it anew), and a session starts.
fn reset_session(supplies: &Supplies, ways: &ways::WaySettings, way: &ways::WayRow, typed: &ways::Typed) -> std::result::Result<String, ways::Refused> {
    let store = Store::new(&*supplies.storage);
    let storage = |error: Error| ways::Refused::Storage(error.cause());
    if !matches!(ways::sign_in(&store, ways, &supplies.account, way, typed)?, ways::Opened::Session { .. }) {
        return Err(crate::cause!(ways::Refused::Unknown));
    }
    for row in sessions::listed(&store, &supplies.account).map_err(storage)? {
        sessions::end_one(&store, &supplies.account, &row.id).map_err(storage)?;
    }
    let chosen = ways.rows.iter().find(|row| row.proof == ways::Proof::Chosen && row.alone).ok_or(crate::cause!(ways::Refused::Unknown))?;
    let issuer = url::Url::parse(&supplies.origin).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
    let who = ways::Adding { account: &supplies.account, address: &supplies.address, method: &way.way, issuer: &issuer };
    ways::add(&store, ways, &who, chosen, typed, supplies.sender.as_deref())?;
    sessions::start(&store, &supplies.account, &way.way).map_err(storage)
}

/// The name the reset's code was sent to, as the way keeps it.
fn reset_name(ways: &ways::WaySettings, way: &ways::WayRow, typed: &ways::Typed) -> Option<String> {
    let kind = way.named.as_deref()?;
    ways::name_field_of(ways, kind).and_then(|field| typed.get(&field)).and_then(|name| ways::normal_name(ways, kind, name))
}

/// One sign-in try with a way: a right proof starts a session (or approves the waiting AI-app connection), a refused
/// one draws the page again with its words.
async fn way_sign_in(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let typed = typed_form(&body);
    let (words, ways, way) = match way_of(&Store::new(&*supplies.storage), &supplies, typed.get("way").map(String::as_str)) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let next = next_of(&headers, typed.get("next").map(String::as_str), &supplies.base);
    if typed.get("reset").map(String::as_str) == Some("1") && way.way == ways.code_way {
        return reset_finish(supplies, words, ways, way, typed, next).await;
    }
    let request = request_of(&next, &supplies.base);
    let work = {
        let (supplies, typed, request, ways, way) = (supplies.clone(), typed.clone(), request.clone(), ways.clone(), way.clone());
        move || -> std::result::Result<(Option<String>, String, Option<usize>), ways::Refused> {
            let store = Store::new(&*supplies.storage);
            match ways::sign_in(&store, &ways, &supplies.account, &way, &typed)? {
                ways::Opened::Session { way, left } => Ok((Some(sessions::start(&store, &supplies.account, &way)?), String::new(), left)),
                ways::Opened::App { scopes } => {
                    let request = request.ok_or(crate::cause!(ways::Refused::NoRequest))?;
                    let url = oauth::decide_by(&store, &supplies.account, &request, true,
                        Some(&scopes),
                        Some(&way.way),
                        Some(&supplies.address),
                    )
                    .map_err(|error| {
                        let cause = error.cause();
                        match error {
                            Error::Storage(_) | Error::SourceNotCurrent(_) => ways::Refused::Storage(cause),
                            Error::SettingsMissing(_) => ways::Refused::Missing(cause),
                            _ => ways::Refused::Wrong(cause),
                        }
                    })?;
                    Ok((None, url, None))
                }
            }
        }
    };
    match blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage))) {
        Ok((Some(cookie), _, Some(left))) => {
            let said = &words.ways;
            let text = if left == 0 { said.listed_last.clone() } else { way_pages::said(&said.listed_left, &[("left", &left.to_string())]) };
            with_session_cookie(html(StatusCode::OK, way_pages::notice(&words, &text, &next)), &cookie, &supplies.address)
        }
        // The code way is the way in of a browser with no passkey: it is offered one for next time.
        Ok((Some(cookie), _, None)) if way.way == ways.code_way => {
            with_session_cookie(html(StatusCode::OK, pages::offer_passkey(&words, &next, &supplies.base)), &cookie, &supplies.address)
        }
        Ok((Some(cookie), _, None)) => with_session_cookie(redirect(&next, None), &cookie, &supplies.address),
        Ok((None, url, _)) => redirect(&url, None),
        Err(refused) => {
            // A sent way keeps the name its code went to, so the code can be typed again.
            let sent_to = match (way.proof, way.named.as_deref()) {
                (ways::Proof::Sent, Some(kind)) => ways::name_field_of(&ways, kind)
                    .and_then(|field| typed.get(&field))
                    .and_then(|name| ways::normal_name(&ways, kind, name)),
                _ => None,
            };
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: request.as_deref(), kept: &typed,
                message: Some(way_pages::refused_words(&words, &ways, &refused, &way)), focus: Some(way_pages::focus_for(&refused, &way, false)) };
            html_to_with_cause(way_status(&refused), way_pages::sign_in(&way, sent_to.as_deref(), &form), waiting_target(&supplies, request.as_deref()).as_deref(), refused.cause())
        }
    }
}

/// `page` starting the session `cookie` names.
fn with_cookie(mut page: Response, cookie: &str) -> Response {
    match HeaderValue::from_str(cookie) {
        Ok(cookie) => {
            page.headers_mut().append(header::SET_COOKIE, cookie);
            page
        }
        Err(_) => named_refusal(StatusCode::SERVICE_UNAVAILABLE.into_response(), crate::cause!(sign_in invalid_cookie_header)),
    }
}

/// Every browser way in carries the same public routing hint as its opaque session cookie. The hint is never
/// checked as authority; it only gets a later visit to the root back to this account's own authenticated paths.
pub(crate) fn with_session_cookie(page: Response, cookie: &str, address: &str) -> Response {
    let page = with_cookie(page, cookie);
    // A browser never keeps two session cookies: the window's own cookie (set by the owner page) is expired here, so a
    // stale one cannot make the workspace refuse every request as ambiguous.
    let page = with_cookie(page, &format!("{}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict", crate::workspace_session::WINDOW_COOKIE));
    match sessions::route_hint::for_session(address, cookie) {
        Some(hint) => with_cookie(page, &hint),
        None => page,
    }
}

/// The signed-in session of this account on the request, or None.
fn session_of(store: &Store<'_>, supplies: &Supplies, headers: &HeaderMap) -> Result<Option<Row<sessions::Session>>> {
    let cookie = headers.get(header::COOKIE).and_then(|value| value.to_str().ok());
    Ok(sessions::current_row(store, cookie)?.filter(|row| row.account == supplies.account))
}

/// Sign in again first, then come back to `back`.
fn sign_in_again(supplies: &Supplies, back: &str) -> Response {
    sign_in_redirect(&supplies.base, back)
}

/// A session that may add, change or remove ways now (`ways::may_change`), or the answer that sends the person to
/// sign in again and come back to `back`.
fn changing_session(store: &Store<'_>, ways: &ways::WaySettings, supplies: &Supplies, headers: &HeaderMap, back: &str)
    -> std::result::Result<Row<sessions::Session>, Box<Response>> {
    match session_of(store, supplies, headers) {
        Ok(Some(session)) => match ways::may_change(ways, &session.value.method, session.value.created_at, now_ms()) {
            Ok(()) => Ok(session),
            Err(error) => Err(Box::new(named_refusal(sign_in_again(supplies, back), error.cause()))),
        },
        Ok(None) => Err(Box::new(sign_in_again(supplies, back))),
        Err(error) => Err(Box::new(page_error(words_of(store, supplies).as_ref(), error))),
    }
}

/// The account's Sign-in & security page, with `message` at its top.
fn security(store: &Store<'_>, words: &Words, ways: &ways::WaySettings, supplies: &Supplies, message: Option<String>) -> Result<Response> {
    let passkeys = store.list::<passkeys::Passkey>(Family::Passkeys, &supplies.account, usize::MAX)?.len();
    let held = ways::held(store, &supplies.account).map_err(|error| crate::carry_cause!(Error::Storage, error))?
        .into_iter()
        .map(|row| {
            let left = match &row.value.material {
                ways::Material::Listed { hashes } => Some(hashes.len()),
                _ => None,
            };
            (row.value.way, (row.value.name, left))
        })
        .collect();
    let keys = super::keys::list(store, &supplies.account)?
        .into_iter()
        .map(|row| (row.id, row.value.name, row.value.ending))
        .collect();
    let waiting = waiting(store, &supplies.account)?.len();
    let view = way_pages::Security { words, ways, base: &supplies.base, passkeys, held, keys, waiting, message };
    Ok(html(StatusCode::OK, way_pages::security(&view)))
}

async fn security_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways) = match ways_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    match session_of(&store, &supplies, &headers) {
        Ok(Some(_)) => security(&store, &words, &ways, &supplies, None).unwrap_or_else(|error| page_error(Some(&words), error)),
        Ok(None) => sign_in_again(&supplies, &format!("{}/sign-in/security", supplies.base)),
        Err(error) => page_error(Some(&words), error),
    }
}

/// A way's add or change page.
async fn way_setup_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<WayQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways, way) = match way_of(&store, &supplies, query.way.as_deref()) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let back = format!("{}/sign-in/security/way?way={}", supplies.base, encoded(&way.way));
    let session = match changing_session(&store, &ways, &supplies, &headers, &back) {
        Ok(session) => session,
        Err(answer) => return *answer,
    };
    let held = match ways::holds(&store, &supplies.account, &way) {
        Ok(held) => held && way.proof != ways::Proof::Key,
        Err(error) => return page_error(Some(&words), crate::carry_cause!(Error::Storage, error)),
    };
    let recovering = way.recover_with.contains(&session.value.method);
    let next = format!("{}/sign-in/security", supplies.base);
    let kept = ways::Typed::new();
    let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &kept, message: None, focus: Some("go") };
    html(StatusCode::OK, way_pages::setup(&way, held, recovering, &way_pages::Step::Start, &form))
}

/// What a step of adding, changing or removing a way answered, drawn as its page.
enum SetupAnswer {
    /// Done: the Sign-in & security page with these words.
    Security(String),
    /// A code went to this name; it is asked next.
    CodeSent(String),
    /// A timed secret waits for its first code.
    Timed { key: String, address: String },
    /// Shown only this once.
    Shown(Vec<String>),
}

/// One step of adding, changing or removing a way, for a session that may change ways.
async fn way_setup(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let typed = typed_form(&body);
    let (words, ways, way) = match way_of(&Store::new(&*supplies.storage), &supplies, typed.get("way").map(String::as_str)) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let back = format!("{}/sign-in/security/way?way={}", supplies.base, encoded(&way.way));
    let session = match changing_session(&Store::new(&*supplies.storage), &ways, &supplies, &headers, &back) {
        Ok(session) => session,
        Err(answer) => return *answer,
    };
    let step = typed.get("step").cloned().unwrap_or_default();
    let issuer = url::Url::parse(&supplies.origin).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
    let work = {
        let (supplies, typed, method, step, issuer) = (supplies.clone(), typed.clone(), session.value.method.clone(), step.clone(), issuer.clone());
        let (words, ways, way) = (words.clone(), ways.clone(), way.clone());
        move || -> std::result::Result<(bool, SetupAnswer), ways::Refused> {
            let store = Store::new(&*supplies.storage);
            let held = ways::holds(&store, &supplies.account, &way)? && way.proof != ways::Proof::Key;
            let own = way_pages::row_words(&words, &way.way);
            let done = |text: &str, name: Option<&str>| way_pages::said(text, &[("name", name.unwrap_or_default())]);
            let who = ways::Adding { account: &supplies.account, address: &supplies.address, method: &method, issuer: &issuer };
            if step == "remove" || (step == "add" && held) {
                way_change_allowed(&store, &supplies.account)?;
            }
            let answer = match step.as_str() {
                "add" => match ways::add(&store, &ways, &who, &way, &typed, supplies.sender.as_deref())? {
                    ways::Added::Held(name) => SetupAnswer::Security(done(if held { &own.changed } else { &own.added }, name.as_deref())),
                    ways::Added::CodeSent { name } => SetupAnswer::CodeSent(name),
                    ways::Added::Setup { key, address } => SetupAnswer::Timed { key, address },
                    ways::Added::Codes(codes) => SetupAnswer::Shown(codes),
                    ways::Added::Key(key) => SetupAnswer::Shown(vec![key.to_string()]),
                },
                "confirm" => {
                    let name = ways::confirm(&store, &ways, &supplies.account, &way, &typed)?;
                    SetupAnswer::Security(done(if held { &own.changed } else { &own.added }, name.as_deref()))
                }
                "remove" => {
                    let passkeys = store.list::<passkeys::Passkey>(Family::Passkeys, &supplies.account, usize::MAX)?.len();
                    ways::remove(&store, &ways, &supplies.account, &way, typed.get("id").map(String::as_str), passkeys)?;
                    SetupAnswer::Security(own.removed.clone())
                }
                _ => return Err(crate::cause!(ways::Refused::Unknown)),
            };
            Ok((held, answer))
        }
    };
    let answer = blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage)));
    let store = Store::new(&*supplies.storage);
    let next = format!("{}/sign-in/security", supplies.base);
    let recovering = way.recover_with.contains(&session.value.method);
    match answer {
        Ok((_, SetupAnswer::Security(message))) => security(&store, &words, &ways, &supplies, Some(message)).unwrap_or_else(|error| page_error(Some(&words), error)),
        Ok((held, SetupAnswer::Shown(items))) => {
            let own = way_pages::row_words(&words, &way.way);
            let (title, intro) = if held { (&own.change_title, &own.changed) } else { (&own.add_title, &own.added) };
            html(StatusCode::OK, way_pages::shown_once(&words, title, intro, &items, &next))
        }
        Ok((held, SetupAnswer::CodeSent(name))) => {
            let kept = ways::Typed::new();
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &kept, message: None, focus: Some(ways::CODE_FIELD) };
            html(StatusCode::OK, way_pages::setup(&way, held, recovering, &way_pages::Step::CodeSent(&name), &form))
        }
        Ok((held, SetupAnswer::Timed { key, address })) => {
            let kept = ways::Typed::new();
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &kept, message: None, focus: Some(ways::CODE_FIELD) };
            html(StatusCode::OK, way_pages::setup(&way, held, recovering, &way_pages::Step::Timed { key: &key, address: &address }, &form))
        }
        Err(refused) => {
            let held = ways::holds(&store, &supplies.account, &way).unwrap_or(false) && way.proof != ways::Proof::Key;
            let message = Some(way_pages::refused_words(&words, &ways, &refused, &way));
            let confirming = step == "confirm";
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &typed, message,
                focus: Some(way_pages::focus_for(&refused, &way, confirming)) };
            let status = way_status(&refused);
            if step == "remove" {
                return security(&store, &words, &ways, &supplies, form.message.clone()).map(|mut page| {
                    *page.status_mut() = status;
                    page
                }).unwrap_or_else(|error| page_error(Some(&words), error));
            }
            // A confirm that failed asks for the code again; a timed setup shows its waiting secret again.
            let who = ways::Adding { account: &supplies.account, address: &supplies.address, method: &session.value.method, issuer: &issuer };
            let page = match (way.proof, confirming) {
                (ways::Proof::Sent, true) => match ways::waiting_name(&store, &supplies.account, &way) {
                    Ok(Some(name)) => way_pages::setup(&way, held, recovering, &way_pages::Step::CodeSent(&name), &form),
                    _ => way_pages::setup(&way, held, recovering, &way_pages::Step::Start, &form),
                },
                (ways::Proof::Sent, false) if matches!(refused, ways::Refused::DeliveryUnknown(_)) => match ways::waiting_name(&store, &supplies.account, &way) {
                    Ok(Some(name)) => way_pages::setup(&way, held, recovering, &way_pages::Step::DeliveryUnknown(&name), &form),
                    _ => way_pages::setup(&way, held, recovering, &way_pages::Step::Start, &form),
                },
                (ways::Proof::Timed, true) => match ways::add(&store, &ways, &who, &way, &typed, None) {
                    Ok(ways::Added::Setup { key, address }) => way_pages::setup(&way, held, recovering, &way_pages::Step::Timed { key: &key, address: &address }, &form),
                    _ => way_pages::setup(&way, held, recovering, &way_pages::Step::Start, &form),
                },
                _ => way_pages::setup(&way, held, recovering, &way_pages::Step::Start, &form),
            };
            html(status, page)
        }
    }
}

/// Removing a way in, or replacing one held, goes only as `known.rs` allows. The page carries no passkey confirmation, so
/// on an account with a known passkey such a change is made through the account routes (`sign-in:remove-way` with a
/// confirmation) instead.
fn way_change_allowed(store: &Store<'_>, account: &str) -> std::result::Result<(), ways::Refused> {
    super::known::way_change(store, account, false).map_err(|refused| {
        let cause = refused.cause();
        match refused {
            super::known::Refused::HeldWhileWaiting(_) => ways::Refused::HeldWhileWaiting(cause),
            super::known::Refused::NeedsKnownPasskey(_) => ways::Refused::NeedsKnownPasskey(cause),
            _ => ways::Refused::Storage(cause),
        }
    })
}

#[derive(Deserialize)]
struct AddEmailQuery {
    next: Option<String>,
}

/// What an add-email step answered: a code sent to this email, or the email added.
enum AddEmailAnswer {
    CodeSent(String),
    Added(String),
}

/// The account's email way (`code_way`, the way under every passkey button), its words and ways, or the page that answers.
fn email_way_of(store: &Store<'_>, supplies: &Supplies) -> std::result::Result<(Words, ways::WaySettings, ways::WayRow), Box<Response>> {
    let (words, ways) = ways_of(store, supplies)?;
    let way = ways.row(&ways.code_way).cloned().ok_or_else(|| Box::new(refused_page(Some(&words))))?;
    Ok((words, ways, way))
}

/// The add-email page: an email for sign-in codes, confirmed by a code sent to it (old src/pages.mjs `addEmailPage`).
async fn add_email_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<AddEmailQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways, way) = match email_way_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let Some(add) = words.ways.add_email.as_ref() else { return without_words(StatusCode::SERVICE_UNAVAILABLE) };
    let back = format!("{}/sign-in/add-email", supplies.base);
    if let Err(answer) = changing_session(&store, &ways, &supplies, &headers, &back) {
        return *answer;
    }
    let next = next_of(&headers, query.next.as_deref(), &supplies.base);
    let kept = ways::Typed::new();
    let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &kept, message: None, focus: way.named.as_deref() };
    html(StatusCode::OK, way_pages::add_email(&way, add, &way_pages::Step::Start, &form))
}

/// One step of the add-email page: `add` sends the code to the typed email, `confirm` checks the code and adds the email.
async fn add_email_step(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let typed = typed_form(&body);
    let (words, ways, way) = match email_way_of(&Store::new(&*supplies.storage), &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    let Some(add) = words.ways.add_email.as_ref() else { return without_words(StatusCode::SERVICE_UNAVAILABLE) };
    let back = format!("{}/sign-in/add-email", supplies.base);
    let session = match changing_session(&Store::new(&*supplies.storage), &ways, &supplies, &headers, &back) {
        Ok(session) => session,
        Err(answer) => return *answer,
    };
    let step = typed.get("step").cloned().unwrap_or_default();
    let confirming = step == "confirm";
    let next = next_of(&headers, typed.get("next").map(String::as_str), &supplies.base);
    let issuer = url::Url::parse(&supplies.origin).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_default();
    let work = {
        let (supplies, typed, method, step, issuer) = (supplies.clone(), typed.clone(), session.value.method.clone(), step.clone(), issuer.clone());
        let (ways, way) = (ways.clone(), way.clone());
        move || -> std::result::Result<AddEmailAnswer, ways::Refused> {
            let store = Store::new(&*supplies.storage);
            if step == "add" && ways::holds(&store, &supplies.account, &way)? {
                way_change_allowed(&store, &supplies.account)?;
            }
            let who = ways::Adding { account: &supplies.account, address: &supplies.address, method: &method, issuer: &issuer };
            match step.as_str() {
                "add" => match ways::add(&store, &ways, &who, &way, &typed, supplies.sender.as_deref())? {
                    ways::Added::CodeSent { name } => Ok(AddEmailAnswer::CodeSent(name)),
                    _ => Err(crate::cause!(ways::Refused::Unknown)),
                },
                "confirm" => {
                    let name = ways::confirm(&store, &ways, &supplies.account, &way, &typed)?;
                    Ok(AddEmailAnswer::Added(name.ok_or(crate::cause!(ways::Refused::SetupEnded))?))
                }
                _ => Err(crate::cause!(ways::Refused::Unknown)),
            }
        }
    };
    let answer = blocking(work).await.unwrap_or_else(|| Err(crate::cause!(ways::Refused::Storage)));
    let store = Store::new(&*supplies.storage);
    match answer {
        Ok(AddEmailAnswer::Added(name)) => {
            let message = way_pages::said(&way_pages::row_words(&words, &way.way).added, &[("name", name.as_str())]);
            security(&store, &words, &ways, &supplies, Some(message)).unwrap_or_else(|error| page_error(Some(&words), error))
        }
        Ok(AddEmailAnswer::CodeSent(name)) => {
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &typed, message: None, focus: Some(ways::CODE_FIELD) };
            html(StatusCode::OK, way_pages::add_email(&way, add, &way_pages::Step::CodeSent(&name), &form))
        }
        Err(refused) => {
            let waiting = ways::waiting_name(&store, &supplies.account, &way).ok().flatten();
            let shown = match (&refused, confirming, waiting.as_deref()) {
                (_, true, Some(name)) => way_pages::Step::CodeSent(name),
                (ways::Refused::DeliveryUnknown(_), false, Some(name)) => way_pages::Step::DeliveryUnknown(name),
                _ => way_pages::Step::Start,
            };
            let form = way_pages::Form { words: &words, ways: &ways, base: &supplies.base, next: &next, request: None, kept: &typed,
                message: Some(way_pages::refused_words(&words, &ways, &refused, &way)), focus: Some(way_pages::focus_for(&refused, &way, confirming)) };
            html(way_status(&refused), way_pages::add_email(&way, add, &shown, &form))
        }
    }
}

/// A one-use passkey link for another device, made by a session that may change ways, shown once.
async fn passkey_link_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let store = Store::new(&*supplies.storage);
    let back = format!("{}/sign-in/security", supplies.base);
    let (words, ways) = match ways_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    if let Err(answer) = changing_session(&store, &ways, &supplies, &headers, &back) {
        return *answer;
    }
    let made = passkey_link(&store, &supplies.account, &format!("{}{}", supplies.origin, supplies.base))
        .and_then(|link| Ok((link, super::lists::current(&store, &supplies.account)?.challenge_seconds)));
    match made {
        Ok((link, seconds)) => {
            let said = &words.ways;
            let minutes = seconds.div_ceil(60).to_string();
            html(StatusCode::OK, way_pages::shown_once(&words, &said.passkey_link_button, &way_pages::said(&said.passkey_link_reveal, &[("minutes", &minutes)]), &[link], &back))
        }
        Err(error) => page_error(Some(&words), error),
    }
}

/// Withdraw every passkey link, challenge and code still waiting, for a session that may change ways: a link that
/// leaked stops working at once instead of running out its time.
async fn withdraw_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let store = Store::new(&*supplies.storage);
    let back = format!("{}/sign-in/security", supplies.base);
    let (words, ways) = match ways_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    if let Err(answer) = changing_session(&store, &ways, &supplies, &headers, &back) {
        return *answer;
    }
    match withdraw(&store, &supplies.account, None) {
        Ok(count) => {
            let message = way_pages::said(&words.ways.withdrawn, &[("count", &count.to_string())]);
            security(&store, &words, &ways, &supplies, Some(message)).unwrap_or_else(|error| page_error(Some(&words), error))
        }
        Err(error) => page_error(Some(&words), error),
    }
}

#[derive(Deserialize)]
struct AddPasskeyQuery {
    link: Option<String>,
}

/// The add-a-passkey page: for a passkey link, or for a signed-in person.
async fn add_passkey_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<AddPasskeyQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways) = match offered_with_words(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    if let Some(link) = query.link.as_deref().filter(|link| !link.is_empty() && link.len() <= 128) {
        return html(StatusCode::OK, pages::add_passkey(&words, Some(link), &supplies.base, ways.as_ref()));
    }
    match signed_in(&store, &supplies.account, &headers) {
        Ok(true) => html(StatusCode::OK, pages::add_passkey(&words, None, &supplies.base, ways.as_ref())),
        Ok(false) => refused_page(Some(&words)),
        Err(error) => page_error(Some(&words), error),
    }
}

/// The set-password page (old src/worker.mjs setPassword's page, src/pages.mjs `setPasswordPage`): for a signed-in person,
/// the account's confirmed email (its `email-code` way) and whether a password is already held decide the page; `next`
/// is where the person was going, offered as a skip.
async fn set_password_page(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, Query(query): Query<NextQuery>) -> Response {
    let store = Store::new(&*supplies.storage);
    let (words, ways) = match ways_of(&store, &supplies) {
        Ok(found) => found,
        Err(answer) => return *answer,
    };
    match signed_in(&store, &supplies.account, &headers) {
        Ok(true) => {}
        Ok(false) => return refused_page(Some(&words)),
        Err(error) => return page_error(Some(&words), error),
    }
    let held = match ways::held(&store, &supplies.account) {
        Ok(held) => held,
        Err(error) => return page_error(Some(&words), crate::carry_cause!(Error::Storage, error)),
    };
    let Some(email) = held.iter().find(|row| row.value.way == "email-code").and_then(|row| row.value.name.clone()) else {
        return refused_page(Some(&words));
    };
    let changing = held.iter().any(|row| row.value.way == "password");
    let offered = query.next.as_deref().map(|next| safe_next(Some(next), &supplies.base));
    html(StatusCode::OK, super::set_password::page(&words, &ways, &supplies.base, &email, changing, offered.as_deref(), None))
}

#[derive(Deserialize)]
struct OptionsBody {
    purpose: String,
    code: Option<String>,
}

async fn passkey_options(State(supplies): State<Arc<Supplies>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(request) = serde_json::from_slice::<OptionsBody>(&body) else {
        return refusal(Error::InvalidRequest("body is not the expected JSON", crate::cause!()), &[("cache-control", "no-store")]);
    };
    let store = Store::new(&*supplies.storage);
    let answer = match request.purpose.as_str() {
        "sign-in" => passkeys::sign_in_options(&store, &supplies.account, &supplies.origin),
        "register" => register_account(&store, &supplies, &headers, request.code.as_deref())
            .and_then(|account| passkeys::registration_options(&store, &account, &supplies.origin)),
        _ => Err(Error::InvalidRequest("purpose is sign-in or register", crate::cause!())),
    };
    match answer {
        Ok(options) => json(StatusCode::OK, &options, &[("cache-control", "no-store")]),
        Err(error) => refusal(error, &[("cache-control", "no-store")]),
    }
}

/// Check a ceremony's answer. A sign-in starts a session and answers its
/// `Set-Cookie` value. A passkey added through a link starts one too, and uses
/// the link up only after its passkey is stored. A passkey added by a
/// signed-in person keeps the session they already have.
fn finish(store: &Store<'_>, supplies: &Supplies, headers: &HeaderMap, body: &Value) -> Result<Option<String>> {
    match body.get("purpose").and_then(Value::as_str) {
        Some("sign-in") => {
            let account = passkeys::finish_sign_in(store, &supplies.origin, body)?;
            if account != supplies.account {
                return Err(crate::cause!(Error::PasskeyRefused));
            }
            sessions::start(store, &account, "passkey").map(Some)
        }
        Some("register") => match body.get("code").and_then(Value::as_str) {
            Some(code) => {
                let account = passkey_link_account(store, &supplies.account, code)?;
                let id = passkeys::finish_registration(store, &account, &supplies.origin, body)?;
                // A link is one use. If this finish cannot take it (another finish
                // took it first), the passkey just stored is taken back out.
                if !matches!(store.take::<PasskeyLink>(Family::Challenges, &link_id(code)), Ok(Some(_))) {
                    store.remove(Family::Passkeys, &id)?;
                    return Err(crate::cause!(Error::Unauthenticated));
                }
                sessions::start(store, &account, "passkey").map(Some)
            }
            None => {
                let account = signed_in_account(store, supplies, headers)?;
                passkeys::finish_registration(store, &account, &supplies.origin, body)?;
                Ok(None)
            }
        },
        _ => Err(Error::InvalidRequest("purpose is sign-in or register", crate::cause!())),
    }
}

async fn passkey_finish(
    State(supplies): State<Arc<Supplies>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return refusal(
            Error::InvalidRequest("body is not the expected JSON", crate::cause!()),
            &[("cache-control", "no-store")],
        );
    };
    let store = Store::new(&*supplies.storage);
    match finish(&store, &supplies, &headers, &body) {
        Ok(cookie) => {
            let answer = json(StatusCode::OK, &json!({"ok": true}), &[("cache-control", "no-store")]);
            match cookie.as_deref() {
                Some(cookie) => with_session_cookie(answer, cookie, &supplies.address),
                None => answer,
            }
        }
        Err(error) => refusal(error, &[("cache-control", "no-store")]),
    }
}

async fn sign_out(State(supplies): State<Arc<Supplies>>, headers: HeaderMap) -> Response {
    if !same_origin(&headers, &supplies.origin) {
        return forbidden_page(&Store::new(&*supplies.storage), &supplies);
    }
    let store = Store::new(&*supplies.storage);
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok());
    match sessions::end(&store, cookie) {
        Ok(clearing) => with_cookie(
            redirect(&format!("{}/sign-in", supplies.base), Some(&clearing)),
            &sessions::route_hint::clearing(),
        ),
        Err(error) => page_error(words_of(&store, &supplies).as_ref(), error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::sign_in::passkeys::{
        tests::{b, registration, Authenticator, ORIGIN},
        Passkey,
    };
    use axum::http::Request;
    use tower::ServiceExt;

    /// A well-formed owner id for the tests (64 lowercase hex).
    const OWNER: &str = "555-0100abcdef555-0100abcdef555-0100abcdef555-0100abcdef";

    fn supplies() -> Supplies {
        Supplies {
            storage: Arc::new(super::super::Locked::new(crate::account::sign_in::lists::test_memory())),
            account: "owner".to_string(),
            address: OWNER.to_string(),
            origin: "https://door.test".to_string(),
            base: String::new(),
            sender: None,
        }
    }

    async fn call(request: Request<Body>) -> Response {
        routes(supplies()).oneshot(request).await.expect("the route table answers")
    }

    fn get_request(uri: &str) -> Request<Body> {
        Request::builder().method("GET").uri(uri).body(Body::empty()).expect("request")
    }

    async fn text(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.expect("body");
        String::from_utf8(bytes.to_vec()).expect("utf-8")
    }

    #[test]
    fn next_paths_stay_on_this_origin() {
        assert_eq!(safe_next(Some("/authorize/continue?request=ab"), ""), "/authorize/continue?request=ab");
        assert_eq!(safe_next(Some("/"), ""), "/");
        assert_eq!(safe_next(None, ""), "/");
        assert_eq!(safe_next(Some("https://evil.example/"), ""), "/");
        assert_eq!(safe_next(Some("//evil.example"), ""), "/");
        assert_eq!(safe_next(Some("/\\evil.example"), ""), "/");
        assert_eq!(safe_next(Some("relative"), ""), "/");
        assert_eq!(safe_next(Some(""), ""), "/");
        assert_eq!(safe_next(Some("/a\nSet-Cookie: x"), ""), "/");
    }

    /// Old trillion never wrote `?next=%2F` (src/pages.mjs:193-200 `wayIn`, src/worker.mjs:674-675). the owner,
    /// 2026-11-05 7:45 PM MST: the desktop browser showed /sign-in?next=%2F.
    #[test]
    fn a_sign_in_address_never_carries_the_return_path() {
        assert_eq!(sign_in_address(""), "/sign-in");
        assert_eq!(sign_in_address("/a/abc"), "/a/abc/sign-in");
        assert_eq!(way_in("", "/sign-in/way", &[("way", "email-code")]), "/sign-in/way?way=email-code");
        assert_eq!(way_in("/a/abc", "/sign-in/way", &[("way", "a b")]), "/a/abc/sign-in/way?way=a+b");
    }

    #[test]
    fn the_return_path_round_trips_through_its_cookie_and_is_checked() {
        let cookie = next_cookie("/authorize/continue?request=ab&x=/y");
        assert!(cookie.starts_with("trillion_next=") && cookie.contains("; Path=/; HttpOnly; Secure; SameSite=Lax"));
        let value = cookie.split(';').next().unwrap().trim_start_matches("trillion_next=");
        assert!(!value.contains('=') && !value.contains('/') && !value.contains('?'), "the cookie value is plain text");
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(&format!("other=1; trillion_next={value}")).unwrap());
        assert_eq!(held_next(&headers).as_deref(), Some("/authorize/continue?request=ab&x=/y"));
        assert_eq!(next_of(&headers, Some("/evil"), "/a/abc"), "/authorize/continue?request=ab&x=/y", "the held path wins over a query");
        assert_eq!(next_of(&HeaderMap::new(), Some("/work"), "/a/abc"), "/work", "a link sent before the cookie still works");
        let mut hostile = HeaderMap::new();
        hostile.insert(header::COOKIE, HeaderValue::from_str(&format!("trillion_next={}", URL_SAFE_NO_PAD.encode("//evil.example"))).unwrap());
        assert_eq!(next_of(&hostile, None, "/a/abc"), "/a/abc/", "a held path is checked like a query");
    }

    #[test]
    fn a_base_path_is_kept_on_the_default_next() {
        assert_eq!(safe_next(None, "/a/abc"), "/a/abc/");
        assert_eq!(safe_next(Some("/a/abc/authorize"), "/a/abc"), "/a/abc/authorize");
    }

    #[test]
    fn origin_must_match_exactly() {
        let mut headers = HeaderMap::new();
        assert!(!same_origin(&headers, "https://door.test"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("https://door.test"));
        assert!(same_origin(&headers, "https://door.test"));
        assert!(!same_origin(&headers, "https://door.test/"));
        assert!(!same_origin(&headers, "https://evil.example"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!same_origin(&headers, "https://door.test"));
    }

    #[test]
    fn passkey_link_is_one_use_and_belongs_to_its_account() {
        let storage = super::super::Locked::new(crate::account::sign_in::lists::test_memory());
        let store = Store::new(&storage);
        let link = passkey_link(&store, "owner", "https://door.test").expect("link");
        assert!(link.starts_with("https://door.test/sign-in/add-passkey?link="));
        let code = code_of(&link);
        assert_eq!(code.len(), 43);
        assert_eq!(passkey_link_account(&store, "owner", &code).expect("account"), "owner");
        assert_eq!(passkey_link_account(&store, "someone-else", &code), Err(crate::cause!(Error::Unauthenticated)));
        assert_eq!(passkey_link_account(&store, "owner", "not-a-code"), Err(crate::cause!(Error::Unauthenticated)));
        assert!(store.take::<PasskeyLink>(Family::Challenges, &link_id(&code)).expect("take").is_some());
        assert_eq!(passkey_link_account(&store, "owner", &code), Err(crate::cause!(Error::Unauthenticated)));
    }

    #[test]
    fn passkey_links_are_distinct_and_stored_only_as_hashes() {
        let storage = super::super::Locked::new(crate::account::sign_in::lists::test_memory());
        let store = Store::new(&storage);
        let first = code_of(&passkey_link(&store, "owner", "https://door.test").expect("first"));
        let second = code_of(&passkey_link(&store, "owner", "https://door.test").expect("second"));
        assert_ne!(first, second);
        assert!(store.get::<PasskeyLink>(Family::Challenges, &first).expect("read").is_none());
        assert!(store.get::<PasskeyLink>(Family::Challenges, &link_id(&first)).expect("read").is_some());
    }

    #[test]
    fn a_page_whose_form_ends_at_an_app_lets_the_form_reach_that_origin_and_no_other() {
        assert_eq!(form_source("https://app.example/callback?x=1").as_deref(), Some("https://app.example"));
        assert_eq!(form_source("http://127.0.0.1:43123/cb").as_deref(), Some("http://127.0.0.1:43123"));
        assert_eq!(form_source("cursor://anysphere.cursor-retrieval/oauth").as_deref(), Some("cursor:"));
        assert_eq!(form_source("not a uri"), None);
        let csp = |page: Response| page.headers().get("content-security-policy").expect("csp").to_str().expect("ascii").to_string();
        let to_app = csp(html_to(StatusCode::OK, String::new(), Some("https://app.example/callback")));
        assert!(to_app.contains("form-action 'self' https://app.example;"), "{to_app}");
        assert!(csp(html(StatusCode::OK, String::new())).contains("form-action 'self';"), "no other page widens it");
        assert!(csp(html_to(StatusCode::OK, String::new(), Some("x; script-src *"))).contains("form-action 'self';"),
            "text that is not an address adds nothing");
    }

    #[test]
    fn refusals_map_to_their_statuses() {
        assert_eq!(refusal(crate::cause!(Error::Storage), &[]).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(refusal(crate::cause!(Error::TooLarge), &[]).status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(refusal(crate::cause!(Error::Unauthenticated), &[]).status(), StatusCode::UNAUTHORIZED);
        assert_eq!(refusal(crate::cause!(Error::PasskeyRefused), &[]).status(), StatusCode::BAD_REQUEST);
        assert_eq!(page_error(None, crate::cause!(Error::Storage)).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(page_error(None, crate::cause!(Error::InvalidRedirectUri)).status(), StatusCode::BAD_REQUEST);
        assert_eq!(refusal(crate::cause!(Error::SourceNotCurrent), &[]).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(page_error(None, crate::cause!(Error::SourceNotCurrent)).status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn a_header_value_that_cannot_be_sent_is_not_dropped() {
        assert_eq!(redirect("/ok\nSet-Cookie: x", None).status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(redirect("/ok", Some("a=b")).headers().get(header::SET_COOKIE).expect("cookie"), "a=b");
    }

    #[tokio::test]
    async fn raw_refusal_pages_and_bad_headers_keep_their_actual_source_conditions() {
        let expected_factory = |condition: &str| {
            let source = include_str!("routes.rs");
            let needle = format!("crate::cause!(caller_site: {condition})");
            let at = source.find(&needle).expect("the exact production factory exists");
            let prefix = &source[..at];
            let line = prefix.bytes().filter(|byte| *byte == b'\n').count() + 1;
            let column = prefix.rsplit('\n').next().unwrap().chars().count() + 1;
            format!("{condition} via {}:{line}:{column}", module_path!().strip_suffix("::tests").unwrap())
        };
        let first = without_words(StatusCode::SERVICE_UNAVAILABLE);
        let second = without_words(StatusCode::SERVICE_UNAVAILABLE);
        let read_cause = |response: &Response| crate::refusal_cause::Cause::from_wire(
            response.headers()["x-trillion-refusal-cause"].to_str().unwrap()).unwrap();
        assert_ne!(read_cause(&first), read_cause(&second), "tracked raw helpers retain their calling conditions");
        for response in [first, second] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(read_cause(&response).condition(), expected_factory("sign_in words_missing"));
            let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
            assert_eq!(body.as_ref(), super::super::words_row::MISSING.as_bytes());
        }
        let private_value = "/ok\nSet-Cookie: private-header-value";
        let bad_location = redirect(private_value, None);
        let bad_cookie = with_cookie(html(StatusCode::OK, String::new()), private_value);
        assert_ne!(read_cause(&bad_location), read_cause(&bad_cookie));
        assert_eq!(read_cause(&bad_location).condition(), "sign_in invalid_response_header");
        assert_eq!(read_cause(&bad_cookie).condition(), "sign_in invalid_cookie_header");
        for response in [bad_location, bad_cookie] {
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert!(!read_cause(&response).id().contains("private-header-value"));
            assert!(axum::body::to_bytes(response.into_body(), 4096).await.unwrap().is_empty());
        }
        let error = crate::cause!(Error::Storage);
        let original = error.cause();
        let response = page_error(None, error);
        assert_eq!(read_cause(&response), original, "missing words never replace a typed failure's original source");
        let typed = crate::cause!(Error::Storage);
        let original = typed.cause();
        let response = refusal(typed, &[]);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(read_cause(&response), original);
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["error"], "temporarily_unavailable");
        assert_eq!(body["cause"], original.id());
        let response = json(StatusCode::BAD_REQUEST, &json!({"error":"invalid_request","cause":"private-header-value"}), &[]);
        let cause = read_cause(&response);
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["error"], "invalid_request");
        assert_eq!(body["cause"], cause.id());
        assert!(!cause.id().contains("private-header-value"));
    }

    #[tokio::test]
    async fn sign_in_page_answers_with_the_csp_and_sanitized_next() {
        let response = call(get_request("/sign-in?next=//evil.example")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers().get("content-security-policy").expect("csp").to_str().expect("ascii").to_string();
        assert!(csp.starts_with("default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; script-src 'sha256-"));
        assert!(csp.contains(&format!("'sha256-{}'", pages::script_hash())));
        assert!(csp.contains("frame-ancestors 'none'") && csp.contains("base-uri 'none'") && csp.contains("form-action 'self'"));
        assert_eq!(response.headers().get(header::CONTENT_TYPE).expect("type"), "text/html; charset=utf-8");
        assert_eq!(response.headers().get("x-frame-options").expect("xfo"), "DENY");
        assert_eq!(response.headers().get("referrer-policy").expect("ref"), "same-origin", "a form post keeps its origin");
        assert_eq!(response.headers().get(header::CACHE_CONTROL).expect("cache"), "no-store");
        let body = text(response).await;
        assert!(body.contains("data-next=\"/\""));
        assert!(!body.contains("evil.example"));
    }

    /// The code in a passkey link URL.
    fn code_of(link: &str) -> String {
        link.split("?link=").nth(1).expect("a link carries its code").to_string()
    }

    /// The sign-in routes at `origin` over one shared storage, which a test can read back.
    fn door(origin: &str) -> (Router, Arc<dyn crate::storage::Storage + Send + Sync>) {
        let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
            Arc::new(super::super::Locked::new(crate::account::sign_in::lists::test_memory()));
        let route_table = routes(Supplies { storage: storage.clone(), account: "owner".into(), address: OWNER.into(), origin: origin.into(), base: String::new(), sender: None });
        (route_table, storage)
    }

    /// A session cookie for `account`, as a `Cookie` header value.
    fn session_cookie(storage: &Arc<dyn crate::storage::Storage + Send + Sync>, account: &str) -> String {
        let store = Store::new(&**storage);
        sessions::start(&store, account, "passkey").expect("session").split(';').next().unwrap().to_string()
    }

    fn post_json(path: &str, cookie: Option<&str>, origin: Option<&str>, body: &Value) -> Request<Body> {
        let mut request = Request::builder().method("POST").uri(path).header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.body(Body::from(body.to_string())).expect("request")
    }

    async fn send(route_table: &Router, request: Request<Body>) -> Response {
        route_table.clone().oneshot(request).await.expect("the route table answers")
    }

    async fn json_of(response: Response) -> Value {
        serde_json::from_str(&text(response).await).expect("json")
    }

    #[tokio::test]
    async fn add_passkey_page_needs_a_link_or_a_signed_in_session() {
        let (route_table, storage) = door("https://door.test");
        assert_eq!(send(&route_table, get_request("/sign-in/add-passkey")).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(send(&route_table, get_request("/sign-in/add-passkey?link=")).await.status(), StatusCode::BAD_REQUEST);
        let linked = send(&route_table, get_request("/sign-in/add-passkey?link=abc-_123")).await;
        assert_eq!(linked.status(), StatusCode::OK);
        assert!(text(linked).await.contains("data-code=\"abc-_123\""));

        let cookie = session_cookie(&storage, "owner");
        let signed_in = Request::builder().uri("/sign-in/add-passkey").header(header::COOKIE, cookie).body(Body::empty()).expect("request");
        let page = send(&route_table, signed_in).await;
        assert_eq!(page.status(), StatusCode::OK);
        let html = text(page).await;
        assert!(html.contains("data-purpose=\"register\"") && !html.contains("data-code="));
    }

    #[tokio::test]
    async fn set_password_page_needs_a_signed_in_session_and_a_confirmed_email() {
        let (route_table, storage) = door("https://door.test");
        ways::set(&Store::new(&*storage), "owner", 0, ways::for_tests()).expect("the account's ways");
        assert_eq!(send(&route_table, get_request("/sign-in/set-password")).await.status(), StatusCode::BAD_REQUEST);
        // Signed in, but no email is confirmed for the account yet: the page has nothing to sign in with, so it refuses.
        let cookie = session_cookie(&storage, "owner");
        let signed_in = Request::builder().uri("/sign-in/set-password?next=/buy/plan").header(header::COOKIE, cookie).body(Body::empty()).expect("request");
        assert_eq!(send(&route_table, signed_in).await.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn a_withdrawn_passkey_link_is_refused_at_once_and_a_listing_shows_no_secret() {
        let (route_table, storage) = door(ORIGIN);
        let store = Store::new(&*storage);
        let options = |code: &str| post_json("/passkey/options", None, Some(ORIGIN), &json!({"purpose": "register", "code": code}));
        let kept = code_of(&passkey_link(&store, "owner", ORIGIN).expect("link"));
        let leaked = code_of(&passkey_link(&store, "owner", ORIGIN).expect("link"));
        passkey_link(&store, "someone-else", ORIGIN).expect("another account's link");

        let listed = waiting(&store, "owner").expect("listed");
        assert_eq!(listed.len(), 2, "only the account's own");
        assert!(listed.iter().all(|one| one.kind == "passkey-link"));
        let shown = serde_json::to_string(&listed).unwrap();
        assert!(!shown.contains(&kept) && !shown.contains(&leaked) && !shown.contains(&blake3_hex(&leaked)), "a listing names no code");

        let handle = blake3_hex(&link_id(&leaked));
        assert_eq!(withdraw(&store, "someone-else", Some(&handle)).expect("withdraw"), 0, "another account withdraws nothing of this one");
        assert_eq!(withdraw(&store, "owner", Some(&handle)).expect("withdraw"), 1);
        assert_eq!(send(&route_table, options(&leaked)).await.status(), StatusCode::UNAUTHORIZED, "withdrawn: refused at once");
        assert_eq!(send(&route_table, options(&kept)).await.status(), StatusCode::OK, "the other link still works");
        assert_eq!(withdraw(&store, "owner", Some(&handle)).expect("again"), 0, "withdrawing again changes nothing");

        // Withdrawing every one ends the ceremony the kept link started too, and leaves the other account's.
        assert_eq!(withdraw(&store, "owner", None).expect("all"), 2);
        assert!(waiting(&store, "owner").expect("listed").is_empty());
        assert_eq!(waiting(&store, "someone-else").expect("listed").len(), 1);
    }

    #[tokio::test]
    async fn a_signed_in_person_adds_a_passkey_to_their_own_account_without_a_link() {
        let (route_table, storage) = door(ORIGIN);
        let auth = Authenticator::ec(7);
        let cookie = session_cookie(&storage, "owner");
        let other = session_cookie(&storage, "someone-else");
        let register = json!({"purpose": "register"});

        assert_eq!(send(&route_table, post_json("/passkey/options", None, Some(ORIGIN), &register)).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(send(&route_table, post_json("/passkey/options", Some(&other), Some(ORIGIN), &register)).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(send(&route_table, post_json("/passkey/options", Some(&cookie), Some("https://evil.example"), &register)).await.status(), StatusCode::UNAUTHORIZED);
        let options = send(&route_table, post_json("/passkey/options", Some(&cookie), Some(ORIGIN), &register)).await;
        assert_eq!(options.status(), StatusCode::OK);
        let challenge = json_of(options).await["challenge"].as_str().expect("challenge").to_string();

        let mut body = registration(&auth, &challenge);
        body["purpose"] = json!("register");
        body["name"] = json!("Work laptop");
        assert_eq!(send(&route_table, post_json("/passkey/finish", None, Some(ORIGIN), &body)).await.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(send(&route_table, post_json("/passkey/finish", Some(&cookie), Some("https://evil.example"), &body)).await.status(), StatusCode::UNAUTHORIZED);

        let finished = send(&route_table, post_json("/passkey/finish", Some(&cookie), Some(ORIGIN), &body)).await;
        assert_eq!(finished.status(), StatusCode::OK);
        assert!(finished.headers().get(header::SET_COOKIE).is_none(), "the session they have is kept, not replaced");
        let stored = Store::new(&*storage).get::<Passkey>(Family::Passkeys, &b(&auth.id)).expect("read").expect("stored");
        assert_eq!(stored.account, "owner");
        assert_eq!(stored.value.name, "Work laptop");
    }

    #[tokio::test]
    async fn a_failed_passkey_link_finish_keeps_the_link_for_a_retry() {
        let (route_table, storage) = door(ORIGIN);
        let code = code_of(&passkey_link(&Store::new(&*storage), "owner", ORIGIN).expect("link"));
        let auth = Authenticator::ec(8);
        let link_options = json!({"purpose": "register", "code": code});

        let options = send(&route_table, post_json("/passkey/options", None, None, &link_options)).await;
        assert_eq!(options.status(), StatusCode::OK);
        let challenge = json_of(options).await["challenge"].as_str().expect("challenge").to_string();

        // The ceremony fails after its challenge is checked: no public key in the answer.
        let mut broken = registration(&auth, &challenge);
        broken["purpose"] = json!("register");
        broken["code"] = json!(code);
        broken["response"].as_object_mut().expect("response").remove("publicKey");
        let refused = send(&route_table, post_json("/passkey/finish", None, None, &broken)).await;
        assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_of(refused).await["error"], "passkey_refused");
        assert!(Store::new(&*storage).get::<Passkey>(Family::Passkeys, &b(&auth.id)).expect("read").is_none());

        let retry = send(&route_table, post_json("/passkey/options", None, None, &link_options)).await;
        assert_eq!(retry.status(), StatusCode::OK, "the failed finish did not use the link");
        let page = send(&route_table, get_request(&format!("/sign-in/add-passkey?link={code}"))).await;
        assert_eq!(page.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_successful_passkey_link_finish_adds_the_passkey_and_uses_the_link_up() {
        let (route_table, storage) = door(ORIGIN);
        let code = code_of(&passkey_link(&Store::new(&*storage), "owner", ORIGIN).expect("link"));
        let link_options = json!({"purpose": "register", "code": code});
        let auth = Authenticator::ec(9);

        let options = send(&route_table, post_json("/passkey/options", None, None, &link_options)).await;
        let challenge = json_of(options).await["challenge"].as_str().expect("challenge").to_string();
        let mut body = registration(&auth, &challenge);
        body["purpose"] = json!("register");
        body["code"] = json!(code);
        body["name"] = json!("Work laptop");
        let done = send(&route_table, post_json("/passkey/finish", None, None, &body)).await;
        assert_eq!(done.status(), StatusCode::OK);
        let cookie = done.headers().get(header::SET_COOKIE).expect("a session starts").to_str().expect("ascii").to_string();
        assert!(cookie.starts_with("__Host-trillion_session="));
        let stored = Store::new(&*storage).get::<Passkey>(Family::Passkeys, &b(&auth.id)).expect("read").expect("stored");
        assert_eq!(stored.account, "owner");
        assert_eq!(stored.value.name, "Work laptop");

        assert_eq!(send(&route_table, post_json("/passkey/options", None, None, &link_options)).await.status(), StatusCode::UNAUTHORIZED);
        let second = Authenticator::ec(10);
        let mut reused = registration(&second, &challenge);
        reused["purpose"] = json!("register");
        reused["code"] = json!(code);
        assert_eq!(send(&route_table, post_json("/passkey/finish", None, None, &reused)).await.status(), StatusCode::UNAUTHORIZED);
        assert!(Store::new(&*storage).get::<Passkey>(Family::Passkeys, &b(&second.id)).expect("read").is_none());
    }

    #[tokio::test]
    async fn preflight_answers_cors_without_credentials() {
        for path in ["/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/oauth-authorization-server"] {
            let request = Request::builder().method("OPTIONS").uri(path).body(Body::empty()).expect("request");
            let response = call(request).await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT, "{path}");
            assert_eq!(response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).expect("origin"), "*", "{path}");
            assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS).is_some(), "{path}");
            assert!(response.headers().get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none(), "{path}");
        }
    }

    #[tokio::test]
    async fn bodies_over_the_limit_are_refused_before_any_handler() {
        let big = vec![b'a'; computer().max_body_bytes + 1];
        let request = Request::builder().method("POST").uri("/oauth/token").header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from(big)).expect("request");
        assert_eq!(call(request).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn decide_and_sign_out_refuse_a_foreign_origin_before_reading_anything() {
        let decide_request = Request::builder().method("POST").uri("/authorize/decide").header(header::ORIGIN, "https://evil.example")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(Body::from("request=x&allow=yes")).expect("request");
        assert_eq!(call(decide_request).await.status(), StatusCode::FORBIDDEN);
        let sign_out_request = Request::builder().method("POST").uri("/sign-out").body(Body::empty()).expect("request");
        assert_eq!(call(sign_out_request).await.status(), StatusCode::FORBIDDEN);
    }

    /// One AI app connects end to end through the routes: register, the person
    /// approves while signed in, the code is exchanged with its PKCE verifier,
    /// the access token passes the MCP routes' bearer check, the refresh token
    /// rotates, and replaying the old refresh token disconnects the app.
    #[tokio::test]
    async fn an_ai_app_connects_end_to_end_and_a_replayed_refresh_disconnects_it() {
        let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
            Arc::new(super::super::Locked::new(crate::account::sign_in::lists::test_memory()));
        let route_table = routes(Supplies { storage: storage.clone(), account: "owner".into(), address: OWNER.into(), origin: "https://door.test".into(), base: String::new(), sender: None });
        let send = |request: Request<Body>| route_table.clone().oneshot(request);
        let json = |response: Response| async move { serde_json::from_str::<serde_json::Value>(&text(response).await).expect("json") };

        let registered = send(Request::builder().method("POST").uri("/oauth/register").header("content-type", "application/json")
            .body(Body::from(r#"{"redirect_uris":["https://app.example/callback"],"client_name":"Test AI"}"#)).unwrap()).await.unwrap();
        assert_eq!(registered.status(), StatusCode::CREATED);
        let client_id = json(registered).await["client_id"].as_str().unwrap().to_string();

        let cookie = {
            let store = Store::new(&*storage);
            let set = sessions::start(&store, "owner", "passkey").unwrap();
            set.split(';').next().unwrap().to_string()
        };
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let authorize = format!("/authorize?response_type=code&client_id={client_id}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&code_challenge={challenge}&code_challenge_method=S256&state=xyz");
        let page = send(Request::builder().uri(&authorize).header("cookie", &cookie).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(page.status(), StatusCode::OK);
        let html = text(page).await;
        assert!(html.contains("Test AI"));
        let request = html.split("name=\"request\" value=\"").nth(1).unwrap().split('"').next().unwrap().to_string();

        let decided = send(Request::builder().method("POST").uri("/authorize/decide").header("cookie", &cookie).header("origin", "https://door.test")
            .header("content-type", "application/x-www-form-urlencoded").body(Body::from(format!("request={request}&allow=yes"))).unwrap()).await.unwrap();
        assert!(decided.status().is_redirection());
        let location = decided.headers()["location"].to_str().unwrap().to_string();
        assert!(location.starts_with("https://app.example/callback?"));
        let back = url::Url::parse(&location).unwrap();
        let pairs: std::collections::HashMap<_, _> = back.query_pairs().into_owned().collect();
        assert_eq!(pairs["state"], "xyz");
        let code = pairs["code"].clone();

        let form = |body: String| Request::builder().method("POST").uri("/oauth/token").header("content-type", "application/x-www-form-urlencoded").body(Body::from(body)).unwrap();
        let wrong = send(form(format!("grant_type=authorization_code&code={code}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&client_id={client_id}&code_verifier={}", "x".repeat(43)))).await.unwrap();
        assert_eq!(wrong.status(), StatusCode::BAD_REQUEST);
        let issued = send(form(format!("grant_type=authorization_code&code={code}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&client_id={client_id}&code_verifier={verifier}"))).await.unwrap();
        assert_eq!(issued.status(), StatusCode::OK);
        let issued = json(issued).await;
        let (access, refresh) = (issued["access_token"].as_str().unwrap().to_string(), issued["refresh_token"].as_str().unwrap().to_string());

        let store = Store::new(&*storage);
        let principal = oauth::bearer(&store, &access).unwrap().expect("the access token admits");
        assert_eq!(principal.account, "owner");
        assert_eq!(principal.client_id.as_deref(), Some(client_id.as_str()));

        let rotated = send(form(format!("grant_type=refresh_token&refresh_token={refresh}&client_id={client_id}"))).await.unwrap();
        assert_eq!(rotated.status(), StatusCode::OK);
        let rotated = json(rotated).await;
        let new_access = rotated["access_token"].as_str().unwrap().to_string();
        assert!(oauth::bearer(&store, &new_access).unwrap().is_some());

        let replayed = send(form(format!("grant_type=refresh_token&refresh_token={refresh}&client_id={client_id}"))).await.unwrap();
        assert_eq!(replayed.status(), StatusCode::BAD_REQUEST);
        assert!(oauth::bearer(&store, &new_access).unwrap().is_none(), "a replayed refresh token disconnects the app");
        assert!(oauth::grants(&store, "owner").unwrap().is_empty());

        // A personal key is checked in the same computer and is the same kind of principal.
        let (key, _) = super::super::keys::issue(&store, "owner", OWNER, "script", &crate::account::sign_in::contract().scopes.clone(), 0).unwrap();
        assert_eq!(super::super::keys::check(&store, &key).unwrap().expect("the key admits").account, "owner");
    }

    /// A phone app's sign-in as it opens it: it registers with its own custom-scheme redirect, then opens /authorize. A
    /// build that asks for an older issuer's scope ("decisions") reaches the sign-in page (2026-11-05 7:45 PM MST: the
    /// person's phone was refused there); a request the door refuses after the app's redirect is known goes back to
    /// the app; an unknown client stays a page.
    #[tokio::test]
    async fn a_phone_apps_sign_in_reaches_the_sign_in_page_and_a_refusal_goes_back_to_the_app() {
        let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
            Arc::new(super::super::Locked::new(crate::account::sign_in::lists::test_memory()));
        let route_table = routes(Supplies { storage: storage.clone(), account: "owner".into(), address: OWNER.into(), origin: ORIGIN.into(), base: String::new(), sender: None });
        let send = |request: Request<Body>| route_table.clone().oneshot(request);
        let registered = send(Request::builder().method("POST").uri("/oauth/register").header("content-type", "application/json")
            .body(Body::from(r#"{"client_name":"Phone app","redirect_uris":["phone-app://oauth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}"#))
            .unwrap()).await.unwrap();
        assert_eq!(registered.status(), StatusCode::CREATED);
        let client_id = serde_json::from_str::<serde_json::Value>(&text(registered).await).unwrap()["client_id"].as_str().unwrap().to_string();
        let opened = |scope: &str, response_type: &str| format!("/authorize?response_type={response_type}&client_id={client_id}\
            &redirect_uri=phone-app://oauth/callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM\
            &code_challenge_method=S256&state=phone-state&scope={scope}&resource={ORIGIN}/mcp");

        for scope in ["decisions", "records%20tools"] {
            let answer = send(Request::builder().uri(opened(scope, "code")).body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(answer.status(), StatusCode::SEE_OTHER, "{scope}");
            let location = answer.headers()["location"].to_str().unwrap();
            assert_eq!(location, "/sign-in", "{scope}");
            let held = answer.headers()[header::SET_COOKIE].to_str().unwrap();
            assert!(held.starts_with("trillion_next=") && held.contains("; HttpOnly; Secure; SameSite=Lax"), "{scope}: {held}");
        }

        let refused = send(Request::builder().uri(opened("decisions", "token")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(refused.status(), StatusCode::SEE_OTHER);
        let back = url::Url::parse(refused.headers()["location"].to_str().unwrap()).unwrap();
        assert_eq!((back.scheme(), back.host_str(), back.path()), ("phone-app", Some("oauth"), "/callback"));
        let pairs: std::collections::HashMap<_, _> = back.query_pairs().into_owned().collect();
        assert_eq!((pairs["error"].as_str(), pairs["state"].as_str()), ("invalid_request", "phone-state"));

        let unknown = send(Request::builder().uri("/authorize?response_type=code&client_id=no-such-client&state=s")
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
        assert_eq!(text(unknown).await, pages::notice(&super::super::words_row::for_tests(), Notice::Refused));
    }

    #[tokio::test]
    async fn a_web_link_opened_on_the_sign_in_page_signs_in_once_and_then_shows_the_page() {
        let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
            Arc::new(super::super::Locked::new(crate::account::sign_in::lists::test_memory()));
        let route_table = routes(Supplies { storage: storage.clone(), account: "owner".into(), address: OWNER.into(), origin: ORIGIN.into(), base: String::new(), sender: None });
        let store = Store::new(&*storage);
        let (link, _) = sessions::web_link(&store, "owner", ORIGIN, "", Some("/sign-in/security")).unwrap();
        let path = link.strip_prefix(ORIGIN).unwrap().to_string();
        let opened = send(&route_table, get_request(&path)).await;
        assert_eq!(opened.status(), StatusCode::SEE_OTHER);
        assert_eq!(opened.headers().get(header::LOCATION).unwrap(), "/sign-in/security");
        let cookie = opened.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
        assert!(sessions::current(&store, Some(&cookie)).unwrap().is_some_and(|principal| principal.account == "owner"));
        let again = send(&route_table, get_request(&path)).await;
        assert_eq!(again.status(), StatusCode::OK, "a used link shows the sign-in page");
        assert!(again.headers().get(header::SET_COOKIE).is_none());
        let made_up = send(&route_table, get_request("/sign-in?from_app=nope")).await;
        assert_eq!(made_up.status(), StatusCode::OK);
    }

    #[test]
    fn a_session_start_expires_the_window_cookie_too() {
        let page = with_session_cookie(redirect("/ok", None), "__Host-trillion_session=abc; Path=/; HttpOnly", "addr");
        let cookies: Vec<&str> = page.headers().get_all(header::SET_COOKIE).iter().map(|value| value.to_str().expect("ascii")).collect();
        assert!(cookies.iter().any(|cookie| cookie.starts_with("nm_session=") && cookie.contains("Max-Age=0")), "{cookies:?}");
    }
}
