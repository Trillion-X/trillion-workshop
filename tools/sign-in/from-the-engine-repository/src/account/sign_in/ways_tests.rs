//! Every way's whole lifecycle against the engine: add, sign in (right, refused, retried), change, remove, and the
//! recovery each way offers, with a stand-in sender that records what it was asked to send.

use super::*;
use crate::account::sign_in::UserId;
use crate::storage::memory::Memory;
use std::sync::{mpsc, Mutex};

const ACCOUNT: &str = "acct";
const ADDRESS: &str = "abababababababababababababababababababababababababababababababab";

/// A sign-in store whose test account has its words row (a code is sent only in the account's own words).
fn fixture() -> Memory {
    let mem = Memory::open("sign_in").expect("the sign_in schema opens");
    crate::account::sign_in::words_row::set(&Store::new(&mem), ACCOUNT, 0, crate::account::sign_in::words_row::for_tests(), None)
        .expect("the test words are kept");
    mem
}

/// A sender that keeps every message it was asked to send, and answers as a sending tool does (or fails, or its own
/// limits hold the message with `holds`' words).
#[derive(Default)]
struct Outbox {
    sent: Mutex<Vec<(String, Value)>>,
    attempts: Mutex<Vec<(String, Value)>>,
    fails: bool,
    holds: Option<&'static str>,
    unknown: bool,
    answer: Option<Value>,
}

impl Deliver for Outbox {
    fn run(&self, request_key: &str, tool: &str, input: &Value) -> std::result::Result<Value, DeliverFailure> {
        self.attempts.lock().unwrap().push((request_key.to_string(), input.clone()));
        if let Some(answer) = &self.answer {
            return Ok(answer.clone());
        }
        if self.fails {
            return Err(crate::cause!(DeliverFailure::NotStarted));
        }
        if self.unknown {
            return Ok(json!({"sent": 0, "unknown": true}));
        }
        if let Some(says) = self.holds {
            return Ok(json!({"provider": "stand-in", "sent": [{"recipient": input["to"], "limited": true, "error": says}], "said": says}));
        }
        // As the tools' email senders do (send-messages messageOf): an email without a subject or words is refused.
        if tool == "tool:send-an-email" && ["subject", "text"].iter().any(|field| input[field].as_str().is_none_or(str::is_empty)) {
            return Err(crate::cause!(DeliverFailure::NotStarted));
        }
        self.sent.lock().unwrap().push((tool.to_string(), input.clone()));
        Ok(json!({"provider": "stand-in", "sent": [{"recipient": input["to"], "messageId": "message-1"}], "said": "sent"}))
    }
}

impl Outbox {
    fn count(&self) -> usize {
        self.sent.lock().unwrap().len()
    }
    /// The code in the last message, and who it went to.
    fn last_code(&self) -> (String, String) {
        let sent = self.sent.lock().unwrap();
        let (_, input) = sent.last().expect("a message was sent");
        let subject = input["subject"].as_str().unwrap();
        let code: String = subject.chars().filter(char::is_ascii_digit).collect();
        (code, input["to"].as_str().unwrap().to_string())
    }
}

struct DelayedDelivery {
    started: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<mpsc::Receiver<()>>,
}

impl Deliver for DelayedDelivery {
    fn run(&self, _request_key: &str, _tool: &str, _input: &Value) -> std::result::Result<Value, DeliverFailure> {
        self.started.lock().unwrap().take().unwrap().send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        Err(crate::cause!(DeliverFailure::NotStarted))
    }
}

/// The ways every test account has (`for_tests`).
fn ways() -> &'static WaySettings {
    static WAYS: std::sync::OnceLock<WaySettings> = std::sync::OnceLock::new();
    WAYS.get_or_init(for_tests)
}

fn way(name: &str) -> &'static WayRow {
    ways().row(name).expect("a way in the rows")
}

/// The test account adding a way from a session started by `method`.
fn who(method: &str) -> Adding<'_> {
    Adding { account: ACCOUNT, address: ADDRESS, method, issuer: "door.test" }
}

fn form(pairs: &[(&str, &str)]) -> Typed {
    pairs.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
}

fn deliver_email(store: &Store<'_>) {
    set_delivery(store, ways(), ACCOUNT, "email", Some("tool:send-an-email"), Map::new()).unwrap();
}

fn deliver_text(store: &Store<'_>) {
    set_delivery(store, ways(), ACCOUNT, "text", Some("tool:send-a-text"), Map::new()).unwrap();
}

fn add_password(store: &Store<'_>, email: &str, secret: &str) {
    let added = add(store, ways(), &who("passkey"), way("password"), &form(&[("sign_in_email", email), (NEW_SECRET_FIELD, secret)]), None);
    assert_eq!(added, Ok(Added::Held(Some(email.to_lowercase()))));
}

fn add_email(store: &Store<'_>, outbox: &Outbox, email: &str) {
    let sent = add(store, ways(), &who("passkey"), way("email-code"), &form(&[("sign_in_email", email)]), Some(outbox)).unwrap();
    assert_eq!(sent, Added::CodeSent { name: email.to_lowercase() });
    let (code, _) = outbox.last_code();
    assert_eq!(confirm(store, ways(), ACCOUNT, way("email-code"), &form(&[(CODE_FIELD, &code)])), Ok(Some(email.to_lowercase())));
}

fn session(way_name: &str) -> Opened {
    Opened::Session { way: way_name.to_string(), left: None }
}

// ---- the account's ways row ----

#[test]
fn the_test_ways_hold_together_and_every_way_has_its_words() {
    assert!(ways().valid());
    for row in &ways().rows {
        assert!(!super::super::way_pages::row_words(&crate::account::sign_in::words_row::for_tests(), &row.way).label.is_empty(), "{}", row.way);
        if let Some(kind) = &row.named {
            assert!(crate::account::sign_in::words_row::for_tests().ways.names_refused.contains_key(kind), "{} is named by {kind}", row.way);
        }
    }
}

#[test]
fn ways_that_do_not_hold_together_are_refused() {
    let broken = |change: &dyn Fn(&mut WaySettings)| {
        let mut ways = for_tests();
        change(&mut ways);
        !ways.valid()
    };
    assert!(broken(&|ways| ways.code_way = "password".into()), "the code way is a sent way");
    assert!(broken(&|ways| ways.rows[0].recover_with.push("pigeon".into())), "every way a row names is a row");
    assert!(broken(&|ways| ways.rows[1].channel = None), "a sent way has a channel");
    assert!(broken(&|ways| ways.rows[0].named = Some("fax".into())), "every kind of name is one of names");
    assert!(broken(&|ways| ways.rows[0].way = "no-words".into()), "every way has its words");
    assert!(broken(&|ways| { let copy = ways.rows[0].clone(); ways.rows.push(copy) }), "a way is named once");
    assert!(broken(&|ways| ways.names.get_mut("email").unwrap().pattern = "(".into()), "a pattern reads");
    assert!(broken(&|ways| ways.code.digits = 3));
    assert!(broken(&|ways| ways.fresh_seconds = 0));
    assert!(broken(&|ways| ways.chosen.min_length = 0));
    assert!(broken(&|ways| ways.chosen.kdf = json!({"name": "md5"})), "a cost the verifier refuses");
    assert!(broken(&|ways| ways.listed.alphabet = "abc".into()));
}

