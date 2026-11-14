//! The ways' pages as they are served: every passkey button that signs in has the code way directly under it, every
//! word and field has its DATA, and each way signs in, refuses, retries and is managed through the door's own routes.

use super::*;
use crate::account::sign_in::routes::{routes, Supplies};
use crate::account::sign_in::sessions::{self, Session};
use crate::account::sign_in::store::{Family, Row, Store};
use crate::account::sign_in::tokens::{blake3_hex, random_hex};
use crate::account::sign_in::ways::{Deliver, KEY_FIELD, SECRET_FIELD};
use crate::account::sign_in::{keys, now_ms, pages};
use axum::body::Body;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use axum::http::{header, Request, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Map, Value};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
use tower::ServiceExt;

const ORIGIN: &str = "https://door.test";
const OWNER: &str = "555-0100abcdef555-0100abcdef555-0100abcdef555-0100abcdef";

/// The words every test account has (`words_row::for_tests`).
fn words() -> &'static Words {
    static WORDS: std::sync::OnceLock<Words> = std::sync::OnceLock::new();
    WORDS.get_or_init(crate::account::sign_in::words_row::for_tests)
}

fn w() -> &'static WayWords {
    &words().ways
}

fn label(name: &str) -> String {
    w().fields.get(name).cloned().unwrap_or_default()
}

/// The ways every test account has (`ways::for_tests`).
fn ways() -> &'static ways::WaySettings {
    static WAYS: std::sync::OnceLock<ways::WaySettings> = std::sync::OnceLock::new();
    WAYS.get_or_init(ways::for_tests)
}

// ---- every passkey button has a code way ----

/// Each passkey button on a page and what is drawn directly under it.
fn passkey_buttons(html: &str) -> Vec<(String, String)> {
    html.match_indices(" data-passkey").map(|(at, _)| {
        let start = html[..at].rfind("<button").expect("a button");
        let rest = &html[start..];
        let end = rest.find("</button>").expect("a closed button") + "</button>".len();
        // The action drawn directly after it, in the same row of actions.
        let under = rest[end..].split("</a>").next().unwrap_or_default().to_string();
        (rest[..end].to_string(), under)
    }).collect()
}

/// Whether a page offers `way`: a link to its page, or a form that posts to it.
fn offers(html: &str, way: &str) -> bool {
    html.contains(&format!("way={way}&amp;")) || html.contains(&format!("way={way}\""))
        || html.contains(&format!("name=\"way\" value=\"{way}\""))
}

/// What a page shows once, item by item (`shown_once`).
fn shown_items(html: &str) -> Vec<String> {
    const OPEN: &str = " class=\"page-item-heading\">";
    html.match_indices(OPEN).map(|(at, _)| html[at + OPEN.len()..].split('<').next().unwrap().to_string()).collect()
}

fn code_way_href(under: &str) -> Option<String> {
    let start = under.find("<a class=\"page-action page-action--link\" href=\"")? + "<a class=\"page-action page-action--link\" href=\"".len();
    Some(under[start..].split('"').next()?.replace("&amp;", "&"))
}

#[test]
fn every_passkey_button_that_signs_in_has_the_code_way_directly_under_it() {
    let pages: [(&str, String); 3] = [
        ("sign-in", pages::sign_in(words(), "/", "", false, Some(ways()))),
        ("sign-in, connecting", pages::sign_in(words(), "/authorize/continue?request=req-1", "", true, Some(ways()))),
        ("sign-in at a computer", pages::sign_in(words(), "/a/abc/", "/a/abc", false, Some(ways()))),
    ];
    for (name, html) in &pages {
        let buttons = passkey_buttons(html);
        assert_eq!(buttons.len(), 1, "{name}: one passkey button");
        for (button, under) in buttons {
            let href = code_way_href(&under).unwrap_or_else(|| panic!("{name}: \"{button}\" has no code way directly under it"));
            assert!(href.contains(&format!("/sign-in/way?way={}", ways().code_way)), "{name}: {href}");
            assert!(under.contains(&pages::escape(&w().rows[&ways().code_way].send_button)), "{name}: the code way says its words");
        }
        // A link to the code way's page, with or without a `next` after it (none for the bare home address).
        let code_way = format!("/sign-in/way?way={}", ways().code_way);
        assert_eq!(html.matches(&code_way).count(), 1, "{name}: one code way per page");
    }
    // A passkey link and adding a passkey while signed in draw no code way: the old add-passkey page drew none.
    for html in [pages::add_passkey(words(), Some("abc-_123"), "", Some(ways())), pages::add_passkey(words(), None, "", Some(ways()))] {
        assert_eq!(passkey_buttons(&html).len(), 1);
        assert!(!html.contains(&format!("/sign-in/way?way={}", ways().code_way)));
    }
}

#[test]
fn the_code_way_carries_where_the_passkey_would_have_gone() {
    let html = pages::sign_in(words(), "/authorize/continue?request=req-1", "/a/abc", true, Some(ways()));
    let (_, under) = passkey_buttons(&html).remove(0);
    assert_eq!(code_way_href(&under).unwrap(), "/a/abc/sign-in/way?way=email-code", "the return path is held in a cookie, not the link");
    assert!(html.contains("way=personal-key"), "a waiting connection offers the key way");
    assert!(!pages::sign_in(words(), "/", "", false, Some(ways())).contains("way=personal-key"), "no connection waits: no key way");
}

// ---- DATA ----

#[test]
fn every_way_word_and_field_has_its_data() {
    for row in &ways().rows {
        let own = row_words(words(), &row.way);
        for text in [&own.label, &own.about, &own.sign_in_title, &own.sign_in_button, &own.add_title, &own.add_button, &own.change_title,
            &own.change_button, &own.remove_button, &own.added, &own.changed, &own.removed, &own.wrong] {
            assert!(!text.is_empty(), "{}", row.way);
        }
        assert!(!label(row.proof.field()).is_empty(), "{}", row.way);
    }
    for field in [CODE_FIELD, CURRENT_SECRET_FIELD, KEY_NAME_FIELD, NEW_SECRET_FIELD, SECRET_FIELD, KEY_FIELD] {
        assert!(!label(field).is_empty(), "{field}");
    }
    for kind in ways().names.keys() {
        assert!(!label(kind).is_empty() && w().names_refused.contains_key(kind), "{kind}");
    }
}

