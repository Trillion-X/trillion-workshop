//! A public browser account address for routing the site's front page, never proof of a sign-in.
//!
//! Old trillion src/worker.mjs:3534-3535 set a session cookie and a separate known-browser flag; its single
//! account-serving owner did not need an address hint. The stateless native forwarder keeps no sessions, so this
//! separate public hint chooses only an account's own path. The account still checks its opaque session there.
//! Old src/web-sign-in.mjs:43-44 carried all sign-in cookies when a one-use web link opened; native routes do too.

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    #[serde(rename = "_what")]
    _what: String,
    cookie: String,
    attributes: String,
    clearing_attributes: String,
}

fn settings() -> &'static Settings {
    static SETTINGS: OnceLock<Settings> = OnceLock::new();
    SETTINGS.get_or_init(|| {
        serde_json::from_slice(include_bytes!("route-hint.json")).expect("route-hint.json is valid")
    })
}

/// A route hint with the lifetime of the session cookie the sign-in just issued. No secret is copied into it.
/// A caller with no public account address gets no hint; the existing single-account session remains usable.
pub(crate) fn for_session(address: &str, session_cookie: &str) -> Option<String> {
    if !crate::account::sign_in::tokens::owner_text_ok(address) {
        return None;
    }
    let seconds = session_cookie
        .split(';')
        .find_map(|part| part.trim().strip_prefix("Max-Age="))?
        .parse::<u64>()
        .ok()?;
    let data = settings();
    Some(format!(
        "{}={address}; {}; Max-Age={seconds}",
        data.cookie, data.attributes
    ))
}

/// Clearing the browser's routing hint neither revokes nor grants any account session.
pub(crate) fn clearing() -> String {
    let data = settings();
    format!("{}=; {}", data.cookie, data.clearing_attributes)
}

/// The hint from all Cookie header lines. Duplicates and malformed values are refused, never selected by order.
/// The result is only a same-origin path choice: a tampered valid address is not authority for that account.
pub(crate) fn address<'a>(
    cookies: impl IntoIterator<Item = &'a str>,
) -> Result<Option<String>, crate::refusal_cause::CodedError<()>> {
    let name = &settings().cookie;
    let mut found = None;
    for part in cookies.into_iter().flat_map(|line| line.split(';')) {
        let part = part.trim();
        let Some((key, value)) = part.split_once('=') else {
            if part == name {
                return Err(crate::refusal_cause::CodedError::new(()));
            }
            continue;
        };
        if key.trim() != name {
            continue;
        }
        if key != name || found.is_some() || !crate::account::sign_in::tokens::owner_text_ok(value)
        {
            return Err(crate::refusal_cause::CodedError::new(()));
        }
        found = Some(value.to_owned());
    }
    Ok(found)
}

#[cfg(test)]
#[path = "browser_route_hint_tests.rs"]
mod browser_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_hint_is_public_host_only_metadata_with_the_session_lifetime() {
        let account = "a".repeat(64);
        let cookie = for_session(
            &account,
            "session=PRIVATE_TEST_SESSION; HttpOnly; Secure; Path=/; Max-Age=900",
        )
        .unwrap();
        assert_eq!(cookie, format!("__Host-account-address={account}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900"));
        assert!(!cookie.contains("PRIVATE_TEST_SESSION"));
        assert!(!cookie.contains("Domain="));
        assert_eq!(
            clearing(),
            "__Host-account-address=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0"
        );
        assert!(for_session("not-an-address", "session=x; Max-Age=900").is_none());
    }

    #[test]
    fn malformed_duplicate_and_conflicting_hints_are_never_chosen() {
        let a = format!("__Host-account-address={}", "a".repeat(64));
        let b = format!("__Host-account-address={}", "b".repeat(64));
        assert_eq!(address(["other=value"]), Ok(None));
        assert_eq!(address([a.as_str()]), Ok(Some("a".repeat(64))));
        assert!(address([a.as_str(), a.as_str()]).is_err());
        assert!(address([a.as_str(), b.as_str()]).is_err());
        assert!(address(["__Host-account-address"]).is_err());
        for bad in ["", "../elsewhere", "https://elsewhere.test", "A", "a%2fb"] {
            assert!(address([format!("__Host-account-address={bad}").as_str()]).is_err());
        }
    }
}