#[test]
fn the_ways_row_is_the_accounts_own_and_changes_only_from_the_revision_read() {
    let mem = fixture();
    let store = Store::new(&mem);
    assert_eq!(current(&store, UserId(ACCOUNT)), Err(crate::cause!(Refused::Missing)), "no row: no way besides passkeys, never a default");
    assert_eq!(set(&store, ACCOUNT, 1, for_tests()), Err(crate::cause!(RowRefused::Stale)), "there is no revision 1 yet");
    let first = set(&store, ACCOUNT, 0, for_tests()).unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(set(&store, ACCOUNT, 0, for_tests()), Err(crate::cause!(RowRefused::Stale)), "a second editor that read nothing");
    let mut fewer = for_tests();
    fewer.code.tries = 3;
    assert_eq!(set(&store, ACCOUNT, 1, fewer.clone()).unwrap().revision, 2);
    assert_eq!(current(&store, UserId(ACCOUNT)), Ok(fewer));
    let mut broken = for_tests();
    broken.code_way = "password".into();
    assert_eq!(set(&store, ACCOUNT, 2, broken), Err(crate::cause!(RowRefused::Invalid)));
    assert_eq!(read(&store, ACCOUNT).unwrap().unwrap().value.revision, 2, "a refused change keeps the row");
    assert_eq!(current(&store, UserId("someone-else")), Err(crate::cause!(Refused::Missing)), "another account's row is its own");
    let stored = store.get::<Value>(Family::Lists, &format!("{ROW_PREFIX}{ACCOUNT}")).unwrap().unwrap();
    assert_eq!(stored.value["ways"]["code_way"], "email-code", "kept as a row of the account's lists");
}

// ---- names, counting ----

#[test]
fn names_are_kept_in_one_form_and_others_are_refused() {
    assert_eq!(normal_name(ways(), "email", "  person@example.test "), Some("person@example.test".to_string()));
    assert_eq!(normal_name(ways(), "email", "not an email"), None);
    assert_eq!(normal_name(ways(), "email", "a@b"), None);
    assert_eq!(normal_name(ways(), "phone", "+1 555-0100"), Some("+555-01007".to_string()));
    assert_eq!(normal_name(ways(), "phone", "555-0100"), None);
    assert_eq!(normal_name(ways(), "unknown", "x"), None);
}

#[test]
fn tries_past_the_limit_are_refused_and_counted_per_way() {
    let mem = fixture();
    let store = Store::new(&mem);
    let now = now_ms();
    for _ in 0..3 {
        count(&store, ways(), ACCOUNT, "w", "try", 3, now).unwrap();
    }
    assert_eq!(count(&store, ways(), ACCOUNT, "w", "try", 3, now), Err(Refused::TooMany(ways().window_seconds.div_ceil(60), crate::cause!())));
    count(&store, ways(), ACCOUNT, "other", "try", 3, now).unwrap();
    let later = now + ways().window_seconds * 1000;
    count(&store, ways(), ACCOUNT, "w", "try", 3, later).expect("the window moved on");
}

// ---- password ----

#[test]
fn password_signs_in_only_with_its_email_and_secret_and_is_kept_as_a_key() {
    let mem = fixture();
    let store = Store::new(&mem);
    add_password(&store, "person@example.test", "correct horse battery");
    let held = held_way(&store, ACCOUNT, "password").unwrap().unwrap();
    assert!(!serde_json::to_string(&held.value).unwrap().contains("correct horse"), "the secret is never kept as typed");

    let right = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &right), Ok(session("password")));
    let wrong_secret = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "wrong horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &wrong_secret), Err(crate::cause!(Refused::Wrong)));
    let wrong_email = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &wrong_email), Err(crate::cause!(Refused::Wrong)), "a wrong email reads the same");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &right), Ok(session("password")), "a retry after a refusal signs in");
    let not_email = form(&[("sign_in_email", "nope"), (SECRET_FIELD, "x")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &not_email), Err(crate::cause!(Refused::NotAName)));
}

#[test]
fn password_tries_are_limited() {
    let mem = fixture();
    let store = Store::new(&mem);
    add_password(&store, "person@example.test", "correct horse battery");
    let wrong = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "wrong")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &wrong), Err(crate::cause!(Refused::Wrong)));
    // The other wrong tries of the window, counted as each try counts itself (a memory-hard check each is slow here).
    for _ in 1..way("password").tries {
        count(&store, ways(), ACCOUNT, "password", "try", way("password").tries, now_ms()).unwrap();
    }
    let right = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert!(matches!(sign_in(&store, ways(), ACCOUNT, way("password"), &right), Err(Refused::TooMany(_, _))), "refused before the secret is checked");
}

#[test]
fn password_change_needs_the_current_one_unless_recovering_by_an_emailed_code() {
    let mem = fixture();
    let store = Store::new(&mem);
    add_password(&store, "person@example.test", "correct horse battery");
    assert_eq!(add(&store, ways(), &who("passkey"), way("password"), &form(&[("sign_in_email", "person@example.test"), (NEW_SECRET_FIELD, "short")]), None),
        Err(crate::cause!(Refused::TooShort)));
    let change = |current: &str, method: &str| add(&store, ways(), &who(method), way("password"),
        &form(&[("sign_in_email", "person@example.test"), (CURRENT_SECRET_FIELD, current), (NEW_SECRET_FIELD, "a new long secret")]), None);
    assert_eq!(change("wrong", "passkey"), Err(crate::cause!(Refused::CurrentWrong)));
    assert_eq!(change("correct horse battery", "passkey"), Ok(Added::Held(Some("person@example.test".into()))));
    let old = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &old), Err(crate::cause!(Refused::Wrong)), "the old secret stops");
    // Forgot password: a session started by an emailed code sets it anew without the current one.
    assert_eq!(change("", "email-code"), Ok(Added::Held(Some("person@example.test".into()))));
}