#[test]
fn a_way_page_escapes_what_it_draws_again_and_never_draws_a_secret() {
    let kept: ways::Typed = [("sign_in_email".to_string(), "\"><script>x</script>".to_string()), (SECRET_FIELD.to_string(), "hunter22".to_string())]
        .into_iter().collect();
    let form = Form { words: words(), ways: ways(), base: "", next: "/x\"y", request: None, kept: &kept, message: Some("<b>".into()), focus: None };
    let html = sign_in(ways().row("password").unwrap(), None, &form);
    assert!(!html.contains("<script>x") && html.contains("&lt;script&gt;x"));
    assert!(!html.contains("hunter22"), "a typed secret is never drawn again");
    assert!(html.contains("&lt;b&gt;") && !html.contains("/x&quot;y"), "the return path is never drawn into the form");
    assert!(html.contains("name=\"sign_in_email\" autocomplete=\"email\"") && !html.contains("autofocus"));
}

// ---- through the routes ----

#[derive(Default)]
struct Outbox {
    sent: Mutex<Vec<Value>>,
    attempts: Mutex<Vec<Value>>,
    unknown: AtomicBool,
}

impl Deliver for Outbox {
    fn run(&self, _request_key: &str, _tool: &str, input: &Value) -> std::result::Result<Value, ways::DeliverFailure> {
        self.attempts.lock().unwrap().push(input.clone());
        if self.unknown.load(Ordering::Acquire) {
            return Ok(json!({"sent": 0, "unknown": true}));
        }
        self.sent.lock().unwrap().push(input.clone());
        Ok(json!({"sent": [{"recipient": input["to"], "messageId": "message-1"}]}))
    }
}

impl Outbox {
    fn last_code(&self) -> String {
        let sent = self.sent.lock().unwrap();
        sent.last().expect("a message")["subject"].as_str().unwrap().chars().filter(char::is_ascii_digit).collect()
    }
}

struct Door {
    route_table: Router,
    storage: Arc<dyn crate::storage::Storage + Send + Sync>,
    outbox: Arc<Outbox>,
}

fn door() -> Door {
    door_delivering(&["email", "text"])
}

/// A door whose account has picked a tool to send codes on `channels` only.
fn door_delivering(channels: &[&str]) -> Door {
    let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
        Arc::new(crate::account::sign_in::Locked::new(crate::account::sign_in::lists::test_memory()));
    let outbox = Arc::new(Outbox::default());
    let route_table = routes(Supplies { storage: storage.clone(), account: "owner".into(), address: OWNER.into(), origin: ORIGIN.into(),
        base: String::new(), sender: Some(outbox.clone()) });
    ways::set(&Store::new(&*storage), "owner", 0, ways::for_tests()).expect("the test ways are kept");
    for channel in channels {
        ways::set_delivery(&Store::new(&*storage), ways(), "owner", channel, Some("tool:send"), Map::new()).unwrap();
    }
    Door { route_table, storage, outbox }
}

impl Door {
    async fn send(&self, request: Request<Body>) -> Response {
        self.route_table.clone().oneshot(request).await.expect("the route table answers")
    }
    fn store(&self) -> Store<'_> {
        Store::new(&*self.storage)
    }
    /// A session cookie of the account, started `age_ms` ago by `method`.
    fn session(&self, method: &str, age_ms: u64) -> String {
        let secret = random_hex(32);
        let at = now_ms() - age_ms;
        let row = Row { id: blake3_hex(&secret), account: "owner".into(), expires_at: now_ms() + 3_600_000,
            value: Session { method: method.into(), created_at: at, renewed_at: now_ms() } };
        self.store().put(Family::Sessions, &row).unwrap();
        format!("{}={secret}", crate::account::sign_in::contract().session_cookie)
    }
}

fn post(path: &str, cookie: Option<&str>, origin: Option<&str>, fields: &[(&str, &str)]) -> Request<Body> {
    let body: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
    let mut request = Request::builder().method("POST").uri(path).header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    if let Some(origin) = origin {
        request = request.header(header::ORIGIN, origin);
    }
    request.body(Body::from(body)).unwrap()
}

fn get(path: &str, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().uri(path);
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::empty()).unwrap()
}

async fn text(response: Response) -> String {
    String::from_utf8(axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
}

fn location(response: &Response) -> String {
    response.headers().get(header::LOCATION).expect("a location").to_str().unwrap().to_string()
}

fn signs_in(response: &Response) -> bool {
    response.headers().get(header::SET_COOKIE).and_then(|value| value.to_str().ok())
        .is_some_and(|cookie| cookie.starts_with(&format!("{}=", crate::account::sign_in::contract().session_cookie)))
}

#[tokio::test]
async fn an_emailed_code_signs_in_through_the_routes_after_a_wrong_one() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let added = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "add"), ("sign_in_email", "person@example.test")])).await;
    assert_eq!(added.status(), StatusCode::OK);
    assert!(text(added).await.contains("name=\"step\" value=\"confirm\""), "the add asks for the code it sent");
    let confirm = door.outbox.last_code();
    let confirmed = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "confirm"), ("code", &confirm)])).await;
    assert!(text(confirmed).await.contains("Added. You can now sign in with a code sent to person@example.test."));

    let page = door.send(get("/sign-in/way?way=email-code&next=%2Fhome", None)).await;
    assert_eq!(page.status(), StatusCode::OK);
    assert!(text(page).await.contains("action=\"/sign-in/way/send\""));
    let foreign = door.send(post("/sign-in/way/send", None, Some("https://evil.example"), &[("way", "email-code"), ("sign_in_email", "person@example.test")])).await;
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    let sent = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("next", "/home")])).await;
    assert_eq!(sent.status(), StatusCode::OK);
    let html = text(sent).await;
    assert!(html.contains("name=\"code\"") && html.contains("autofocus"), "the code is asked next");
    let code = door.outbox.last_code();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let refused = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("code", wrong), ("next", "/home")])).await;
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    assert!(!signs_in(&refused));
    assert!(text(refused).await.contains("name=\"code\""), "a wrong code asks for it again");
    let right = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("code", &code), ("next", "/home")])).await;
    // The code way is how a browser with no passkey gets in: it is signed in and offered a passkey for next time,
    // or goes on to where it was going.
    assert_eq!(right.status(), StatusCode::OK);
    assert!(signs_in(&right));
    let offer = text(right).await;
    assert!(offer.contains(&words().offer_passkey_title), "{offer}");
    assert!(offer.contains("data-purpose=\"register\"") && offer.contains("data-next=\"/home\"") && offer.contains("href=\"/home\""));
    assert!(!offers(&offer, &ways().code_way), "a signed-in step offers no other way under its button");
}

