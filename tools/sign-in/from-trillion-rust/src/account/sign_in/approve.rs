// src/account/sign_in/approve.rs
//
// Purpose: The one page where a signed-in person approves an offered change with their passkey. An owner of an offer
// (the computer grants door: a tool's offer of a capability) answers what the offer holds (`Road::read`) and applies it
// when the person is confirmed (`Road::apply`); this page shows the offer in the account's words, asks the browser's
// passkey step to sign a one-use challenge for exactly that offer (`person_confirmation::assertion_request`), and sends
// the assertion back to the owner, which checks it. The page names no tool, capability or offer kind: it draws what the
// owner answers, so every offer of every tool is approved here.
//
// Non-Negotiable Invariants:
// - Only the person's own signed-in page reaches it: a request names this origin (a GET may name none) and its session
//   cookie names a live session of the account (`routes::person_signed_in`); a GET with no session is sent to sign in
//   and back here.
// - The page decides nothing. The owner's apply checks the passkey assertion for exactly the offer (a one-use challenge
//   rebuilt from the offer's id, never from this page's words), so a script or a forged request approves nothing.
// - Every word is the account's words row (`pages::Words::approve`); what the offer says is drawn as text, never as markup.
// - A challenge is only issued for an offer the owner can read back, so no challenge waits for an id nobody offered.
//
// Security Considerations:
// - The offer's id is in the address the person opens; it is the offer's content hash, not a secret. Opening it grants
//   nothing: only a passkey assertion by the person does.
// - Answers carry `cache-control: no-store`; no offer text or assertion is logged.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

use super::pages::{self, Words};
use super::routes::{html, json, next_cookie, person_signed_in, redirect, sign_in_address};
use super::shell::{Action, Item, Pairs, Section};
use super::store::Store;
use super::{words_row, Shared};
use crate::account::person_confirmation::{assertion_request, Requirement};
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// The page's script, inline and allowed by its SHA-256 in the CSP (`pages::script_sources`): the passkey step for the
/// challenge the page asked for, then the assertion sent to apply.
pub(crate) const SCRIPT: &str = concat!(r##"(function () {
  "use strict";
  var button = document.querySelector("[data-approve]");
  if (!button) return;
  var base = button.getAttribute("data-base") || "";
  var offer = button.getAttribute("data-offer") || "";
  var message = document.querySelector(".page-status");
"##, include_str!("passkey_bytes.js"), r##"  function post(path, body) {
    return fetch(base + path, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }).then(function (reply) {
      if (!reply.ok) throw new Error("status " + reply.status);
      return reply.json();
    });
  }
  button.addEventListener("click", function () {
    button.disabled = true;
    message.textContent = "";
    post("/approve/challenge", { offer: offer }).then(function (asked) {
      return navigator.credentials.get({ publicKey: {
        challenge: fromB64(asked.challenge), rpId: asked.rp_id, userVerification: "required", timeout: Math.max(asked.expires_at_ms - Date.now(), 1),
        allowCredentials: asked.credential_ids.map(function (id) { return { type: "public-key", id: fromB64(id) }; })
      } }).then(function (credential) {
        var r = credential.response;
        return post("/approve/apply", { offer: offer, nonce: asked.nonce, assertion: {
          id: credential.id, rawId: toB64(credential.rawId), type: credential.type,
          response: {
            clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData),
            signature: toB64(r.signature), userHandle: toB64(r.userHandle)
          }
        } });
      });
    }).then(function () {
      button.hidden = true;
      button.style.display = "none";
      message.textContent = button.getAttribute("data-done");
    }).catch(function () {
      button.disabled = false;
      message.textContent = button.getAttribute("data-failed");
    });
  });
})();
"##);

/// What the owner of an offer answers when it cannot: its own refusal code with its construction cause, never the offer.
pub(crate) type Failed = crate::refusal_cause::CodedError<String>;

/// Reads one offer back as the page shows it; Err when there is no such live offer.
pub(crate) type Read = dyn Fn(&str) -> Result<Value, Failed> + Send + Sync;
/// Applies one offer with the person's confirmation ({nonce, assertion}) under a request key.
pub(crate) type Apply = dyn Fn(&str, &str, &Value) -> Result<Value, Failed> + Send + Sync;
/// What the person confirms to apply one offer: the owner's own statement of it, so the challenge the page asks for binds
/// exactly what the owner checks when it applies.
pub(crate) type Approval = dyn Fn(&str) -> Requirement + Send + Sync;

/// What the routes need: the account's sign-in storage and names, and the owner of the offers.
pub(crate) struct Road {
    /// The `sign_in` schema storage.
    pub storage: Shared,
    /// The account's sign-in user id (its sessions and words row name it).
    pub user: String,
    /// The account's owner id (the passkeys a confirmation is checked against are registered under it).
    pub owner: String,
    /// The public origin, "https://host".
    pub origin: String,
    /// The path the account's routes are served under, "/a/<address>", or "" at the origin's root.
    pub base: String,
    pub read: Arc<Read>,
    pub apply: Arc<Apply>,
    pub approval: Arc<Approval>,
}