#[test]
fn the_last_way_in_is_never_removed() {
    let mem = fixture();
    let store = Store::new(&mem);
    add_password(&store, "person@example.test", "correct horse battery");
    assert_eq!(remove(&store, ways(), ACCOUNT, way("password"), None, 0), Err(crate::cause!(Refused::LastWayIn)));
    assert_eq!(remove(&store, ways(), ACCOUNT, way("password"), None, 1), Ok(true), "a passkey keeps the account reachable");
    assert_eq!(remove(&store, ways(), ACCOUNT, way("password"), None, 0), Ok(false), "nothing is left to remove");
    let right = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &right), Err(crate::cause!(Refused::Wrong)), "a removed way no longer signs in");
}

// ---- emailed code ----

#[test]
fn an_email_is_a_way_in_only_once_its_inbox_answered_a_code() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    assert_eq!(add(&store, ways(), &who("passkey"), way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)),
        Err(crate::cause!(Refused::NotSent)), "no tool picked for the channel: nothing is sent and the page says so");
    deliver_email(&store);
    add(&store, ways(), &who("passkey"), way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    let (code, to) = outbox.last_code();
    assert_eq!(to, "person@example.test");
    let input = outbox.sent.lock().unwrap()[0].1.clone();
    assert_eq!(input["kind"], "sign-in-code", "a sign-in code says what it is, so the tool counts it under its own limits");
    let mut names: Vec<&str> = input.as_object().unwrap().keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(names, ["idempotencyKey", "kind", "subject", "text", "to"], "no `from`, nothing the email rows do not list");
    for field in ["subject", "text"] {
        assert!(outbox.sent.lock().unwrap()[0].1[field].as_str().unwrap().contains(&code), "the {field} carries the code");
    }
    assert!(held_way(&store, ACCOUNT, "email-code").unwrap().is_none(), "not a way in before its code");
    let wrong = if code == "000000" { "111111" } else { "000000" };
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("email-code"), &form(&[(CODE_FIELD, wrong)])), Err(crate::cause!(Refused::Wrong)));
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("email-code"), &form(&[(CODE_FIELD, &code)])), Ok(Some("person@example.test".into())), "a retry with the right code");
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("email-code"), &form(&[(CODE_FIELD, &code)])), Err(crate::cause!(Refused::SetupEnded)), "it works once");
}

#[test]
fn an_emailed_code_signs_in_once_and_a_foreign_email_sends_nothing() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    let before = outbox.count();

    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)), Ok("person@example.test".into()),
        "the same answer for an email that is not this account's");
    assert_eq!(outbox.count(), before, "and nothing is sent to it");
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "not-an-email")]), Some(&outbox)), Err(crate::cause!(Refused::NotAName)));

    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    let (code, to) = outbox.last_code();
    assert_eq!(to, "person@example.test");
    let wrong = if code == "000000" { "111111" } else { "000000" };
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, wrong)])), Err(crate::cause!(Refused::Wrong)));
    let right = form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &right), Ok(session("email-code")), "a retry with the right code signs in");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &right), Err(crate::cause!(Refused::Wrong)), "a code works once");
}

#[test]
fn asking_again_soon_keeps_the_code_already_sent_and_a_code_dies_after_its_tries() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    let sent = outbox.count();
    let (code, _) = outbox.last_code();
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    assert_eq!(outbox.count(), sent, "a code still working, sent moments ago, is not replaced");
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..ways().code.tries {
        assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, wrong)])), Err(crate::cause!(Refused::Wrong)));
    }
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)])), Err(crate::cause!(Refused::Wrong)),
        "a code past its wrong tries is dead");
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    assert_eq!(outbox.count(), sent + 1, "a dead code is replaced by a new one at once");
    let (fresh, _) = outbox.last_code();
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &fresh)])), Ok(session("email-code")));
}

#[test]
fn a_send_that_fails_leaves_no_code_waiting_and_a_later_send_works() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    let broken = Outbox { fails: true, ..Outbox::default() };
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&broken)), Err(crate::cause!(Refused::NotSent)));
    let waiting = store.get::<Waiting>(Family::WayCodes, &waiting_id(ACCOUNT, "email-code", Purpose::SignIn)).unwrap().unwrap();
    assert_eq!(waiting.value.delivery, Some(DeliveryOutcome::NotStarted));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &outbox.last_code().0)])), Err(crate::cause!(Refused::Wrong)),
        "a code with a definite no-send result cannot authenticate");
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    let (code, _) = outbox.last_code();
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)])), Ok(session("email-code")));
}

#[test]
fn an_uncertain_attempt_keeps_its_key_and_code_until_expiry_even_after_the_resend_interval_or_try_limit() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox { unknown: true, ..Outbox::default() };
    deliver_email(&store);
    add_email(&store, &Outbox::default(), "person@example.test");
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)), Err(crate::cause!(Refused::DeliveryUnknown)));
    let id = waiting_id(ACCOUNT, "email-code", Purpose::SignIn);
    let first = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
    let attempt_key = first.value.attempt_request_key.clone().unwrap();
    assert_eq!(first.value.delivery, Some(DeliveryOutcome::Unknown));
    assert_eq!(outbox.attempts.lock().unwrap().len(), 1);

    let mut aged = first.clone();
    aged.value.made_at = 0;
    assert!(store.replace_if(Family::WayCodes, &first, &aged).unwrap());
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)), Err(crate::cause!(Refused::DeliveryUnknown)));
    let aged = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
    let mut exhausted = aged.clone();
    exhausted.value.tries = ways().code.tries;
    assert!(store.replace_if(Family::WayCodes, &aged, &exhausted).unwrap());
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)), Err(crate::cause!(Refused::DeliveryUnknown)),
        "unknown delivery does not mint a replacement before the normal expiry even after try exhaustion");
    assert_eq!(outbox.attempts.lock().unwrap().len(), 1, "repeats never run a second tool attempt");
    assert_eq!(store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap().value.attempt_request_key.as_deref(), Some(attempt_key.as_str()));

    let (_, input) = outbox.attempts.lock().unwrap()[0].clone();
    let code: String = input["subject"].as_str().unwrap().chars().filter(char::is_ascii_digit).collect();
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)])), Err(crate::cause!(Refused::Wrong)),
        "try exhaustion still prevents a code from signing in");

    // Expiry permits a fresh explicit request and a new identity. The old physical row is replaced by targeted CAS.
    let expired = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
    let mut row = expired.clone();
    row.expires_at = now_ms().saturating_sub(1);
    store.put(Family::WayCodes, &row).unwrap();
    let prune_limit = crate::account::sign_in::computer().expired_rows_per_write;
    for index in 0..=prune_limit {
        store.put(Family::WayCodes, &Row { id: format!("!expired-prune-{index:04}"), account: ACCOUNT.into(),
            expires_at: now_ms().saturating_sub(1), value: json!({}) }).unwrap();
    }
    let send_count_id = id_of(&[ACCOUNT, "email-code", "send"]);
    let counted = store.get::<Counted>(Family::Tries, &send_count_id).unwrap().unwrap();
    let mut window_ended = counted.clone();
    window_ended.value.at.clear();
    assert!(store.replace_if(Family::Tries, &counted, &window_ended).unwrap());
    let fresh = Outbox::default();
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&fresh)).unwrap();
    let current = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
    assert_ne!(current.value.attempt_request_key.as_deref(), Some(attempt_key.as_str()));
    assert_eq!(current.value.delivery, Some(DeliveryOutcome::Sent));
}