#[tokio::test]
async fn the_add_email_page_adds_an_email_that_then_signs_in() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let page = door.send(get("/sign-in/add-email", Some(&fresh))).await;
    assert_eq!(page.status(), StatusCode::OK);
    let drawn = text(page).await;
    assert!(drawn.contains("Add your email") && drawn.contains("Email me a code"), "{drawn}");
    let sent = door.send(post("/sign-in/add-email", Some(&fresh), Some(ORIGIN), &[("step", "add"), ("sign_in_email", "person@example.test")])).await;
    assert_eq!(sent.status(), StatusCode::OK);
    assert!(text(sent).await.contains("name=\"step\" value=\"confirm\""), "the add asks for the code it sent");
    let confirm = door.outbox.last_code();
    let added = door.send(post("/sign-in/add-email", Some(&fresh), Some(ORIGIN), &[("step", "confirm"), ("code", &confirm)])).await;
    assert_eq!(added.status(), StatusCode::OK);
    assert!(text(added).await.contains("Added. You can now sign in with a code sent to person@example.test."));
    let sent = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("next", "/home")])).await;
    assert_eq!(sent.status(), StatusCode::OK);
    let code = door.outbox.last_code();
    let right = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("code", &code), ("next", "/home")])).await;
    assert!(signs_in(&right));
}

#[tokio::test]
async fn ways_are_managed_only_by_a_recent_session_and_a_password_then_signs_in() {
    let door = door();
    let none = door.send(get("/sign-in/security", None)).await;
    assert_eq!(none.status(), StatusCode::SEE_OTHER);
    assert_eq!(location(&none), "/sign-in");

    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    assert_eq!(door.send(get("/sign-in/security", Some(&stale))).await.status(), StatusCode::OK, "reading the page needs only a session");
    let refused = door.send(post("/sign-in/security/way", Some(&stale), Some(ORIGIN), &[("way", "password"), ("step", "add"), ("sign_in_email", "person@example.test"),
        ("new_password", "correct horse battery")])).await;
    assert_eq!(refused.status(), StatusCode::SEE_OTHER, "an old session signs in again first");
    assert_eq!(location(&refused), "/sign-in", "the address carries no return path");
    let held = refused.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().trim_start_matches("trillion_next=");
    assert_eq!(String::from_utf8(URL_SAFE_NO_PAD.decode(held).unwrap()).unwrap(), "/sign-in/security/way?way=password");

    let fresh = door.session("passkey", 0);
    let foreign = door.send(post("/sign-in/security/way", Some(&fresh), Some("https://evil.example"), &[("way", "password"), ("step", "add")])).await;
    assert_eq!(foreign.status(), StatusCode::FORBIDDEN);
    let saved = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "password"), ("step", "add"), ("sign_in_email", "person@example.test"),
        ("new_password", "correct horse battery")])).await;
    assert_eq!(saved.status(), StatusCode::OK);
    let html = text(saved).await;
    assert!(html.contains("Your password is saved.") && html.contains("On: person@example.test"));

    let wrong = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "password"), ("sign_in_email", "person@example.test"), ("password", "nope"), ("next", "/")])).await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert!(text(wrong).await.contains("Forgot password"), "a refusal points at the way to recover");
    let right = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "password"), ("sign_in_email", "person@example.test"), ("password", "correct horse battery"), ("next", "/")])).await;
    assert_eq!(right.status(), StatusCode::SEE_OTHER);
    assert!(signs_in(&right));

    let last = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "password"), ("step", "remove")])).await;
    assert_eq!(last.status(), StatusCode::BAD_REQUEST);
    assert!(text(last).await.contains(&w().last_way_in));
}

#[tokio::test]
async fn backup_codes_are_shown_once_and_a_sign_in_says_how_many_are_left() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let made = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "backup-codes"), ("step", "add")])).await;
    let html = text(made).await;
    let codes = shown_items(&html);
    assert_eq!(codes.len(), ways().listed.count);
    let signed = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "backup-codes"), ("code", &codes[0]), ("next", "/")])).await;
    assert_eq!(signed.status(), StatusCode::OK);
    assert!(signs_in(&signed));
    assert!(text(signed).await.contains(&format!("You have {} backup codes left.", codes.len() - 1)));
    let again = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "backup-codes"), ("code", &codes[0]), ("next", "/")])).await;
    assert_eq!(again.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_authenticator_app_is_set_up_and_signs_in_through_the_routes() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let setup = text(door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "authenticator"), ("step", "add")])).await).await;
    let address = setup.split("href=\"otpauth://").nth(1).expect("the address an app opens").split('"').next().unwrap().replace("&amp;", "&");
    let secret = address.split("secret=").nth(1).unwrap().split('&').next().unwrap().to_string();
    // The QR picture an app scans is that same address, drawn in the page as an SVG element (no XML declaration).
    let expected = qrcode::QrCode::new(format!("otpauth://{address}").as_bytes()).unwrap()
        .render::<qrcode::render::svg::Color<'_>>().min_dimensions(200, 200)
        .dark_color(qrcode::render::svg::Color("#000")).light_color(qrcode::render::svg::Color("#fff")).build();
    let drawn = setup.split("<div class=\"page-image\" role=\"img\"").nth(1).expect("a QR picture").split("</div>").next().unwrap();
    assert!(drawn.contains(&format!("aria-label=\"{}\"", w().timed_picture)) && !setup.contains("<?xml"));
    assert!(drawn.contains(&expected[expected.find("<svg").unwrap()..]), "the picture encodes exactly the address");
    let step = now_ms() / 1000 / ways().timed.seconds;
    let wrong = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "authenticator"), ("step", "confirm"),
        ("code", &ways::timed_code(&secret, step + 9, ways().timed.digits))])).await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    assert!(text(wrong).await.contains(&secret[..4]), "a wrong first code shows the same setup again");
    let on = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "authenticator"), ("step", "confirm"),
        ("code", &ways::timed_code(&secret, step, ways().timed.digits))])).await;
    assert!(text(on).await.contains("Your authenticator app is on."));
    let signed = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "authenticator"), ("code", &ways::timed_code(&secret, step + 1, ways().timed.digits)), ("next", "/")])).await;
    assert_eq!(signed.status(), StatusCode::SEE_OTHER);
    assert!(signs_in(&signed));
}

#[tokio::test]
async fn a_text_code_with_the_password_signs_in_and_its_session_cannot_change_ways() {
    let door = door();
    let fresh = door.session("passkey", 0);
    door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "password"), ("step", "add"), ("sign_in_email", "person@example.test"),
        ("new_password", "correct horse battery")])).await;
    door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "text-code"), ("step", "add"), ("sign_in_phone", "+555-01007")])).await;
    let code = door.outbox.last_code();
    door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "text-code"), ("step", "confirm"), ("code", &code)])).await;
    door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "text-code"), ("sign_in_phone", "+555-01007")])).await;
    let code = door.outbox.last_code();
    let signed = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "text-code"), ("sign_in_phone", "+555-01007"), ("code", &code),
        ("password", "correct horse battery"), ("next", "/")])).await;
    assert_eq!(signed.status(), StatusCode::SEE_OTHER);
    let cookie = signed.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
    let change = door.send(get("/sign-in/security/way?way=password", Some(&cookie))).await;
    assert_eq!(change.status(), StatusCode::SEE_OTHER, "a text-code session signs in another way before changing ways");
}