#[derive(Deserialize)]
struct Asked {
    offer: Option<String>,
}

/// The approve routes over `road`: the page, the challenge and the apply.
pub(crate) fn routes(road: Road) -> Router {
    Router::new()
        .route("/approve", get(page))
        .route("/approve/challenge", post(challenge))
        .route("/approve/apply", post(apply))
        .with_state(Arc::new(road))
}

/// A refusal answered as its status: the error is the status's own reason, never a word of this page's.
#[track_caller]
fn refused(status: StatusCode) -> Response {
    let cause = crate::cause!(caller_site: approve refused);
    let error = status.canonical_reason().unwrap_or_default().to_lowercase().replace(' ', "_");
    json(status, &json!({"error": error, "cause": cause.id()}), &[("cache-control", "no-store")])
}

/// A word with `{tool}` and `{capability}` filled in.
fn said(text: &str, tool: &str, capability: &str) -> String {
    super::way_pages::said(text, &[("tool", tool), ("capability", capability)])
}

/// One offer as an owner reads it back (`{offer, offer_record: {tool, capability, holdings, why}}`): the tool, the
/// capability, what it would hold and why it asks. A field it lacks is empty text; nothing else is drawn from it.
fn described(read: &Value) -> (String, String, Vec<String>, String) {
    let record = read.get("offer_record").unwrap_or(read);
    let text = |name: &str| record.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
    let holdings = record
        .get("holdings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|held| match held.as_object() {
            Some(sets) => sets
                .iter()
                .map(|(name, value)| format!("{name}: {}", value.as_str().map_or_else(|| value.to_string(), str::to_owned)))
                .collect::<Vec<_>>()
                .join(", "),
            None => held.to_string(),
        })
        .collect();
    (text("tool"), text("capability"), holdings, text("why"))
}

/// The approve page for `offer` in `words`.
pub(crate) fn approve_page(words: &Words, base: &str, offer: &str, read: &Value) -> String {
    let w = &words.approve;
    let (tool, capability, holdings, why) = described(read);
    let mut first = pages::welcome(pages::look(), &w.title, Some(&said(&w.body, &tool, &capability)));
    let data = vec![
        ("approve".to_string(), String::new()),
        ("base".to_string(), base.to_string()),
        ("offer".to_string(), offer.to_string()),
        ("done".to_string(), said(&w.done, &tool, &capability)),
        ("failed".to_string(), w.failed.clone()),
    ];
    first.actions = vec![Action { label: Some(w.button.clone()), button: Some(Pairs(data)), ..Default::default() }];
    first.status = Some(String::new());
    let mut held = Section { heading: Some(w.holds.clone()), heading_level: Some(2), ..Default::default() };
    held.items = holdings.into_iter().map(|line| Item { body: Some(line), ..Default::default() }).collect();
    let mut sections = vec![first, held];
    if !why.trim().is_empty() {
        sections.push(Section { heading: Some(w.why.clone()), heading_level: Some(2), body: Some(why), ..Default::default() });
    }
    let mut page = pages::auth_page(&w.title, sections);
    page.scripts.push(SCRIPT.to_string());
    pages::draw(&page)
}

async fn page(State(road): State<Arc<Road>>, headers: HeaderMap, Query(asked): Query<Asked>) -> Response {
    let Some(offer) = asked.offer.filter(|offer| !offer.is_empty()) else {
        return refused(StatusCode::BAD_REQUEST);
    };
    if !person_signed_in(&road.storage, &road.user, &road.origin, &Method::GET, &headers) {
        let back = format!("{}/approve?offer={}", road.base, urlencoding(&offer));
        return redirect(&sign_in_address(&road.base), Some(&next_cookie(&back)));
    }
    let words = match words_row::current(&Store::new(&*road.storage), &road.user) {
        Ok(Some(words)) => words,
        _ => return refused(StatusCode::SERVICE_UNAVAILABLE),
    };
    match (road.read)(&offer) {
        Ok(read) => html(StatusCode::OK, approve_page(&words, &road.base, &offer, &read)),
        Err(_) => html(StatusCode::NOT_FOUND, pages::notice_text(&words, &words.approve.gone)),
    }
}

/// The percent-encoding of an offer id in a query (an id is hex, so this changes nothing in practice).
fn urlencoding(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// A person's request: from this origin with a live session, and a JSON object body.
fn person_request(road: &Road, headers: &HeaderMap, body: &Bytes) -> Result<Value, Response> {
    if !person_signed_in(&road.storage, &road.user, &road.origin, &Method::POST, headers) {
        return Err(refused(StatusCode::UNAUTHORIZED));
    }
    serde_json::from_slice::<Value>(body)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| refused(StatusCode::BAD_REQUEST))
}