#[test]
fn legacy_waiting_rows_keep_their_old_json_shape_and_are_uncertain_until_expiry() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    let id = waiting_id(ACCOUNT, "email-code", Purpose::SignIn);
    let code = "123456";
    let raw = json!({"way":"email-code", "purpose":"sign-in", "name":"person@example.test", "code_hash":code_hash(&id, code),
        "secret":null, "tries":0, "made_at":now_ms()});
    let value: Waiting = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&value).unwrap(), raw, "new optional fields do not rewrite the old stored ABI");
    let legacy = Row { id: id.clone(), account: ACCOUNT.into(), expires_at: now_ms() + ways().code.seconds * 1000, value };
    store.put(Family::WayCodes, &legacy).unwrap();

    let previous_attempts = outbox.attempts.lock().unwrap().len();
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)), Err(crate::cause!(Refused::DeliveryUnknown)));
    assert_eq!(outbox.attempts.lock().unwrap().len(), previous_attempts, "legacy waiting rows are not resent while live");
    let mut changed = legacy.clone();
    changed.value.tries = 1;
    assert!(store.replace_if(Family::WayCodes, &legacy, &changed).unwrap(), "old raw JSON still matches a CAS read");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, code)])), Ok(session("email-code")),
        "a code that may have been delivered remains usable");
}

#[test]
fn a_late_no_send_result_after_cancel_cannot_remove_a_new_code() {
    let mem = crate::account::sign_in::Locked::new(fixture());
    let store = Store::new(&mem);
    let initial = Outbox::default();
    deliver_email(&store);
    add_email(&store, &initial, "person@example.test");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let delayed = DelayedDelivery { started: Mutex::new(Some(started_tx)), release: Mutex::new(release_rx) };
    let id = waiting_id(ACCOUNT, "email-code", Purpose::SignIn);

    std::thread::scope(|scope| {
        let pending = scope.spawn(|| {
            let pending_store = Store::new(&mem);
            send_code(&pending_store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&delayed))
        });
        started_rx.recv().unwrap();
        let first = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
        assert_eq!(first.value.delivery, Some(DeliveryOutcome::Pending));
        assert!(store.remove(Family::WayCodes, &id).unwrap(), "withdraw/cancel removes the exact pending attempt");

        let replacement_sender = Outbox::default();
        send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&replacement_sender)).unwrap();
        let replacement = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
        assert_eq!(replacement.value.delivery, Some(DeliveryOutcome::Sent));
        release_tx.send(()).unwrap();
        assert_eq!(pending.join().unwrap(), Err(crate::cause!(Refused::NotSent)));

        let after = store.stored::<Waiting>(Family::WayCodes, &id).unwrap().unwrap();
        assert_eq!(after, replacement, "the late result did not delete or alter the replacement row");
    });
}

#[test]
fn an_unknown_code_that_may_have_arrived_can_sign_in_once() {
    let mem = fixture();
    let store = Store::new(&mem);
    let setup = Outbox::default();
    let uncertain = Outbox { unknown: true, ..Outbox::default() };
    deliver_email(&store);
    add_email(&store, &setup, "person@example.test");
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&uncertain)), Err(crate::cause!(Refused::DeliveryUnknown)));
    let input = uncertain.attempts.lock().unwrap()[0].1.clone();
    let code: String = input["subject"].as_str().unwrap().chars().filter(char::is_ascii_digit).collect();
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)])), Ok(session("email-code")));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test"), (CODE_FIELD, &code)])), Err(crate::cause!(Refused::Wrong)));
}

#[test]
fn an_unknown_receipt_overrides_conflicting_success_and_only_explicit_no_effect_retries() {
    for answer in [
        json!({"sent": [{"messageId": "provider-id", "unknown": true}]}),
        json!({"sent": [{"messageId": "provider-id", "limited": true, "error": "refused", "unknown": false}]}),
    ] {
        let mem = fixture();
        let store = Store::new(&mem);
        let setup = Outbox::default();
        deliver_email(&store);
        add_email(&store, &setup, "person@example.test");
        let conflicted = Outbox { answer: Some(answer), ..Outbox::default() };
        assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&conflicted)), Err(crate::cause!(Refused::DeliveryUnknown)));
        assert_eq!(store.get::<Waiting>(Family::WayCodes, &waiting_id(ACCOUNT, "email-code", Purpose::SignIn)).unwrap().unwrap().value.delivery,
            Some(DeliveryOutcome::Unknown));
    }

    let mem = fixture();
    let store = Store::new(&mem);
    let setup = Outbox::default();
    deliver_email(&store);
    add_email(&store, &setup, "person@example.test");
    let refused = Outbox { answer: Some(json!({"sent": [{"error": "Twilio 400", "unknown": false}]})), ..Outbox::default() };
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&refused)), Err(crate::cause!(Refused::NotSent)));
    let row = store.get::<Waiting>(Family::WayCodes, &waiting_id(ACCOUNT, "email-code", Purpose::SignIn)).unwrap().unwrap();
    assert_eq!(row.value.delivery, Some(DeliveryOutcome::NotStarted));
}

#[test]
fn a_code_the_sending_tools_own_limits_hold_is_refused_in_its_words_and_leaves_no_code_waiting() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    let held = Outbox { holds: Some("Four codes went to this email in the last hour."), ..Outbox::default() };
    assert_eq!(send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&held)),
        Err(Refused::Limited("Four codes went to this email in the last hour.".into(), crate::cause!())));
    assert_eq!(store.get::<Waiting>(Family::WayCodes, &waiting_id(ACCOUNT, "email-code", Purpose::SignIn)).unwrap().unwrap().value.delivery,
        Some(DeliveryOutcome::NotStarted));
    assert_eq!(super::super::way_pages::refused_words(&crate::account::sign_in::words_row::for_tests(), ways(), &Refused::Limited("Four codes went to this email in the last hour.".into(), crate::cause!()), way("email-code")),
        "Four codes went to this email in the last hour.", "the page shows the tool's own words");
}

#[test]
fn sends_are_limited_per_window() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    let mut refused = None;
    for _ in 0..=way("email-code").sends {
        if let Err(error) = send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)) {
            refused = Some(error);
        }
    }
    assert!(matches!(refused, Some(Refused::TooMany(_, _))));
}