#[tokio::test]
async fn uncertain_sign_in_delivery_keeps_the_code_entry_and_does_not_claim_sent_or_not_sent() {
    let door = door();
    let fresh = door.session("passkey", 0);
    door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "add"), ("sign_in_email", "person@example.test")])).await;
    let code = door.outbox.last_code();
    door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "confirm"), ("code", &code)])).await;

    door.outbox.unknown.store(true, Ordering::Release);
    let fields = [("way", "email-code"), ("sign_in_email", "person@example.test")];
    let first = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &fields)).await;
    assert_eq!(first.status(), StatusCode::SERVICE_UNAVAILABLE);
    let first = text(first).await;
    assert!(first.contains("name=\"code\""), "the possibly delivered code remains enterable");
    assert!(first.contains(&w().delivery_unknown.as_deref().unwrap()), "the page explains uncertainty");
    assert!(!first.contains(&w().code_sent) && !first.contains(&w().not_sent), "neither certainty claim is drawn");
    let attempts = door.outbox.attempts.lock().unwrap().len();

    let mut old_words = crate::account::sign_in::words_row::read(&door.store(), "owner").unwrap().unwrap();
    old_words.value.words.ways.delivery_unknown = None;
    crate::account::sign_in::words_row::set(&door.store(), "owner", old_words.value.revision,
        old_words.value.words, Some(ways())).unwrap();
    let second = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &fields)).await;
    assert_eq!(second.status(), StatusCode::SERVICE_UNAVAILABLE);
    let second = text(second).await;
    assert!(second.contains("name=\"code\""), "old words rows keep the same usable form");
    assert!(second.contains(&words().unavailable), "old words use the generic unavailable words");
    assert!(!second.contains(&w().code_sent) && !second.contains(&w().not_sent));
    assert_eq!(door.outbox.attempts.lock().unwrap().len(), attempts, "a repeat request reuses the waiting code without another run");
}

#[tokio::test]
async fn uncertain_add_delivery_keeps_the_confirmation_code_entry_without_claiming_it_is_on_the_way() {
    let door = door();
    let fresh = door.session("passkey", 0);
    door.outbox.unknown.store(true, Ordering::Release);
    let response = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "add"), ("sign_in_email", "person@example.test")])).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let html = text(response).await;
    assert!(html.contains("name=\"code\""), "the potentially delivered add code remains enterable");
    assert!(html.contains(&w().delivery_unknown.as_deref().unwrap()));
    assert!(!html.contains(&w().confirm_sent) && !html.contains(&w().not_sent));
}

#[tokio::test]
async fn a_personal_key_approves_a_waiting_app_and_a_passkey_link_is_made_for_another_device() {
    let door = door();
    let registered = door.send(Request::builder().method("POST").uri("/oauth/register").header("content-type", "application/json")
        .body(Body::from(r#"{"redirect_uris":["https://app.example/callback"],"client_name":"Test AI"}"#)).unwrap()).await;
    let client: Value = serde_json::from_str(&text(registered).await).unwrap();
    let client_id = client["client_id"].as_str().unwrap();
    let authorize = format!("/authorize?response_type=code&client_id={client_id}&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback\
        &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz");
    let to_sign_in = door.send(get(&authorize, None)).await;
    let held = to_sign_in.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().trim_start_matches("trillion_next=").to_string();
    let next = String::from_utf8(URL_SAFE_NO_PAD.decode(held).unwrap()).unwrap();
    assert!(next.starts_with("/authorize/continue?request="));
    let (key, _) = keys::issue(&door.store(), "owner", OWNER, "script", &["records".to_string()], 0).unwrap();

    let no_request = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "personal-key"), ("key", &key), ("next", "/")])).await;
    assert_eq!(no_request.status(), StatusCode::BAD_REQUEST);
    assert!(text(no_request).await.contains(&w().no_request));
    let wrong = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "personal-key"), ("key", "nm_nope"), ("next", &next)])).await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let approved = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "personal-key"), ("key", &key), ("next", &next)])).await;
    assert_eq!(approved.status(), StatusCode::SEE_OTHER);
    assert!(!signs_in(&approved), "a key approves the app, it starts no browser session");
    let back = location(&approved);
    assert!(back.starts_with("https://app.example/callback?code=") && back.contains("state=xyz"));
    let grants = crate::account::sign_in::oauth::grants(&door.store(), "owner").unwrap();
    assert_eq!(grants[0].value.scopes, vec!["records".to_string()], "within the key's own scopes");

    let fresh = door.session("passkey", 0);
    let link = door.send(post("/sign-in/passkey-link", Some(&fresh), Some(ORIGIN), &[])).await;
    assert_eq!(link.status(), StatusCode::OK);
    assert!(text(link).await.contains("https://door.test/sign-in/add-passkey?link="));
    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    assert_eq!(door.send(post("/sign-in/passkey-link", Some(&stale), Some(ORIGIN), &[])).await.status(), StatusCode::SEE_OTHER);
}

#[tokio::test]
async fn the_security_page_withdraws_every_waiting_link_and_code_for_a_recent_session_only() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let page = |cookie: &str| get("/sign-in/security", Some(cookie));
    assert!(!text(door.send(page(&fresh)).await).await.contains(&w().withdraw_button), "nothing waits: no withdraw button");

    let made = text(door.send(post("/sign-in/passkey-link", Some(&fresh), Some(ORIGIN), &[])).await).await;
    let code = made.split("link=").nth(1).unwrap().split(['"', '<']).next().unwrap().to_string();
    let shown = text(door.send(page(&fresh)).await).await;
    assert!(shown.contains(&w().withdraw_button) && shown.contains("action=\"/sign-in/withdraw\""));

    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    assert_eq!(door.send(post("/sign-in/withdraw", Some(&stale), Some(ORIGIN), &[])).await.status(), StatusCode::SEE_OTHER,
        "an old session signs in again first");
    assert_eq!(door.send(post("/sign-in/withdraw", Some(&fresh), Some("https://evil.example"), &[])).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(crate::account::sign_in::routes::waiting(&door.store(), "owner").unwrap().len(), 1, "a refused withdrawal withdraws nothing");

    let withdrawn = door.send(post("/sign-in/withdraw", Some(&fresh), Some(ORIGIN), &[])).await;
    assert_eq!(withdrawn.status(), StatusCode::OK);
    assert!(text(withdrawn).await.contains(&said(&w().withdrawn, &[("count", "1")])));
    let options = Request::builder().method("POST").uri("/passkey/options").header("content-type", "application/json")
        .header("origin", ORIGIN).body(Body::from(json!({"purpose": "register", "code": code}).to_string())).unwrap();
    assert_eq!(door.send(options).await.status(), StatusCode::UNAUTHORIZED, "the withdrawn link is refused at once");
}

