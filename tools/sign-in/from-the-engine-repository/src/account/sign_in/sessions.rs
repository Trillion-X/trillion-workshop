//! Browser sessions. A session secret is `random_hex(32)`, sent only in the
//! cookie `contract().session_cookie` (HttpOnly; Secure; SameSite=Lax; Path=/;
//! Max-Age = the account's session_seconds, its settings row), stored by `blake3_hex(secret)`, sliding: a use
//! more than a day after the last renewal extends `expires_at`.
//!
//! The window of the hosting app (its own browser session) has a row here too:
//! its id is blake3_hex of the window's token, made at start (`start_window`),
//! and it follows the same expiry and sliding rule as a cookie session.
//!
//! The account's sessions are listed and another one ended (`listed`, `end_one`; old trillion src/passkey-list.mjs and
//! src/account-routes.mjs:151-171, :694-706). An app already signed in may ask for a one-use, short-lived link that
//! opens a signed-in web page (`web_link`, `open_web_link`; old src/web-sign-in.mjs).
//!
//! Stored values, owned by this file:
//! - sessions: `Session`, id = blake3_hex(secret)
//! - challenges: `WebLink`, id = blake3_hex(the link's code): a link's code is kept only as its hash

use super::store::{Family, Row, Store};
use super::tokens::{blake3_hex, random_hex};
use super::{now_ms, contract, Principal, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "route_hint.rs"]
pub(crate) mod route_hint;

/// A session is renewed when it was last renewed more than this long ago.
const RENEW_AFTER_MS: u64 = 86_400_000;
/// How a principal names the session it signs in as: `session:<session id>`.
pub(crate) const SESSION_SIGN_IN: &str = "session:";
/// The method of a session a web link started.
pub(crate) const WEB_LINK_METHOD: &str = "web-link";
/// The purpose of a web link's row in `Family::Challenges`.
const WEB_LINK_PURPOSE: &str = "web-link";
/// Most sessions one listing reads.
const MOST_LISTED: usize = 1000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Session {
    /// How it was started: "passkey", "window", or the way to sign in it started by (`ways.rs`).
    pub method: String,
    pub created_at: u64,
    pub renewed_at: u64,
}

/// Start a session for `account`. Answers the `Set-Cookie` header value.
pub(crate) fn start(store: &Store<'_>, account: &str, method: &str) -> Result<String> {
    let seconds = super::lists::current(store, account)?.session_seconds;
    let secret = random_hex(32);
    let now = now_ms();
    let row = Row {
        id: blake3_hex(&secret),
        account: account.to_string(),
        expires_at: expiry(now, seconds),
        value: Session { method: method.to_string(), created_at: now, renewed_at: now },
    };
    store.insert(Family::Sessions, &row)?;
    Ok(format!("{}={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}", contract().session_cookie, secret, seconds))
}

/// Make the window's own session row for `account` (`id` = blake3_hex of the
/// window's token). A row still live for that account is kept as it is.
pub(crate) fn start_window(store: &Store<'_>, account: &str, id: &str) -> Result<()> {
    if window_live(store, account, id)? {
        return Ok(());
    }
    let seconds = super::lists::current(store, account)?.session_seconds;
    let now = now_ms();
    let row = Row {
        id: id.to_string(),
        account: account.to_string(),
        expires_at: expiry(now, seconds),
        value: Session { method: "window".to_string(), created_at: now, renewed_at: now },
    };
    store.put(Family::Sessions, &row)
}

/// Whether the window's session row `id` is live for `account` now. A removed
/// or expired row is not live; a live one renews under the same rule as `current`.
pub(crate) fn window_live(store: &Store<'_>, account: &str, id: &str) -> Result<bool> {
    let Some(mut row) = store.get::<Session>(Family::Sessions, id)? else { return Ok(false) };
    if row.account != account {
        return Ok(false);
    }
    renew_if_due(store, &mut row, now_ms())?;
    Ok(true)
}