#[test]
fn changing_the_email_moves_codes_to_the_new_one_and_removing_it_stops_them() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_email(&store);
    add_email(&store, &outbox, "person@example.test");
    add_email(&store, &outbox, "person@example.test");
    let sent = outbox.count();
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    assert_eq!(outbox.count(), sent, "the old email no longer gets codes");
    add_password(&store, "person@example.test", "correct horse battery");
    assert_eq!(remove(&store, ways(), ACCOUNT, way("email-code"), None, 0), Ok(true));
    send_code(&store, ways(), ACCOUNT, way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    assert_eq!(outbox.count(), sent, "a removed email gets no codes");
}

// ---- text code ----

#[test]
fn a_text_code_needs_the_password_too_and_cannot_change_ways() {
    let mem = fixture();
    let store = Store::new(&mem);
    let outbox = Outbox::default();
    deliver_text(&store);
    assert_eq!(add(&store, ways(), &who("passkey"), way("text-code"), &form(&[("sign_in_phone", "+555-01007")]), Some(&outbox)),
        Err(Refused::NeedsFirst("password".into(), crate::cause!())));
    add_password(&store, "person@example.test", "correct horse battery");
    add(&store, ways(), &who("passkey"), way("text-code"), &form(&[("sign_in_phone", "+1 555-0100")]), Some(&outbox)).unwrap();
    let (code, to) = outbox.last_code();
    assert_eq!(to, "+555-01007");
    confirm(&store, ways(), ACCOUNT, way("text-code"), &form(&[(CODE_FIELD, &code)])).unwrap();

    send_code(&store, ways(), ACCOUNT, way("text-code"), &form(&[("sign_in_phone", "+555-01007")]), Some(&outbox)).unwrap();
    let (code, _) = outbox.last_code();
    let wrong_password = form(&[("sign_in_phone", "+555-01007"), (CODE_FIELD, &code), (SECRET_FIELD, "wrong")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("text-code"), &wrong_password), Err(crate::cause!(Refused::Wrong)));
    let right = form(&[("sign_in_phone", "+555-01007"), (CODE_FIELD, &code), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("text-code"), &right), Ok(session("text-code")), "a wrong password used nothing up");

    assert_eq!(may_change(ways(), "text-code", now_ms(), now_ms()), Err(crate::cause!(Refused::NotThisSession)));
    assert_eq!(remove(&store, ways(), ACCOUNT, way("password"), None, 1), Err(Refused::NeededBy("text-code".into(), crate::cause!())));
    assert_eq!(remove(&store, ways(), ACCOUNT, way("text-code"), None, 0), Ok(true), "the phone goes first");
    assert_eq!(remove(&store, ways(), ACCOUNT, way("password"), None, 1), Ok(true));
}

// ---- authenticator app ----

#[test]
fn timed_codes_follow_rfc_6238() {
    // RFC 6238 appendix B, SHA-1: T = 59 s is step 1, code 94287082 (the last six digits are what apps show).
    let secret = base32(b"555-0100555-0100");
    assert_eq!(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    assert_eq!(timed_code(&secret, 1, 6), "287082");
    assert_eq!(timed_code(&secret, 0x23523EC, 6), "081804");
    assert_eq!(from_base32(&in_groups(&secret)), b"555-0100555-0100", "the grouped key types back to the same secret");
}

#[test]
fn an_authenticator_app_is_on_only_after_its_first_code_and_each_code_signs_in_once() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Setup { key, address } = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap() else {
        panic!("a setup")
    };
    assert!(address.starts_with("otpauth://totp/door.test?secret=") && address.contains(&key));
    let again = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap();
    assert!(matches!(again, Added::Setup { key: ref same_key, .. } if *same_key == key), "an open setup keeps its secret");
    let step = now_ms() / 1000 / ways().timed.seconds;
    let code = timed_code(&key, step, ways().timed.digits);
    let wrong = timed_code(&key, step + 5, ways().timed.digits);
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &wrong)])), Err(crate::cause!(Refused::Wrong)));
    assert!(held_way(&store, ACCOUNT, "authenticator").unwrap().is_none());
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &code)])), Ok(None));
    // The step that turned it on is used: the next step's code signs in, the same one does not.
    let next = timed_code(&key, step + 1, ways().timed.digits);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &code)])), Err(crate::cause!(Refused::Wrong)));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &next)])), Ok(session("authenticator")));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &next)])), Err(crate::cause!(Refused::Wrong)), "each code once");
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &next)])), Err(crate::cause!(Refused::SetupEnded)));
}

// ---- backup codes ----

#[test]
fn backup_codes_each_sign_in_once_and_new_ones_end_the_old() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Codes(codes) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else {
        panic!("codes")
    };
    let shape = &ways().listed;
    assert_eq!(codes.len(), shape.count);
    assert!(codes.iter().all(|code| code.len() == shape.groups * shape.group_length + shape.groups - 1));
    let kept = serde_json::to_string(&held_way(&store, ACCOUNT, "backup-codes").unwrap().unwrap().value).unwrap();
    assert!(codes.iter().all(|code| !kept.contains(&code.replace('-', ""))), "only hashes are kept");

    let typed = codes[0].to_uppercase().replace('-', " ");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &typed)])),
        Ok(Opened::Session { way: "backup-codes".into(), left: Some(shape.count - 1) }));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &codes[0])])), Err(crate::cause!(Refused::Wrong)), "a used code");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, "abcd-efgh-jkmn")])), Err(crate::cause!(Refused::Wrong)));
    assert!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &codes[1])])).is_ok(), "a retry with another code");

    let Added::Codes(fresh) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &codes[2])])), Err(crate::cause!(Refused::Wrong)), "older codes end");
    assert!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &fresh[0])])).is_ok());
    assert_eq!(remove(&store, ways(), ACCOUNT, way("backup-codes"), None, 1), Ok(true));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &fresh[1])])), Err(crate::cause!(Refused::Wrong)));
}

// ---- personal key ----

#[test]
fn a_personal_key_approves_an_app_within_its_scopes_until_it_is_turned_off() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Key(key) = add(&store, ways(), &who("passkey"), way("personal-key"), &form(&[(KEY_NAME_FIELD, "laptop script")]), None).unwrap() else {
        panic!("a key")
    };
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("personal-key"), &form(&[(KEY_FIELD, &key)])), Ok(Opened::App { scopes: contract().scopes.clone() }));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("personal-key"), &form(&[(KEY_FIELD, "nm_nope")])), Err(crate::cause!(Refused::Wrong)));
    let (other, _) = keys::issue(&store, "someone-else", ADDRESS, "theirs", &contract().scopes, 0).unwrap();
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("personal-key"), &form(&[(KEY_FIELD, &other)])), Err(crate::cause!(Refused::Wrong)), "another account's key");
    assert_eq!(add(&store, ways(), &who("passkey"), way("personal-key"), &form(&[(KEY_NAME_FIELD, "")]), None), Err(crate::cause!(Refused::NotAName)));
    let id = keys::list(&store, ACCOUNT).unwrap()[0].id.clone();
    assert_eq!(remove(&store, ways(), ACCOUNT, way("personal-key"), Some(&id), 0), Ok(true));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("personal-key"), &form(&[(KEY_FIELD, &key)])), Err(crate::cause!(Refused::Wrong)), "a key turned off");
}