#[tokio::test]
async fn an_account_without_its_ways_row_offers_passkeys_only_and_says_the_ways_are_unavailable() {
    let storage: Arc<dyn crate::storage::Storage + Send + Sync> =
        Arc::new(crate::account::sign_in::Locked::new(crate::account::sign_in::lists::test_memory()));
    let route_table = routes(Supplies { storage: storage.clone(), account: "person".into(), address: OWNER.into(), origin: ORIGIN.into(),
        base: String::new(), sender: None });
    let door = Door { route_table, storage, outbox: Arc::new(Outbox::default()) };
    let page = door.send(get("/sign-in?next=%2F", None)).await;
    assert_eq!(page.status(), StatusCode::OK);
    let html = text(page).await;
    assert_eq!(passkey_buttons(&html).len(), 1, "the passkey still signs in");
    assert!(!html.contains("/sign-in/way"), "no way is offered that is not there");
    assert_eq!(door.send(get("/sign-in/way?way=email-code", None)).await.status(), StatusCode::SERVICE_UNAVAILABLE);
    let tried = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "password"), ("sign_in_email", "person@example.test"), ("password", "x"), ("next", "/")])).await;
    assert_eq!(tried.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(!signs_in(&tried));

    // Once the account's ways row is written, the same pages offer them: here, with no sender, those that need no code.
    ways::set(&door.store(), "person", 0, ways::for_tests()).unwrap();
    let html = text(door.send(get("/sign-in?next=%2F", None)).await).await;
    assert!(offers(&html, "password") && !offers(&html, &ways::for_tests().code_way), "{html}");
    assert_eq!(door.send(get("/sign-in/way?way=password", None)).await.status(), StatusCode::OK);
    assert_eq!(door.send(get("/sign-in/way?way=pigeon", None)).await.status(), StatusCode::BAD_REQUEST, "not one of its ways");
}

#[test]
fn a_session_started_by_a_way_names_it() {
    let storage = crate::account::sign_in::lists::test_memory();
    let store = Store::new(&storage);
    let cookie = sessions::start(&store, "owner", "email-code").unwrap();
    let pair = cookie.split(';').next().unwrap();
    assert_eq!(sessions::current_row(&store, Some(pair)).unwrap().unwrap().value.method, "email-code");
}

#[tokio::test]
async fn a_way_whose_codes_nothing_sends_is_never_offered() {
    let sms = ways().rows.iter().find(|row| row.channel.as_deref() == Some("text")).expect("a texted way").way.clone();
    let email = ways().code_way.clone();

    // Email is sent, texts are not: the code way is under the passkey button, the texted way is nowhere.
    let door = door_delivering(&["email"]);
    let shown = text(door.send(get("/sign-in", None)).await).await;
    assert!(code_way_href(&shown).is_some_and(|href| href.contains(&format!("way={email}"))));
    assert!(!shown.contains(&format!("way={sms}")), "no link to a way nothing sends");
    assert_eq!(door.send(get(&format!("/sign-in/way?way={sms}"), None)).await.status(), StatusCode::BAD_REQUEST);
    let send = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", &sms), ("sign_in_phone", "+555-01000")])).await;
    assert_eq!(send.status(), StatusCode::BAD_REQUEST);
    assert!(door.outbox.sent.lock().unwrap().is_empty(), "nothing is sent");
    let fresh = door.session("passkey", 0);
    let security = text(door.send(get("/sign-in/security", Some(&fresh))).await).await;
    assert!(!security.contains(&format!("way={sms}")), "and it cannot be added");

    // Nothing is sent at all: no code way under the button, and the ways that need no code are still offered.
    let door = door_delivering(&[]);
    let shown = text(door.send(get("/sign-in", None)).await).await;
    assert!(!offers(&shown, &email), "no code way under the button");
    assert!(offers(&shown, "password"));
    assert_eq!(passkey_buttons(&shown).len(), 1, "the passkey button stays");
}

// ---- a way trillion-local has never seen ----

/// The trillion-local source of the sign-in (not its tests): what an unforeseen way must not need a change to.
const ENGINE_SOURCES: [(&str, &str); 9] = [
    ("sign_in.rs", include_str!("../sign_in.rs")),
    ("ways.rs", include_str!("ways.rs")),
    ("way_pages.rs", include_str!("way_pages.rs")),
    ("pages.rs", include_str!("pages.rs")),
    ("routes.rs", include_str!("routes.rs")),
    ("known.rs", include_str!("known.rs")),
    ("words_row.rs", include_str!("words_row.rs")),
    ("sessions.rs", include_str!("sessions.rs")),
    ("account_routes.rs", include_str!("../account_routes.rs")),
];