/// Read this window's one current session row without renewal. The row is one
/// storage read, so unrelated sign-in writes do not invalidate its liveness.
/// Physical custody and the selected account remain required; no absent or
/// expired row is created here.
pub(crate) fn window_live_read_only(store: &Store<'_>, account: &str, id: &str) -> Result<bool> {
    store.assert_custody()?;
    let row = store.get::<Session>(Family::Sessions, id)?;
    store.assert_custody()?;
    Ok(row.is_some_and(|row| row.account == account))
}

/// Slide a session that was last renewed more than a day before `now`, by its account's `session_seconds`. An account
/// with no settings row does not slide: the session keeps the expiry it has (nothing is made up for it).
fn renew_if_due(store: &Store<'_>, row: &mut Row<Session>, now: u64) -> Result<()> {
    if now.saturating_sub(row.value.renewed_at) > RENEW_AFTER_MS {
        let seconds = match super::lists::current(store, &row.account) {
            Ok(settings) => settings.session_seconds,
            Err(super::Error::SettingsMissing(_)) => return Ok(()),
            Err(other) => return Err(other),
        };
        row.value.renewed_at = now;
        row.expires_at = expiry(now, seconds);
        store.put(Family::Sessions, row)?;
    }
    Ok(())
}

/// The session named by a request's `Cookie` header, renewed if due.
pub(crate) fn current(store: &Store<'_>, cookie_header: Option<&str>) -> Result<Option<Principal>> {
    let Some(row) = current_row(store, cookie_header)? else { return Ok(None) };
    Ok(Some(Principal {
        account: row.account,
        sign_in: format!("{SESSION_SIGN_IN}{}", row.id),
        client_id: None,
        scopes: contract().scopes.clone(),
        expires_at_ms: row.expires_at,
    }))
}

/// The principal the live session row `id` acts as now, read without renewal or any write: how a run a signed-in page
/// started is admitted again by its cause's own sign-in name (`session:<id>`), never by a copy of the cookie. An ended
/// or expired session answers `None`, so the run stops at its next check.
pub(crate) fn named(store: &Store<'_>, id: &str) -> Result<Option<Principal>> {
    Ok(store.get::<Session>(Family::Sessions, id)?.map(|row| Principal {
        sign_in: format!("{SESSION_SIGN_IN}{}", row.id),
        account: row.account,
        client_id: None,
        scopes: contract().scopes.clone(),
        expires_at_ms: row.expires_at,
    }))
}

/// The session row named by a request's `Cookie` header, renewed if due: how and when it started, for a step that asks
/// for a recent sign-in (`ways::may_change`).
pub(crate) fn current_row(store: &Store<'_>, cookie_header: Option<&str>) -> Result<Option<Row<Session>>> {
    let Some(secret) = presented_secret(cookie_header) else { return Ok(None) };
    let Some(mut row) = store.get::<Session>(Family::Sessions, &blake3_hex(secret))? else { return Ok(None) };
    renew_if_due(store, &mut row, now_ms())?;
    Ok(Some(row))
}

/// End the session named by the `Cookie` header. Answers the clearing `Set-Cookie` value.
pub(crate) fn end(store: &Store<'_>, cookie_header: Option<&str>) -> Result<String> {
    if let Some(secret) = presented_secret(cookie_header) {
        store.remove(Family::Sessions, &blake3_hex(secret))?;
    }
    Ok(format!("{}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0", contract().session_cookie))
}

/// The account's live sessions, newest first: never a secret, only the row id a principal names, how and when each
/// started, and when it ends (old trillion src/passkey-list.mjs:19-34 `listed`, `listedValues` over
/// `user-session:<user>:`; here the sessions family is the list itself, so nothing trails a write).
pub(crate) fn listed(store: &Store<'_>, account: &str) -> Result<Vec<Row<Session>>> {
    let mut rows: Vec<Row<Session>> = store.list(Family::Sessions, account, MOST_LISTED)?;
    rows.sort_by(|a, b| b.value.created_at.cmp(&a.value.created_at));
    Ok(rows)
}