// ---- recent sign-in ----

#[test]
fn ways_change_only_from_a_recent_session_of_a_way_that_may_change_them() {
    let now = now_ms();
    assert_eq!(may_change(ways(), "passkey", now, now), Ok(()));
    assert_eq!(may_change(ways(), "email-code", now - 1000, now), Ok(()));
    assert_eq!(may_change(ways(), "passkey", now - ways().fresh_seconds * 1000 - 1, now), Err(crate::cause!(Refused::NotFresh)));
    assert_eq!(may_change(ways(), "personal-key", now, now), Err(crate::cause!(Refused::NotThisSession)));
}

#[test]
fn a_delivery_keeps_its_fixed_input_but_may_not_name_what_the_engine_sets() {
    let mem = fixture();
    let store = Store::new(&mem);
    for set in ["to", "kind", "subject", "text", "idempotencyKey"] {
        let mut input = Map::new();
        input.insert(set.into(), json!("x"));
        assert_eq!(set_delivery(&store, ways(), ACCOUNT, "email", Some("tool:send-an-email"), input), Err(crate::cause!(Refused::Unknown)), "{set}");
    }
    let mut input = Map::new();
    input.insert("look".into(), json!("plain"));
    set_delivery(&store, ways(), ACCOUNT, "email", Some("tool:send-an-email"), input).unwrap();
    let outbox = Outbox::default();
    add(&store, ways(), &who("passkey"), way("email-code"), &form(&[("sign_in_email", "person@example.test")]), Some(&outbox)).unwrap();
    let sent = outbox.sent.lock().unwrap()[0].1.clone();
    assert_eq!(sent["look"], "plain", "the picked tool's fixed input goes with it");
    assert_eq!(sent["kind"], "sign-in-code", "a confirm code is a sign-in code too");
}

// ---- Ported from old trillion test/authenticator.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The old src/totp.mjs and src/sign-in-methods.mjs authenticator are this module's timed way:
// the harness is the account's own sign-in store, not the old SQL tables, and the old per-user-id lookup is the account's
// own way. Its page and Account & security tests are not here (see way_pages_tests.rs and the port report).

/// Ported from old test/authenticator.test.mjs, "codes match the RFC 6238 test values, and the secret survives base32
/// both ways". The authenticator address names the account routes' host (`Adding::issuer`, "what an authenticator app
/// names the account by"), not an email, so the old `Trillion:a%40b.org` label is the issuer here.
#[test]
fn old_authenticator_codes_match_the_rfc_6238_values_and_the_secret_survives_base32() {
    let secret = base32(b"555-0100555-0100");
    for (seconds, code) in [(59u64, "94287082"), (1_111_111_109, "07081804"), (1_234_567_890, "89005924"), (2_000_000_000, "69279037")] {
        assert_eq!(timed_code(&secret, seconds / 30, 8), code, "T = {seconds}");
    }
    assert_eq!(from_base32(&secret), b"555-0100555-0100");
    let address = timed_address(ways(), "Trillion", &secret);
    let shape = Regex::new(r"^otpauth://totp/Trillion\?secret=[A-Z2-7]+&issuer=Trillion").unwrap();
    assert!(shape.is_match(&address), "{address}");
}

/// Ported from old test/authenticator.test.mjs, "a code counts for its step and one either side, never a used step,
/// never another length".
#[test]
fn old_authenticator_a_code_counts_for_its_step_and_one_either_side_never_a_used_step_never_another_length() {
    let secret = base32(&[7u8; 20]);
    let now = 1_800_000_000_000u64;
    let step = now / 30_000;
    let digits = ways().timed.digits;
    let code_at = |ms: u64| timed_code(&secret, ms / 1000 / ways().timed.seconds, digits);
    assert_eq!(timed_step(ways(), &secret, &code_at(now), now, None), Some(step));
    assert_eq!(timed_step(ways(), &secret, &code_at(now - 30_000), now, None), Some(step - 1));
    assert_eq!(timed_step(ways(), &secret, &code_at(now - 60_000), now, None), None);
    assert_eq!(timed_step(ways(), &secret, &code_at(now), now, Some(step)), None);
    assert_eq!(timed_step(ways(), &secret, "12345", now, None), None);
}

/// Ported from old test/authenticator.test.mjs, "setup keeps one waiting secret, turns on only with a right code, and the
/// setup code cannot sign in again". The old sign-in by a list of user ids is this account's own sign-in.
#[test]
fn old_authenticator_setup_keeps_one_secret_turns_on_only_with_a_right_code_and_its_code_cannot_sign_in_again() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Setup { key, .. } = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap() else { panic!("a setup") };
    let Added::Setup { key: again, .. } = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap() else { panic!() };
    assert_eq!(again, key, "the same setup while it waits");
    let digits = ways().timed.digits;
    let step = now_ms() / 1000 / ways().timed.seconds;
    let code = timed_code(&key, step, digits);
    let wrong = if code == "000000" { "111111" } else { "000000" };
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, wrong)])), Err(crate::cause!(Refused::Wrong)));
    assert!(held_way(&store, ACCOUNT, "authenticator").unwrap().is_none());
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &code)])), Ok(None));
    assert!(held_way(&store, ACCOUNT, "authenticator").unwrap().unwrap().value.added_at > 0);
    assert!(store.get::<Waiting>(Family::WayCodes, &waiting_id(ACCOUNT, "authenticator", Purpose::Add)).unwrap().is_none(), "no setup secret waits");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &code)])), Err(crate::cause!(Refused::Wrong)),
        "the step used to turn it on is spent");
    let later = timed_code(&key, step + 1, digits);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &later)])), Ok(session("authenticator")));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &later)])), Err(crate::cause!(Refused::Wrong)), "each step once");
    assert_eq!(remove(&store, ways(), ACCOUNT, way("authenticator"), None, 1), Ok(true));
    assert!(held_way(&store, ACCOUNT, "authenticator").unwrap().is_none());
}