/// A way no sign-in source file names, on a channel and with a kind of name no sign-in source file names: its whole being is the
/// account's rows (its ways row entry, its kind of name, and its words), so it is added, sent a code and signs in with
/// no change to trillion-local.
#[tokio::test]
async fn an_unforeseen_way_on_an_unforeseen_channel_works_from_the_accounts_rows_alone() {
    const WAY: &str = "pager-code";
    const CHANNEL: &str = "pager";
    const KIND: &str = "pager_number";
    for (file, source) in ENGINE_SOURCES {
        for name in [WAY, CHANNEL, KIND] {
            assert!(!source.contains(name), "{file} names {name}: the way would not be unforeseen");
        }
    }
    let door = door();
    let store = door.store();
    let mut settings = ways::for_tests();
    settings.names.insert(KIND.into(), ways::NameShape {
        field: "sign_in_pager_number".into(), input: "text".into(), autocomplete: "off".into(), placeholder: String::new(), inputmode: String::new(),
        required: false, strip: "[\\s-]".into(), lower: false, pattern: "^[0-9]{4,12}$".into(), max_length: 20,
    });
    let mut row = settings.row("email-code").expect("a sent way to model on").clone();
    row.way = WAY.into();
    row.channel = Some(CHANNEL.into());
    row.named = Some(KIND.into());
    settings.rows.push(row);
    assert!(settings.valid(), "the ways row with the new way holds together");

    // The words come first: a ways row naming a way the words do not cover is never drawn.
    let mut words = crate::account::sign_in::words_row::for_tests();
    assert!(!words.covers(&settings));
    let mut own = words.ways.rows["email-code"].clone();
    own.label = "Pager code".into();
    own.sign_in_title = "Sign in with a code on your pager".into();
    own.added = "Added. Codes now go to pager {name}.".into();
    words.ways.rows.insert(WAY.into(), own);
    words.ways.fields.insert(KIND.into(), "Pager number".into());
    words.ways.names_refused.insert(KIND.into(), "A pager number is 4 to 12 digits.".into());
    assert!(words.covers(&settings));
    crate::account::sign_in::words_row::set(&store, "owner", 1, words, Some(&ways::for_tests())).expect("the words are kept");
    ways::set(&store, "owner", 1, settings.clone()).expect("the ways are kept");
    ways::set_delivery(&store, &settings, "owner", CHANNEL, Some("tool:send-a-page"), Map::new()).expect("the channel has a tool");

    // Offered on the sign-in page, added from a recent session, confirmed by the code it sent.
    let page = text(door.send(get("/sign-in", None)).await).await;
    assert!(page.contains("Sign in with a code on your pager") && page.contains("way=pager-code"), "{page}");
    let fresh = door.session("passkey", 0);
    let refused = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", WAY), ("step", "add"), ("sign_in_pager_number", "not digits")])).await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert!(text(refused).await.contains("A pager number is 4 to 12 digits."));
    let added = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", WAY), ("step", "add"), ("sign_in_pager_number", "555-0100")])).await;
    assert_eq!(added.status(), StatusCode::OK);
    assert!(text(added).await.contains("name=\"step\" value=\"confirm\""));
    let sent = door.outbox.sent.lock().unwrap().last().cloned().unwrap();
    assert_eq!((sent["to"].as_str(), sent["kind"].as_str()), (Some("5550100"), Some("sign-in-code")), "kept in its one form, sent as a sign-in code");
    let confirm = door.outbox.last_code();
    let confirmed = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", WAY), ("step", "confirm"), ("code", &confirm)])).await;
    assert!(text(confirmed).await.contains("Added. Codes now go to pager 5550100."));

    // Signs in by the code sent to it.
    let asked = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", WAY), ("sign_in_pager_number", "5550100"), ("next", "/home")])).await;
    assert_eq!(asked.status(), StatusCode::OK);
    assert!(text(asked).await.contains("name=\"code\""), "the code is asked next");
    let code = door.outbox.last_code();
    let right = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", WAY), ("sign_in_pager_number", "5550100"), ("code", &code), ("next", "/home")])).await;
    assert_eq!(right.status(), StatusCode::SEE_OTHER, "not the code way: it goes on to where it was going");
    assert!(signs_in(&right));
    let session = door.store().list::<Session>(Family::Sessions, "owner", usize::MAX).unwrap();
    assert!(session.iter().any(|row| row.value.method == WAY), "the session names the way it started by");
}

/// An account whose words row is gone draws no page from words anywhere else: each page answers the code alone.
#[tokio::test]
async fn an_account_without_its_words_row_answers_the_code_alone() {
    let door = door();
    let id = format!("{}owner", crate::account::sign_in::words_row::ROW_PREFIX);
    door.store().remove(Family::Lists, &id).unwrap();
    for path in ["/sign-in", "/sign-in/way?way=password", "/sign-in/add-passkey?link=abc"] {
        let answer = door.send(get(path, None)).await;
        assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert_eq!(text(answer).await, crate::account::sign_in::words_row::MISSING, "{path}");
    }
}

// ---- Ported from old trillion tests deleted by Trillion-X/trillion #243 (tag old-trillion-before-worker-retire,
// b6ae0ebf81): test/add-passkey-name.test.mjs, test/pages-have-no-glow-panels.test.mjs, test/sign-in-next-action.test.mjs,
// test/returning-sign-in.test.mjs, test/authenticator.test.mjs and test/backup-codes.test.mjs (their route halves). The old
// src/pages.mjs pages and src/worker.mjs routes are this door's pages (pages.rs, way_pages.rs) and routes (routes.rs): the
// harness renders those pages and drives the route table; the old page actions (`href="#..."` anchors a client script
// ran) are this door's buttons and plain forms (way_pages.rs: "Plain HTML forms that post to this origin; no script").
// Old tests whose assertions this door answers differently are left out and named in the port report.

/// Ported from old test/add-passkey-name.test.mjs, "adding a passkey asks for its password-manager name on the same link
/// page". The old `name="passkey_name"` field is the page's `passkey-name` input (the script posts it), and the old
/// `#link-passkey` action is the link page's own register button carrying its link code.
#[test]
fn old_add_passkey_name_the_link_page_asks_for_the_passkeys_name() {
    let html = pages::add_passkey(words(), Some("link-code"), "", Some(ways()));
    assert!(html.contains("id=\"page-field-passkey-name\" name=\"passkey-name\""));
    assert!(html.contains("Name for this passkey"));
    assert!(html.contains("data-purpose=\"register\" data-code=\"link-code\""));
}

const GLOW: &str = "radial-gradient(";

/// Ported from old test/pages-have-no-glow-panels.test.mjs, "the shared page shell draws no glow for each layout". The
/// door has one shell (`shell.rs`, `pages::draw`), drawn here with the old test's title and section.
#[test]
fn old_no_glow_panels_the_shared_page_shell_draws_no_glow() {
    let section = crate::account::sign_in::shell::Section { heading: Some("Words".into()), body: Some("More words".into()), ..Default::default() };
    let html = pages::draw(&pages::auth_page("A page", vec![section]));
    assert!(!html.to_ascii_lowercase().contains(GLOW), "the shell draws a glowing gradient; use the shared flat look");
}

/// Ported from old test/pages-have-no-glow-panels.test.mjs, "each sign-in state draws no glow": sign-in, connecting an
/// AI app, returning (the same sign-in page), adding a passkey, and this door's other sign-in pages. The old "expired
/// connection" variant has no page of its own here (a sign-in with no waiting request answers a notice).
#[test]
fn old_no_glow_panels_each_sign_in_state_draws_no_glow() {
    let variants: [(&str, String); 8] = [
        ("sign-in", pages::sign_in(words(), "/", "", false, Some(ways()))),
        ("connecting an AI app", pages::connect(words(), "r1", "Claude", "")),
        ("connecting, signing in", pages::sign_in(words(), "/authorize/continue?request=r1", "", true, Some(ways()))),
        ("add a passkey", pages::add_passkey(words(), Some("abc"), "", Some(ways()))),
        ("offer a passkey", pages::offer_passkey(words(), "/", "")),
        ("sign up", pages::sign_up(words(), None)),
        ("sign up for a plan", pages::sign_up(words(), Some("/buy/offer%3Aplan"))),
        ("notice", pages::notice(words(), pages::Notice::Unavailable)),
    ];
    for (name, html) in variants {
        assert!(!html.to_ascii_lowercase().contains(GLOW), "{name} draws a glowing gradient; use the shared flat look");
    }
}