async fn challenge(State(road): State<Arc<Road>>, headers: HeaderMap, body: Bytes) -> Response {
    let body = match person_request(&road, &headers, &body) {
        Ok(body) => body,
        Err(answer) => return answer,
    };
    let Some(offer) = body.get("offer").and_then(Value::as_str).filter(|offer| !offer.is_empty()) else {
        return refused(StatusCode::BAD_REQUEST);
    };
    if (road.read)(offer).is_err() {
        return refused(StatusCode::NOT_FOUND);
    }
    match assertion_request(&road.owner, &(road.approval)(offer)) {
        Ok(asked) => json(StatusCode::OK, &asked, &[("cache-control", "no-store")]),
        Err(refusal) => {
            crate::quiet_eprintln!("approve-refusal cause={}", refusal.cause());
            refused(StatusCode::CONFLICT)
        }
    }
}

async fn apply(State(road): State<Arc<Road>>, headers: HeaderMap, body: Bytes) -> Response {
    let body = match person_request(&road, &headers, &body) {
        Ok(body) => body,
        Err(answer) => return answer,
    };
    let (Some(offer), Some(nonce), Some(assertion)) = (
        body.get("offer").and_then(Value::as_str).filter(|offer| !offer.is_empty()),
        body.get("nonce").and_then(Value::as_str).filter(|nonce| !nonce.is_empty()),
        body.get("assertion").filter(|assertion| assertion.is_object()),
    ) else {
        return refused(StatusCode::BAD_REQUEST);
    };
    let proof = json!({"nonce": nonce, "assertion": assertion});
    // One request key per confirmation: a retry of this same step is the same change.
    let key = format!("approve:{nonce}");
    let (road, offer) = (road.clone(), offer.to_owned());
    let ran = tokio::task::spawn_blocking(move || (road.apply)(&offer, &key, &proof)).await;
    match ran {
        Ok(Ok(done)) => json(StatusCode::OK, &done, &[("cache-control", "no-store")]),
        Ok(Err(code)) => {
            crate::quiet_eprintln!("approve-refusal code={code}");
            refused(StatusCode::BAD_REQUEST)
        }
        Err(_) => refused(StatusCode::SERVICE_UNAVAILABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::person_confirmation::{
        confirm_write, register_passkeys,
        tests::{FixturePasskey, ORIGIN as PASSKEY_ORIGIN},
    };
    use axum::{body::Body, http::{header, Request}};
    use tower::ServiceExt;

    const OFFER: &str = "synthetic-offer-1";
    const OWNER: &str = "synthetic-approve-owner";

    fn read(offer: &str) -> Result<Value, Failed> {
        if offer == OFFER {
            Ok(json!({"offer": offer, "offer_record": {"tool": "tool:synthetic", "capability": "synthetic-capability",
                "holdings": [{"folder": "/Synthetic/<b>"}], "until": 4_102_444_800_000_i64, "why": "to <i>test</i> the page"}}))
        } else {
            Err(crate::refusal_cause::CodedError::new("not_granted".to_owned()))
        }
    }

    fn approval(offer: &str) -> Requirement {
        crate::tool_runs::tools::computer::Capabilities::approval_of(offer)
    }

    /// An owner that applies as the grants door does: the confirmation is checked for exactly this offer, once.
    fn apply(owner: &str, offer: &str, proof: &Value) -> Result<Value, Failed> {
        confirm_write(owner, &approval(offer), Some(proof)).map_err(|refused| crate::refusal_cause::CodedError::with_cause("needs_person_present".to_owned(), refused.cause()))?;
        Ok(json!({"granted": true}))
    }

    /// The routes for `owner`, whose passkeys are registered process-wide: each test names its own.
    fn door(owner: &str) -> (Router, Shared, String) {
        let storage: Shared = Arc::new(super::super::Locked::new(super::super::lists::test_memory()));
        let cookie = super::super::sessions::start(&Store::new(&*storage), "owner", "passkey").unwrap().split(';').next().unwrap().to_owned();
        let road = Road {
            storage: storage.clone(), user: "owner".into(), owner: owner.into(), origin: PASSKEY_ORIGIN.into(),
            base: "/a/synthetic".into(), read: Arc::new(read), approval: Arc::new(approval),
            apply: { let owner = owner.to_owned(); Arc::new(move |offer: &str, _key: &str, proof: &Value| apply(&owner, offer, proof)) },
        };
        (routes(road), storage, cookie)
    }

    async fn text(response: Response) -> String {
        String::from_utf8(axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap()
    }

    fn post_json(path: &str, cookie: &str, origin: &str, body: &Value) -> Request<Body> {
        Request::builder().method("POST").uri(path).header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie).header(header::ORIGIN, origin).body(Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn a_person_with_no_session_is_sent_to_sign_in_and_back() {
        let (door, _, _) = door("synthetic-approve-owner-default");
        let response = door.oneshot(Request::builder().uri(format!("/approve?offer={OFFER}")).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers().get(header::LOCATION).unwrap(), "/a/synthetic/sign-in");
        let cookie = response.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().to_owned();
        assert!(cookie.contains("Path=/"), "{cookie}");
    }

    #[tokio::test]
    async fn the_page_draws_the_offer_as_text_with_the_passkey_button() {
        let (door, _, cookie) = door("synthetic-approve-owner-default");
        let request = Request::builder().uri(format!("/approve?offer={OFFER}")).header(header::COOKIE, cookie).body(Body::empty()).unwrap();
        let response = door.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let csp = response.headers().get("content-security-policy").unwrap().to_str().unwrap().to_owned();
        assert!(csp.contains(&pages::script_source(SCRIPT)), "the page's script is allowed by its hash");
        let page = text(response).await;
        assert!(page.contains("data-approve"));
        assert!(page.contains(&format!("data-offer=\"{OFFER}\"")));
        assert!(page.contains("folder: /Synthetic/&lt;b&gt;"), "what the offer holds is text, never markup");
        assert!(page.contains("to &lt;i&gt;test&lt;/i&gt; the page"));
        assert!(page.contains("tool:synthetic") && page.contains("synthetic-capability"));
    }

    #[tokio::test]
    async fn an_offer_nobody_made_is_gone_and_gets_no_challenge() {
        let (door, _, cookie) = door("synthetic-approve-owner-default");
        let request = Request::builder().uri("/approve?offer=nope").header(header::COOKIE, &cookie).body(Body::empty()).unwrap();
        assert_eq!(door.clone().oneshot(request).await.unwrap().status(), StatusCode::NOT_FOUND);
        let asked = door.oneshot(post_json("/approve/challenge", &cookie, PASSKEY_ORIGIN, &json!({"offer": "nope"}))).await.unwrap();
        assert_eq!(asked.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_foreign_origin_or_no_session_reaches_nothing() {
        let (door, _, cookie) = door("synthetic-approve-owner-default");
        let foreign = door.clone().oneshot(post_json("/approve/challenge", &cookie, "https://evil.example", &json!({"offer": OFFER}))).await.unwrap();
        assert_eq!(foreign.status(), StatusCode::UNAUTHORIZED);
        let none = door.oneshot(post_json("/approve/apply", "__Host-trillion_session=none", PASSKEY_ORIGIN, &json!({"offer": OFFER}))).await.unwrap();
        assert_eq!(none.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_passkey_assertion_for_this_offer_applies_it_once_and_nothing_else_does() {
        let (door, _, cookie) = door(OWNER);
        let passkey = FixturePasskey::new(OWNER);
        let _registered = register_passkeys(OWNER, passkey.clone());
        let asked = door.clone().oneshot(post_json("/approve/challenge", &cookie, PASSKEY_ORIGIN, &json!({"offer": OFFER}))).await.unwrap();
        assert_eq!(asked.status(), StatusCode::OK);
        let asked: Value = serde_json::from_str(&text(asked).await).unwrap();
        let assertion = passkey.assert(asked["challenge"].as_str().unwrap());
        // A forged or unsigned answer applies nothing.
        let forged = door.clone().oneshot(post_json("/approve/apply", &cookie, PASSKEY_ORIGIN,
            &json!({"offer": OFFER, "nonce": asked["nonce"], "assertion": {"id": "x", "response": {}}}))).await.unwrap();
        assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
        let body = json!({"offer": OFFER, "nonce": asked["nonce"], "assertion": assertion});
        let done = door.clone().oneshot(post_json("/approve/apply", &cookie, PASSKEY_ORIGIN, &body)).await.unwrap();
        assert_eq!(done.status(), StatusCode::OK);
        assert_eq!(serde_json::from_str::<Value>(&text(done).await).unwrap(), json!({"granted": true}));
        let again = door.oneshot(post_json("/approve/apply", &cookie, PASSKEY_ORIGIN, &body)).await.unwrap();
        assert_eq!(again.status(), StatusCode::BAD_REQUEST, "a confirmation is used once");
    }

    #[tokio::test]
    async fn an_account_with_no_passkey_is_told_so() {
        let (door, _, cookie) = door("synthetic-approve-owner-default");
        let asked = door.oneshot(post_json("/approve/challenge", &cookie, PASSKEY_ORIGIN, &json!({"offer": OFFER}))).await.unwrap();
        assert_eq!(asked.status(), StatusCode::CONFLICT);
    }
}