/// Ported from old test/authenticator.test.mjs, "a setup ends after its minutes, and tries are limited per setup, per
/// email and per address". Tries are counted per account and way (ways.rs invariant 4), so the old per-email and
/// per-address limits are the account's authenticator sign-in limit here. A setup's end is its waiting row's
/// `expires_at` (`setup_seconds`), set to now as if its minutes had passed.
#[test]
fn old_authenticator_a_setup_ends_after_its_minutes_and_tries_are_limited() {
    let mem = fixture();
    let store = Store::new(&mem);
    let window_minutes = ways().window_seconds.div_ceil(60);
    add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap();
    let id = waiting_id(ACCOUNT, "authenticator", Purpose::Add);
    let mut waiting: Row<Waiting> = store.get(Family::WayCodes, &id).unwrap().unwrap();
    waiting.expires_at = now_ms();
    store.put(Family::WayCodes, &waiting).unwrap();
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, "123456")])), Err(crate::cause!(Refused::SetupEnded)));

    let Added::Setup { key, .. } = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap() else { panic!() };
    for _ in 0..way("authenticator").tries {
        assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, "x")])), Err(crate::cause!(Refused::Wrong)));
    }
    assert_eq!(confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, "x")])), Err(Refused::TooMany(window_minutes, crate::cause!())));

    // Signing in: the tries of the window, then even a right code waits.
    let other = fixture();
    let store = Store::new(&other);
    let Added::Setup { key: held, .. } = add(&store, ways(), &who("passkey"), way("authenticator"), &Typed::new(), None).unwrap() else { panic!() };
    let step = now_ms() / 1000 / ways().timed.seconds;
    confirm(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &timed_code(&held, step, ways().timed.digits))])).unwrap();
    for _ in 0..way("authenticator").tries {
        assert_eq!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, "1")])), Err(crate::cause!(Refused::Wrong)));
    }
    let right = timed_code(&held, step + 1, ways().timed.digits);
    assert!(matches!(sign_in(&store, ways(), ACCOUNT, way("authenticator"), &form(&[(CODE_FIELD, &right)])), Err(Refused::TooMany(_, _))));
    let _ = key;
}

// ---- Ported from old trillion test/backup-codes.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The old src/sign-in-methods.mjs backup codes are this module's listed way, over the account's
// own sign-in store. Tries are counted per account and way (invariant 4), not per network address. The page and Account &
// security tests are not here (see the port report).

/// Ported from old test/backup-codes.test.mjs, "ten codes in groups the person can read, all different, kept only as
/// hashes".
#[test]
fn old_backup_codes_ten_codes_in_readable_groups_all_different_kept_only_as_hashes() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Codes(codes) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!("codes") };
    let shape = &ways().listed;
    assert_eq!(codes.len(), shape.count);
    assert_eq!(codes.iter().collect::<std::collections::BTreeSet<_>>().len(), shape.count);
    let group = format!("[{}]{{{}}}", shape.alphabet, shape.group_length);
    let pattern = Regex::new(&format!("^{group}(-{group}){{{}}}$", shape.groups - 1)).unwrap();
    for code in &codes {
        assert!(pattern.is_match(code), "{code}");
    }
    let held = held_way(&store, ACCOUNT, "backup-codes").unwrap().unwrap();
    let kept = serde_json::to_string(&held.value).unwrap();
    for code in &codes {
        assert!(!kept.contains(&normal_listed(code)));
    }
    assert_eq!(described(&held.value)["left"], json!(shape.count));
}

/// Ported from old test/backup-codes.test.mjs, "a code signs its own account in once, typed any way, and the count drops".
#[test]
fn old_backup_codes_a_code_signs_its_own_account_in_once_typed_any_way() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Codes(codes) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    let other = Adding { account: "acct-2", address: ADDRESS, method: "passkey", issuer: "door.test" };
    let Added::Codes(theirs) = add(&store, ways(), &other, way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    let count = ways().listed.count;
    let typed = format!(" {} ", codes[0].to_uppercase().replace('-', " "));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &typed)])),
        Ok(Opened::Session { way: "backup-codes".into(), left: Some(count - 1) }));
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &codes[0])])), Err(crate::cause!(Refused::Wrong)), "used once");
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &theirs[0])])), Err(crate::cause!(Refused::Wrong)));
    assert_eq!(described(&held_way(&store, "acct-2", "backup-codes").unwrap().unwrap().value)["left"], json!(count),
        "another account keeps its codes");
}

/// Ported from old test/backup-codes.test.mjs, "new codes end the old ones; removing them ends them all".
#[test]
fn old_backup_codes_new_codes_end_the_old_ones_and_removing_them_ends_them_all() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Codes(old) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    let Added::Codes(fresh) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &old[0])])), Err(crate::cause!(Refused::Wrong)));
    assert!(matches!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &fresh[0])])), Ok(Opened::Session { .. })));
    assert_eq!(remove(&store, ways(), ACCOUNT, way("backup-codes"), None, 1), Ok(true));
    assert!(held_way(&store, ACCOUNT, "backup-codes").unwrap().is_none(), "no codes left");
}

/// Ported from old test/backup-codes.test.mjs, "one network address gets a limited number of tries within the window".
/// Tries are counted per account and way (ways.rs invariant 4): past them even a right code waits the window, and
/// another way (the old "another address") is not held up.
#[test]
fn old_backup_codes_tries_are_limited_within_the_window() {
    let mem = fixture();
    let store = Store::new(&mem);
    let Added::Codes(codes) = add(&store, ways(), &who("passkey"), way("backup-codes"), &Typed::new(), None).unwrap() else { panic!() };
    for _ in 0..way("backup-codes").tries {
        assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, "wrong-code-here")])), Err(crate::cause!(Refused::Wrong)));
    }
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("backup-codes"), &form(&[(CODE_FIELD, &codes[0])])),
        Err(Refused::TooMany(ways().window_seconds.div_ceil(60), crate::cause!())), "even a right code waits");
    add_password(&store, "person@example.test", "correct horse battery");
    let right = form(&[("sign_in_email", "person@example.test"), (SECRET_FIELD, "correct horse battery")]);
    assert_eq!(sign_in(&store, ways(), ACCOUNT, way("password"), &right), Ok(session("password")), "another way is not held up");
}

/// Ported from old test/backup-codes.test.mjs, "a way in is added only by a browser that signed in within the fresh
/// minutes".
#[test]
fn old_backup_codes_a_way_in_is_added_only_by_a_recent_sign_in() {
    let now = now_ms();
    assert_eq!(may_change(ways(), "passkey", now - 60_000, now), Ok(()));
    assert_eq!(may_change(ways(), "passkey", now - (ways().fresh_seconds + 60) * 1000, now), Err(crate::cause!(Refused::NotFresh)));
    assert_eq!(may_change(ways(), "passkey", 0, now), Err(crate::cause!(Refused::NotFresh)), "no sign-in time is never fresh");
}