/// End the session `id` of `account` (old src/account-routes.mjs:694-706 `account/sessions/end`): its principal is
/// refused at its next check (`account_routes.rs` asks the sign-in afresh at every check). Answers whether one was ended.
pub(crate) fn end_one(store: &Store<'_>, account: &str, id: &str) -> Result<bool> {
    match store.get::<Session>(Family::Sessions, id)? {
        Some(row) if row.account == account => store.remove(Family::Sessions, id),
        _ => Ok(false),
    }
}

/// A web link's row: whose it is is the row's account; `next` is where it opens.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct WebLink {
    purpose: String,
    next: String,
}

/// A link for `account` that opens `next` signed in, at `origin` + `base` (old src/web-sign-in.mjs:21-29
/// `makeWebSignInLink`): one use, within `settings.json` `web_link_seconds`. Only the hash of its code is kept
/// (invariant 1), nothing in the link names the account (invariant 2), and `next` is decided now, by
/// `routes::safe_next` (invariant 3). Answers the link and how long it works.
pub(crate) fn web_link(store: &Store<'_>, account: &str, origin: &str, base: &str, next: Option<&str>) -> Result<(String, u64)> {
    let seconds = super::settings().web_link_seconds;
    let code = random_hex(32);
    let row = Row {
        id: blake3_hex(&code),
        account: account.to_string(),
        expires_at: now_ms().saturating_add(seconds.saturating_mul(1000)),
        value: WebLink { purpose: WEB_LINK_PURPOSE.to_string(), next: super::routes::safe_next(next, base) },
    };
    store.insert(Family::Challenges, &row)?;
    Ok((format!("{origin}{}?{}={code}", super::routes::sign_in_path(base), super::routes::WEB_LINK_FIELD), seconds))
}

/// Open a web link (old src/web-sign-in.mjs:31-45 `openWebSignInLink`): the first time within its life, for `account`,
/// it starts a session and answers the `Set-Cookie` value and where to go; a used, expired, made-up or other account's
/// link answers `None` (the caller shows the sign-in page). The row is taken before the session starts, so two opens
/// at once start at most one.
pub(crate) fn open_web_link(store: &Store<'_>, account: &str, code: &str) -> Result<Option<(String, String)>> {
    let well_formed = code.len() == 64 && code.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !well_formed {
        return Ok(None);
    }
    let id = blake3_hex(code);
    // A passkey ceremony's challenge has another purpose and another id; reading first never takes one.
    match store.get::<Value>(Family::Challenges, &id)? {
        Some(row) if row.account == account && row.value.get("purpose").and_then(Value::as_str) == Some(WEB_LINK_PURPOSE) => {}
        _ => return Ok(None),
    }
    let Some(taken) = store.take::<WebLink>(Family::Challenges, &id)? else { return Ok(None) };
    let cookie = start(store, account, WEB_LINK_METHOD)?;
    Ok(Some((cookie, taken.value.next)))
}

/// When a session made or renewed at `now` for `seconds` expires, in ms.
fn expiry(now: u64, seconds: u64) -> u64 {
    now.saturating_add(seconds.saturating_mul(1000))
}