/// Ported from old test/sign-in-next-action.test.mjs, "the page points at the named action, else the pressed button, and a
/// stale sign-in goes to sign in again". The old client's pointAt is the page a refused step draws again with
/// `autofocus` on the field to fix, else the button that comes next (`focus_for`); a step that needs a recent sign-in
/// sends an old session to sign in again and back.
#[tokio::test]
async fn old_sign_in_next_action_the_page_points_at_what_comes_next_and_a_stale_sign_in_signs_in_again() {
    let email = ways().row("email-code").unwrap();
    assert_eq!(focus_for(&crate::cause!(ways::Refused::NotSent), email, false), "send", "a code that was not sent points at sending one");
    assert_eq!(focus_for(&crate::cause!(ways::Refused::Wrong), email, false), CODE_FIELD, "a wrong code points at the code");
    assert_eq!(focus_for(&crate::cause!(ways::Refused::Unknown), email, false), "go", "else the button that was pressed");
    let door = door();
    let refused = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "backup-codes"), ("code", "wrong-code-here"), ("next", "/")])).await;
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    let html = text(refused).await;
    assert!(html.contains("id=\"page-field-code\" name=\"code\"") && html.contains("autofocus"), "the refused page points at the code");
    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    let again = door.send(post("/sign-in/security/way", Some(&stale), Some(ORIGIN), &[("way", "backup-codes"), ("step", "add")])).await;
    assert_eq!(again.status(), StatusCode::SEE_OTHER);
    assert_eq!(location(&again), "/sign-in", "a stale sign-in goes to sign in again, then back");
}

/// Ported from old test/sign-in-next-action.test.mjs, "the pages carry the actions the errors name". The old
/// `/sign-in/email` (try another way) is the code way's page, `#code-send` its send button.
#[test]
fn old_sign_in_next_action_the_pages_carry_the_actions_the_errors_name() {
    let code_way = format!("/sign-in/way?way={}", ways().code_way);
    assert!(pages::sign_in(words(), "/", "", false, Some(ways())).contains(&code_way), "sign-in offers trying another way");
    let kept = ways::Typed::new();
    let form = |focus| Form { words: words(), ways: ways(), base: "", next: "/", request: None, kept: &kept, message: None, focus };
    let email = sign_in(ways().row("email-code").unwrap(), None, &form(None));
    assert!(email.contains("action=\"/sign-in/way/send\""), "the emailed-code page sends a code");
    let backup = sign_in(ways().row("backup-codes").unwrap(), None, &form(None));
    assert!(backup.contains("way=email-code"), "the backup code page leads to trying another way");
}

/// Ported from old test/returning-sign-in.test.mjs, "a session lasts 30 days from its last use and is renewed once a day
/// it is used". The 30 days are the account's settings row (`session_seconds`, src/account/sign_in/new-accounts.json); the
/// old cookie lifetime is the cookie's Max-Age.
#[tokio::test]
async fn old_returning_sign_in_a_session_lasts_30_days_from_its_last_use_renewed_once_a_day() {
    let door = door();
    let seconds = crate::account::sign_in::lists::current(&door.store(), "owner").unwrap().session_seconds;
    assert_eq!(seconds, 30 * 24 * 3600);
    let cookie = sessions::start(&door.store(), "owner", "passkey").unwrap();
    assert!(cookie.ends_with(&format!("Max-Age={seconds}")), "the cookie lasts as long as the stored session");
    let day = 24 * 3600 * 1000;
    for (renewed_ago, renews) in [(day + 60_000, true), (day - 60_000, false)] {
        let secret = random_hex(32);
        let id = blake3_hex(&secret);
        let before = now_ms() - renewed_ago;
        let row = Row { id: id.clone(), account: "owner".into(), expires_at: before + seconds * 1000,
            value: Session { method: "passkey".into(), created_at: before, renewed_at: before } };
        door.store().put(Family::Sessions, &row).unwrap();
        let header = format!("{}={secret}", crate::account::sign_in::contract().session_cookie);
        sessions::current(&door.store(), Some(&header)).unwrap().expect("a live session");
        let after: Row<Session> = door.store().get(Family::Sessions, &id).unwrap().unwrap();
        assert_eq!(after.value.renewed_at > before, renews, "renewed {renewed_ago} ms after its last renewal");
        if renews {
            assert!(after.expires_at >= now_ms() + seconds * 1000 - 60_000, "30 days from this use");
        }
    }
}

/// Ported from old test/authenticator.test.mjs, "setup, its QR and turning it on need a recent sign-in; deleting the
/// account removes it". Deleting the account's sign-in rows (Family::Ways among them) is covered by
/// src/account/erase_tests.rs a_deletion_runs_every_step_in_order_from_its_kept_cursors_and_erases_the_sign_in_rows_last.
#[tokio::test]
async fn old_authenticator_setup_and_turning_it_on_need_a_recent_sign_in_and_are_not_stored() {
    let door = door();
    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    let refused = door.send(post("/sign-in/security/way", Some(&stale), Some(ORIGIN), &[("way", "authenticator"), ("step", "add")])).await;
    assert_eq!(refused.status(), StatusCode::SEE_OTHER, "an old session signs in again first");
    let page = door.send(get("/sign-in/security/way?way=authenticator", Some(&stale))).await;
    assert_eq!(page.status(), StatusCode::SEE_OTHER, "the setup page too");
    let fresh = door.session("passkey", 0);
    let setup = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "authenticator"), ("step", "add")])).await;
    assert_eq!(setup.status(), StatusCode::OK);
    assert_eq!(setup.headers().get(header::CACHE_CONTROL).unwrap(), "no-store");
    let confirm = door.send(post("/sign-in/security/way", Some(&stale), Some(ORIGIN), &[("way", "authenticator"), ("step", "confirm"), ("code", "123456")])).await;
    assert_eq!(confirm.status(), StatusCode::SEE_OTHER, "turning it on needs a recent sign-in too");
}

/// Ported from old test/backup-codes.test.mjs, "making codes, adding a passkey or an email all ask for a recent sign-in; a
/// backup code signs in without an email". Deleting the account drops its codes: see the authenticator port above.
#[tokio::test]
async fn old_backup_codes_making_codes_a_passkey_or_an_email_ask_for_a_recent_sign_in() {
    let door = door();
    let stale = door.session("passkey", ways().fresh_seconds * 1000 + 1000);
    for fields in [&[("way", "backup-codes"), ("step", "add")][..], &[("way", "email-code"), ("step", "add"), ("sign_in_email", "person@example.test")][..]] {
        let refused = door.send(post("/sign-in/security/way", Some(&stale), Some(ORIGIN), fields)).await;
        assert_eq!(refused.status(), StatusCode::SEE_OTHER, "{fields:?}");
    }
    assert_eq!(door.send(post("/sign-in/passkey-link", Some(&stale), Some(ORIGIN), &[])).await.status(), StatusCode::SEE_OTHER, "a passkey");
    let fresh = door.session("passkey", 0);
    let made = text(door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "backup-codes"), ("step", "add")])).await).await;
    let code = shown_items(&made).remove(0);
    let signed = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "backup-codes"), ("code", &code), ("next", "/")])).await;
    assert!(signs_in(&signed), "a backup code signs in without an email");
}