/// A kept row or config written before names carried `field` still loads (hel1 crash-looped on it, 2026-11-11), and each box
/// is named the old page's way; a named field is kept as given.
#[test]
fn names_kept_before_field_existed_load_with_the_shipped_default_names() {
    let mut value = serde_json::to_value(ways()).expect("the ways serialize");
    for shape in value["names"].as_object_mut().expect("names").values_mut() {
        shape.as_object_mut().expect("a name shape").remove("field");
    }
    let read: WaySettings = serde_json::from_value(value.clone()).expect("ways without field still load");
    for kind in read.names.keys() {
        assert!(read.names[kind].field.is_empty(), "the stored shape is not rewritten to name its box");
        assert_eq!(name_field_of(&read, kind).as_deref(), Some(format!("sign_in_{kind}").as_str()));
    }
    value["names"]["email"]["field"] = json!("chosen_box");
    let read: WaySettings = serde_json::from_value(value).expect("ways with a named field load");
    assert_eq!(name_field_of(&read, "email").as_deref(), Some("chosen_box"));
}

/// A way row kept before `shape_version` and before a box named its `field` reads as shape 1, and the box is named from
/// the shipped default at use, so the row itself is never rewritten to add it.
#[test]
fn a_row_kept_before_the_field_reads_its_box_from_the_shipped_default() {
    let mut value = serde_json::to_value(ways()).expect("the ways serialize");
    value.as_object_mut().expect("an object").remove("shape_version");
    for shape in value["names"].as_object_mut().expect("names").values_mut() {
        shape.as_object_mut().expect("a names shape").remove("field");
    }
    let kept: WaySettings = serde_json::from_value(value).expect("a kept row reads");
    assert_eq!(kept.shape_version, 1);
    assert_eq!(name_field_of(&kept, "email").as_deref(), Some("sign_in_email"));
    assert_eq!(name_field_of(&kept, "phone").as_deref(), Some("sign_in_phone"));
    assert!(kept.names["email"].field.is_empty(), "the stored shape is not rewritten to name its box");
    assert_eq!(name_field_of(&kept, "unnamed-kind"), None);
}

/// Unknown fields in a stored row or config are ignored, so a row a later release wrote still reads here.
#[test]
fn a_row_with_fields_this_release_does_not_know_reads() {
    let mut value = serde_json::to_value(ways()).expect("the ways serialize");
    value.as_object_mut().expect("an object").insert("written_by_a_later_release".into(), json!({"any": [1, 2]}));
    value["code"].as_object_mut().expect("code").insert("sends_per_hour".into(), json!(9));
    let read: WaySettings = serde_json::from_value(value).expect("unknown fields are ignored");
    assert_eq!(read.code.digits, ways().code.digits);
    assert_eq!(read.shape_version, SHAPE_VERSION);
}

// ---- incident 1 (schema evolution): a row kept before the box name existed still reads ----

/// Incident 1: a ways row kept before `NameShape.field` existed still reads, and each box is named the old page's way at use.
fn schema_evolution_absent_field_decodes_body() -> std::result::Result<(), String> {
    let mut stored = serde_json::to_value(for_tests()).map_err(|error| error.to_string())?;
    for shape in stored["names"].as_object_mut().ok_or("names is not a map")?.values_mut() {
        shape.as_object_mut().ok_or("a name is not a map")?.remove("field");
    }
    let old: WaySettings = serde_json::from_value(stored).map_err(|error| format!("a row with no field does not read: {error}"))?;
    for kind in old.names.keys() {
        let named = name_field_of(&old, kind);
        if named.as_deref() != Some(format!("sign_in_{kind}").as_str()) {
            return Err(format!("{kind} is named {named:?}, not the old page's name"));
        }
    }
    Ok(())
}

#[test]
fn schema_evolution_absent_field_decodes() {
    crate::simulation::verdict("schema-evolution-absent-field-decodes", schema_evolution_absent_field_decodes_body);
}

#[test]
fn a_stored_text_way_with_the_earlier_recovery_reads_as_the_shipped_one_and_is_not_rewritten() {
    let mem = fixture();
    let store = Store::new(&mem);
    let text = |ways: &WaySettings| ways.rows.iter().find(|row| row.channel.as_deref() == Some("text")).unwrap().recover_with.clone();
    let mut earlier = ways().clone();
    earlier.rows.iter_mut().find(|row| row.channel.as_deref() == Some("text")).unwrap().recover_with = vec!["email-code".into(), "backup-codes".into()];
    set(&store, ACCOUNT, 0, earlier).unwrap();
    assert_eq!(text(&read(&store, ACCOUNT).unwrap().unwrap().value.ways), vec!["email-code".to_string()], "read as shipped");
    assert_eq!(text(&read_typed(&store, ACCOUNT).unwrap().unwrap().value.ways), vec!["email-code".to_string(), "backup-codes".to_string()], "the stored row is not rewritten on read");

    let mut own = ways().clone();
    own.rows.iter_mut().find(|row| row.channel.as_deref() == Some("text")).unwrap().recover_with = vec!["email-code".into(), "authenticator".into()];
    set(&store, "kept", 0, own).unwrap();
    assert_eq!(text(&read(&store, "kept").unwrap().unwrap().value.ways), vec!["email-code".to_string(), "authenticator".to_string()], "a recovery the person chose is kept");
}

#[test]
fn a_stored_text_way_without_the_recovery_labels_loads_them_empty() {
    let mut before = serde_json::to_value(crate::account::sign_in::words_row::for_tests()).unwrap();
    before["ways"]["rows"]["text-code"].as_object_mut().unwrap().remove("recover_labels");
    let words: crate::account::sign_in::pages::Words = serde_json::from_value(before).unwrap();
    assert!(words.ways.rows["text-code"].recover_labels.is_empty());
}

/// An account that opens without its ways row keeps none: its start writes its words, never its ways, so it has no way
/// besides its passkeys and each step refuses with `Refused::Missing` (lists.rs and ways.rs: never filled in).
#[test]
fn an_account_opened_without_its_ways_row_refuses_every_non_passkey_step() {
    let mem = fixture();
    let store = Store::new(&mem);
    crate::account::sign_in::StartingRows::for_tests().write_missing_on_open(&mem, ACCOUNT).unwrap();
    assert!(read(&store, ACCOUNT).unwrap().is_none(), "the start does not write the ways row");
    assert_eq!(current(&store, UserId(ACCOUNT)), Err(crate::cause!(Refused::Missing)));
    assert_eq!(set(&store, ACCOUNT, 0, for_tests()).map(|row| row.revision), Ok(1), "a first write is still the owner's, not the start's");
}