/// The secret of the first cookie named `contract().session_cookie`, when its
/// value is exactly 64 lowercase hex. A malformed first match is not skipped
/// for a later one.
fn presented_secret(cookie_header: Option<&str>) -> Option<&str> {
    let name = contract().session_cookie.as_str();
    let value = cookie_header?.split(';').map(str::trim).find_map(|pair| {
        let (cookie, value) = pair.split_once('=')?;
        (cookie.trim() == name).then_some(value)
    })?;
    let well_formed = value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    well_formed.then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    fn fixture() -> Memory {
        crate::account::sign_in::lists::test_memory()
    }

    fn secret_of(set_cookie: &str) -> String {
        let pair = set_cookie.split(';').next().expect("a cookie pair");
        pair.split_once('=').expect("name=value").1.to_string()
    }

    fn cookie_for(secret: &str) -> String {
        format!("{}={}", contract().session_cookie, secret)
    }

    fn put_session(store: &Store<'_>, secret: &str, renewed_at: u64, expires_at: u64) {
        let row = Row {
            id: blake3_hex(secret),
            account: "acct".to_string(),
            expires_at,
            value: Session { method: "passkey".to_string(), created_at: 1, renewed_at },
        };
        store.put(Family::Sessions, &row).expect("row written");
    }

    #[test]
    fn the_session_cookie_is_host_prefixed_so_no_other_cookie_can_shadow_it() {
        let mem = fixture();
        let store = Store::new(&mem);
        let set = start(&store, "acct", "passkey").unwrap();
        assert!(set.starts_with("__Host-trillion_session="), "{set}");
        assert!(set.contains("; Secure") && set.contains("; Path=/") && !set.contains("Domain="), "{set}");
    }

    #[test]
    fn start_sets_the_cookie_and_stores_only_the_fingerprint() {
        let mem = fixture();
        let store = Store::new(&mem);
        let set = start(&store, "acct", "passkey").unwrap();
        let s = contract();
        let secret = secret_of(&set);
        assert_eq!(set, format!("{}={}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={}", s.session_cookie, secret, super::super::lists::for_tests().session_seconds));
        assert_eq!(secret.len(), 64);
        let row = store.get::<Session>(Family::Sessions, &blake3_hex(&secret)).unwrap().expect("stored");
        assert_eq!(row.account, "acct");
        assert_eq!(row.value.method, "passkey");
        assert_eq!(row.value.created_at, row.value.renewed_at);
        assert!(row.expires_at > now_ms());
        assert!(store.get::<Session>(Family::Sessions, &secret).unwrap().is_none(), "the secret itself is not a row id");
    }

    #[test]
    fn current_answers_the_principal_for_a_good_cookie() {
        let mem = fixture();
        let store = Store::new(&mem);
        let set = start(&store, "acct", "passkey").unwrap();
        let secret = secret_of(&set);
        let principal = current(&store, Some(&cookie_for(&secret))).unwrap().expect("a principal");
        assert_eq!(principal.account, "acct");
        assert_eq!(principal.sign_in, format!("session:{}", blake3_hex(&secret)));
        assert_eq!(principal.client_id, None);
        assert_eq!(principal.scopes, contract().scopes);
        assert!(principal.expires_at_ms > now_ms());

        let among_others = format!("theme=dark; {}; x=1", cookie_for(&secret));
        assert!(current(&store, Some(&among_others)).unwrap().is_some());
    }

    #[test]
    fn current_refuses_malformed_cookies() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = secret_of(&start(&store, "acct", "passkey").unwrap());
        let name = contract().session_cookie.clone();
        let refused: Vec<Option<String>> = vec![
            None,
            Some(String::new()),
            Some("other=1".to_string()),
            Some(format!("{name}")),
            Some(format!("{name}=")),
            Some(format!("{name}={}", secret.to_uppercase())),
            Some(format!("{name}={}", &secret[..63])),
            Some(format!("{name}={secret}0")),
            Some(format!("{name}={}", "g".repeat(64))),
            Some(format!("{name}={}x", &secret[..63])),
            Some(format!("{name}=bad; {}", cookie_for(&secret))),
        ];
        for header in refused {
            assert_eq!(current(&store, header.as_deref()).unwrap(), None, "header {header:?}");
        }
    }

    #[test]
    fn current_refuses_an_unknown_session() {
        let mem = fixture();
        let store = Store::new(&mem);
        assert_eq!(current(&store, Some(&cookie_for(&random_hex(32)))).unwrap(), None);
    }

    #[test]
    fn current_refuses_an_expired_session() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = random_hex(32);
        put_session(&store, &secret, now_ms(), now_ms() - 1);
        assert_eq!(current(&store, Some(&cookie_for(&secret))).unwrap(), None);
    }

    #[test]
    fn end_turns_the_session_off() {
        let mem = fixture();
        let store = Store::new(&mem);
        let cookie = cookie_for(&secret_of(&start(&store, "acct", "passkey").unwrap()));
        let clearing = end(&store, Some(&cookie)).unwrap();
        assert_eq!(clearing, format!("{}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0", contract().session_cookie));
        assert_eq!(current(&store, Some(&cookie)).unwrap(), None);
    }

    #[test]
    fn end_leaves_other_sessions_alone_and_clears_without_one() {
        let mem = fixture();
        let store = Store::new(&mem);
        let kept = cookie_for(&secret_of(&start(&store, "acct", "passkey").unwrap()));
        let ended = cookie_for(&secret_of(&start(&store, "acct", "passkey").unwrap()));
        end(&store, Some(&ended)).unwrap();
        assert!(current(&store, Some(&kept)).unwrap().is_some());
        assert_eq!(current(&store, Some(&ended)).unwrap(), None);

        let none = end(&store, None).unwrap();
        assert_eq!(none, format!("{}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0", contract().session_cookie));
        let garbage = end(&store, Some("__Host-trillion_session=nope")).unwrap();
        assert_eq!(garbage, none);
    }

    #[test]
    fn a_stale_session_is_renewed_on_use() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = random_hex(32);
        let stale = now_ms() - 2 * RENEW_AFTER_MS;
        put_session(&store, &secret, stale, now_ms() + 1_000);

        let before = now_ms();
        let principal = current(&store, Some(&cookie_for(&secret))).unwrap().expect("still live");
        let row = store.get::<Session>(Family::Sessions, &blake3_hex(&secret)).unwrap().expect("row");
        assert!(row.value.renewed_at >= before);
        assert!(row.expires_at >= before + super::super::lists::for_tests().session_seconds * 1000);
        assert_eq!(principal.expires_at_ms, row.expires_at);
    }

    #[test]
    fn a_recent_session_is_not_rewritten() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = random_hex(32);
        let renewed = now_ms() - 1_000;
        let expires = now_ms() + 5_000;
        put_session(&store, &secret, renewed, expires);

        current(&store, Some(&cookie_for(&secret))).unwrap().expect("live");
        let row = store.get::<Session>(Family::Sessions, &blake3_hex(&secret)).unwrap().expect("row");
        assert_eq!(row.value.renewed_at, renewed);
        assert_eq!(row.expires_at, expires);
    }

    #[test]
    fn the_window_token_is_admitted_after_start_and_kept_while_live() {
        let mem = fixture();
        let store = Store::new(&mem);
        let id = blake3_hex(&random_hex(32));
        assert!(!window_live(&store, "acct", &id).unwrap(), "no row before start");
        start_window(&store, "acct", &id).unwrap();
        assert!(window_live(&store, "acct", &id).unwrap());
        assert!(!window_live(&store, "someone-else", &id).unwrap(), "another account's row is not this window's");
        let made = store.get::<Session>(Family::Sessions, &id).unwrap().expect("row").value;
        start_window(&store, "acct", &id).unwrap();
        assert_eq!(store.get::<Session>(Family::Sessions, &id).unwrap().expect("row").value, made, "a live row is kept");
    }

    #[test]
    fn a_removed_or_expired_window_row_refuses_at_the_next_check() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = random_hex(32);
        let id = blake3_hex(&secret);
        start_window(&store, "acct", &id).unwrap();
        store.remove(Family::Sessions, &id).unwrap();
        assert!(!window_live(&store, "acct", &id).unwrap(), "a removed row refuses");
        put_session(&store, &secret, now_ms(), now_ms() - 1);
        assert!(!window_live(&store, "acct", &id).unwrap(), "an expired row refuses");
        start_window(&store, "acct", &id).unwrap();
        assert!(window_live(&store, "acct", &id).unwrap(), "a new start replaces an expired row");
    }

    #[test]
    fn a_stale_window_row_slides_like_a_cookie_session() {
        let mem = fixture();
        let store = Store::new(&mem);
        let secret = random_hex(32);
        let id = blake3_hex(&secret);
        put_session(&store, &secret, now_ms() - 2 * RENEW_AFTER_MS, now_ms() + 1_000);
        let before = now_ms();
        assert!(window_live(&store, "acct", &id).unwrap());
        let row = store.get::<Session>(Family::Sessions, &id).unwrap().expect("row");
        assert!(row.value.renewed_at >= before);
        assert!(row.expires_at >= before + super::super::lists::for_tests().session_seconds * 1000);
    }

    #[test]
    fn the_accounts_sessions_are_listed_and_another_one_ended_and_refused_at_its_next_check() {
        let mem = fixture();
        let store = Store::new(&mem);
        let first = cookie_for(&secret_of(&start(&store, "acct", "passkey").unwrap()));
        let second = cookie_for(&secret_of(&start(&store, "acct", "email-code").unwrap()));
        start(&store, "someone-else", "passkey").unwrap();
        let listed = listed(&store, "acct").unwrap();
        assert_eq!(listed.len(), 2, "only this account's");
        let second_id = current_row(&store, Some(&second)).unwrap().unwrap().id;
        assert!(!end_one(&store, "someone-else", &second_id).unwrap(), "another account's session is not ended");
        assert!(end_one(&store, "acct", &second_id).unwrap());
        assert_eq!(current(&store, Some(&second)).unwrap(), None);
        assert!(current(&store, Some(&first)).unwrap().is_some());
        assert!(!end_one(&store, "acct", &second_id).unwrap(), "already gone");
    }

    #[test]
    fn a_web_link_opens_a_signed_in_page_once_and_a_used_expired_or_made_up_one_opens_nothing() {
        let mem = fixture();
        let store = Store::new(&mem);
        let (link, seconds) = web_link(&store, "acct", "https://trillion.example", "/a/abc", Some("/a/abc/sign-in/security")).unwrap();
        assert_eq!(seconds, super::super::settings().web_link_seconds);
        let (path, code) = link.split_once("?from_app=").expect("the link carries its code");
        assert_eq!(path, "https://trillion.example/a/abc/sign-in");
        assert!(!link.contains("acct"), "nothing in the link names the account");
        assert!(store.get::<Value>(Family::Challenges, code).unwrap().is_none(), "only the code's hash is kept");
        assert_eq!(open_web_link(&store, "someone-else", code).unwrap(), None, "another account's link opens nothing");
        let (cookie, next) = open_web_link(&store, "acct", code).unwrap().expect("opened");
        assert_eq!(next, "/a/abc/sign-in/security");
        let principal = current(&store, Some(cookie.split(';').next().unwrap())).unwrap().expect("signed in");
        assert_eq!(principal.account, "acct");
        assert_eq!(current_row(&store, Some(cookie.split(';').next().unwrap())).unwrap().unwrap().value.method, WEB_LINK_METHOD);
        assert_eq!(open_web_link(&store, "acct", code).unwrap(), None, "one use");
        assert_eq!(open_web_link(&store, "acct", "zz").unwrap(), None, "made up");
        assert_eq!(open_web_link(&store, "acct", &random_hex(32)).unwrap(), None, "unknown");

        // The address it opens is decided when it is made: another host is never one.
        let (link, _) = web_link(&store, "acct", "https://trillion.example", "", Some("//evil.example")).unwrap();
        let code = link.split_once("?from_app=").unwrap().1;
        // An expired link opens nothing.
        let mut row: Row<Value> = store.get(Family::Challenges, &blake3_hex(code)).unwrap().unwrap();
        assert_eq!(row.value["next"], "/");
        row.expires_at = now_ms() - 1;
        store.put(Family::Challenges, &row).unwrap();
        assert_eq!(open_web_link(&store, "acct", code).unwrap(), None);
    }

}