#[tokio::test]
async fn the_reset_page_sets_a_new_password_by_a_code_and_signs_in() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let added = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "add"), ("sign_in_email", "person@example.test")])).await;
    assert_eq!(added.status(), StatusCode::OK);
    let confirm = door.outbox.last_code();
    let confirmed = door.send(post("/sign-in/security/way", Some(&fresh), Some(ORIGIN), &[("way", "email-code"), ("step", "confirm"), ("code", &confirm)])).await;
    assert!(text(confirmed).await.contains("Added. You can now sign in with a code sent to person@example.test."));

    let page = text(door.send(get("/sign-in/forgot-password?next=%2Fhome", None)).await).await;
    assert!(page.contains("Reset your password") && page.contains("Email me a code") && page.contains("Back to sign in"), "{page}");
    assert!(page.contains("action=\"/sign-in/way/send\"") && page.contains("name=\"reset\" value=\"1\""), "{page}");

    let sent = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "email-code"), ("reset", "1"), ("sign_in_email", "person@example.test"), ("next", "/home")])).await;
    assert_eq!(sent.status(), StatusCode::OK);
    let code_page = text(sent).await;
    assert!(code_page.contains("Set new password") && code_page.contains("name=\"new_password\"") && code_page.contains("name=\"sign_in_email\" value=\"person@example.test\""), "{code_page}");
    let code = door.outbox.last_code();

    let short = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "email-code"), ("reset", "1"), ("sign_in_email", "person@example.test"), ("code", &code), ("new_password", "short"), ("next", "/home")])).await;
    assert!(!signs_in(&short), "a password that cannot be used signs nobody in");
    assert!(text(short).await.contains("name=\"new_password\""), "the page asks again");
    let right = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "email-code"), ("reset", "1"), ("sign_in_email", "person@example.test"), ("code", &code), ("new_password", "a new long password"), ("next", "/home")])).await;
    assert!(signs_in(&right), "the code still works after a refused password");
    assert!(text(right).await.contains(&words().ways.reset.done));

    let by_password = door.send(post("/sign-in/way", None, Some(ORIGIN), &[("way", "password"), ("sign_in_email", "person@example.test"), ("password", "a new long password"), ("next", "/")])).await;
    assert!(signs_in(&by_password), "the new password signs in");
}

/// The names every form the engine draws posts, with the names the routes read: a form's box is read under its
/// way's name field (`names.<kind>.field`), its proof field, or one of the carried values below. Any other name is a
/// box the handler never reads.
#[tokio::test]
async fn every_posted_name_is_one_the_handler_reads() {
    let door = door();
    let fresh = door.session("passkey", 0);
    let ways = ways();
    let mut pages: Vec<(String, String)> = vec![
        ("/sign-in".into(), text(door.send(get("/sign-in", None)).await).await),
        ("/sign-in/forgot-password".into(), text(door.send(get("/sign-in/forgot-password", None)).await).await),
        ("/sign-in/add-passkey?link=abc-_123".into(), text(door.send(get("/sign-in/add-passkey?link=abc-_123", None)).await).await),
        ("/sign-in/add-email".into(), text(door.send(get("/sign-in/add-email", Some(&fresh))).await).await),
        ("/sign-in/security".into(), text(door.send(get("/sign-in/security", Some(&fresh))).await).await),
        ("/sign-up".into(), crate::account::sign_in::pages::sign_up(words(), None)),
    ];
    for row in &ways.rows {
        pages.push((format!("/sign-in/way?way={}", row.way), text(door.send(get(&format!("/sign-in/way?way={}", row.way), None)).await).await));
        pages.push((format!("/sign-in/security/way?way={}", row.way), text(door.send(get(&format!("/sign-in/security/way?way={}", row.way), Some(&fresh))).await).await));
    }
    let mut allowed: Vec<String> = vec!["way".into(), "next".into(), "request".into(), "reset".into(), "step".into(), "passkey".into(), "purpose".into(),
        "code".into(), "password".into(), "new_password".into(), "current_password".into(), "key_name".into(), "key".into(), "passkey-name".into(),
        "password_again".into()];
    for row in &ways.rows {
        allowed.push(row.proof.field().to_string());
        if let Some(kind) = row.named.as_deref() {
            allowed.push(ways::name_field_of(&ways, kind).unwrap_or_else(|| kind.to_string()));
        }
    }
    let sent = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "email-code"), ("sign_in_email", "person@example.test"), ("next", "/")])).await;
    pages.push(("/sign-in/way/send (code step)".into(), text(sent).await));
    let reset = door.send(post("/sign-in/way/send", None, Some(ORIGIN), &[("way", "email-code"), ("reset", "1"), ("sign_in_email", "person@example.test"), ("next", "/")])).await;
    pages.push(("/sign-in/way/send (reset step)".into(), text(reset).await));
    // The sign-up page reads its own boxes; every sign-in page reads the ways' names.
    let signup: Vec<String> = ["given_name", "family_name", "email", "password", "next"].iter().map(|name| name.to_string()).collect();
    let mut checked = 0;
    let mut refused = vec![];
    for (path, html) in &pages {
        let reads = if path.starts_with("/sign-up") { &signup } else { &allowed };
        for form in html.split("<form").skip(1) {
            let body = form.split("</form>").next().unwrap_or("");
            for name in body.split("name=\"").skip(1).filter_map(|rest| rest.split('"').next()) {
                checked += 1;
                if !reads.iter().any(|allowed| allowed == name) {
                    refused.push(format!("{path}: {name}"));
                }
            }
        }
    }
    assert!(checked > 40, "the sweep read the forms ({checked} names)");
    refused.sort();
    refused.dedup();
    assert!(refused.is_empty(), "posted names no handler reads:\n{}", refused.join("\n"));
}

#[test]
fn the_setup_picture_is_one_compact_path_so_the_setup_page_stays_under_the_page_limit() {
    let address = "otpauth://totp/app.gettrillion.ai:jibakhtar%40gmail.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=app.gettrillion.ai&algorithm=SHA1&digits=6&period=30";
    let picture = scan_picture(words(), address).expect("a QR code");
    assert!(picture.svg.starts_with("<svg") && picture.svg.matches("<path").count() == 1, "{}", picture.svg.len());
    assert!(picture.svg.len() < 12_000, "the picture is {} bytes", picture.svg.len());
}
