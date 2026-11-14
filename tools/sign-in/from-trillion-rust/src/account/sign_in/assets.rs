//! The static files every page of the sign-in shell names (old trillion's public assets, `html-page.mjs` ICONS, LOGO, the
//! page look's stylesheet and its fonts): the brand mark, the tab and home-screen icons, the manifest and the fonts.
//! `assets.json` names each path, its content identity (`1f:` + BLAKE3 hex of the bytes) and the file under the page
//! look's `static_root` that answers it until the bytes are uploaded to the operator's Namespace and verified on two places.
//!
//! A computer answers from its verified content cache first: `<accounts>/content/<hex>`, a file named by the identity's hex
//! and checked against its identity on every read. `/content/<identity>` answers the same bytes for an identity
//! `assets.json` names and for no other, so the list is the allow-list and no account file can leak through it. A file
//! that is missing, unreadable or not its identity's bytes is not an answer: the forwarder passes over its 404 or 5xx
//! (`forwarder/new_accounts.rs`), so no place is special and none can serve wrong bytes.

use crate::forwarder::new_accounts::{self, Reach};
use crate::forwarder::tls::{https_request, HttpsAnswer, HttpsAsk};
use crate::refusal_cause::CodedError;
use serde::Deserialize;
use std::{path::{Path, PathBuf}, sync::OnceLock, time::Duration};

/// The folder under a computer's accounts folder that holds the verified content cache.
pub(crate) const CONTENT_FOLDER: &str = "content";

/// One served file: the path a request names, its content identity, the file under the look's `static_root` that answers
/// it, and its content type.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Asset {
    pub path: String,
    pub identity: String,
    pub file: String,
    pub content_type: String,
}

/// One answer's limits when a missing file is fetched (`assets.json` `fetch`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fetch {
    answer_bytes: usize,
    wait_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    #[serde(rename = "_what")]
    _what: String,
    files: Vec<Asset>,
    /// The https origins a computer fetches a missing file from, once, in order (`/content/<identity>` on each).
    origins: Vec<String>,
    fetch: Fetch,
}

fn table() -> &'static Table {
    static TABLE: OnceLock<Table> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_slice(include_bytes!("assets.json")).expect("assets.json is valid"))
}

/// Every served file (`assets.json`).
pub(crate) fn files() -> &'static [Asset] {
    &table().files
}

/// The content identity of `bytes`: `1f:` and their BLAKE3 hex (the Namespace's file identity form).
pub(crate) fn identity_of(bytes: &[u8]) -> String {
    format!("1f:{}", content_crypto::advanced::blake3::hash(bytes).to_hex())
}

/// The cache file's name for `identity`: its hex, once the identity has the form `1f:` + 64 lowercase hex digits.
fn cache_name(identity: &str) -> Option<&str> {
    let hex = identity.strip_prefix("1f:")?;
    let lower = |byte: &u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte);
    (hex.len() == 64 && hex.as_bytes().iter().all(lower)).then_some(hex)
}

/// The cached bytes of `identity`, or None when the cache holds no file for it or the file is not those bytes.
pub(crate) fn cached(content: &Path, identity: &str) -> Option<Vec<u8>> {
    let bytes = std::fs::read(content.join(cache_name(identity)?)).ok()?;
    (identity_of(&bytes) == identity).then_some(bytes)
}

/// Keep `bytes` as the cache file of `identity`. Refused, and nothing written, unless they are that identity's bytes.
pub(crate) fn keep(content: &Path, identity: &str, bytes: &[u8]) -> Result<(), CodedError<&'static str>> {
    let name = cache_name(identity).ok_or_else(|| CodedError::new("the content identity is not 1f: and 64 hex digits"))?;
    if identity_of(bytes) != identity {
        return Err(CodedError::new("the bytes are not the content identity's"));
    }
    let beside = content.join(format!("{name}.partial"));
    let written = std::fs::create_dir_all(content).and_then(|()| std::fs::write(&beside, bytes))
        .and_then(|()| std::fs::rename(&beside, content.join(name)));
    written.map_err(|_| CodedError::new("the content cache could not be written"))
}

/// The bytes of `asset`: its verified cache file, else the file under the look's `static_root` when those bytes are the
/// asset's identity.
fn bytes(content: &Path, asset: &Asset) -> Option<Vec<u8>> {
    cached(content, &asset.identity).or_else(|| {
        let root = super::pages::look().static_root.as_deref()?;
        let bytes = std::fs::read(Path::new(root).join(&asset.file)).ok()?;
        (identity_of(&bytes) == asset.identity).then_some(bytes)
    })
}

/// Store the bytes of every file the cache and `static_root` lack, fetched once from the holders `assets.json` `origins`
/// names. Each holder is asked `GET /content/<identity>`; an answer is kept only when its bytes are the identity's, so a
/// holder that lacks or alters a file is passed over. Runs once at a computer's start, on its own thread.
pub(crate) fn warm(content: PathBuf) {
    let origins: Vec<Reach> = table().origins.iter().filter_map(|origin| new_accounts::reach_of(origin)).collect();
    if origins.is_empty() {
        return;
    }
    let limits = &table().fetch;
    let wait = Duration::from_millis(limits.wait_ms);
    for asset in files() {
        if bytes(&content, asset).is_none() {
            fetch_with(&content, &asset.identity, &origins, |reach, target| {
                let ask = HttpsAsk { method: "GET", target, headers: &[], body: &[] };
                https_request(&reach.host, reach.port, &ask, limits.answer_bytes, wait)
            });
        }
    }
}

/// Fetch `identity` from the first of `origins` that answers it with the identity's bytes, and keep them in the cache.
/// True when a holder's answer was kept; a refused answer keeps nothing.
pub(crate) fn fetch_with(
    content: &Path,
    identity: &str,
    origins: &[Reach],
    mut send: impl FnMut(&Reach, &str) -> std::io::Result<HttpsAnswer>,
) -> bool {
    let target = format!("/content/{identity}");
    crate::forwarder::tls::first_verified(
        origins,
        |reach| send(*reach, &target).map_err(|_| CodedError::new("the holder did not answer")),
        |_, answer| {
            if answer.status != 200 {
                return Err(CodedError::new("the holder does not hold the file"));
            }
            keep(content, identity, &answer.body)
        },
    )
    .verified
    .is_some()
}

/// The answer with `body` for `content_type`, cached for an hour; 404 when `body` is None.
fn answer(body: Option<Vec<u8>>, content_type: &str) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;
    match body {
        Some(body) => ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, "public, max-age=3600")], body).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The answer to a request for `asset` at its path.
pub(crate) fn respond(asset: &Asset, content: &Path) -> axum::response::Response {
    answer(bytes(content, asset), &asset.content_type)
}

/// The answer to `/content/<identity>`: the bytes of an identity `assets.json` names, else 404.
pub(crate) fn respond_identity(identity: &str, content: &Path) -> axum::response::Response {
    match files().iter().find(|asset| asset.identity == identity) {
        Some(asset) => answer(bytes(content, asset), &asset.content_type),
        None => answer(None, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_served_path_is_carried_by_the_forwarder() {
        let settings: serde_json::Value = serde_json::from_slice(include_bytes!("../../forwarder/new_accounts.json"))
            .expect("new_accounts.json is valid");
        let carried: Vec<&str> = settings["carried_paths"].as_array().expect("carried_paths")
            .iter().filter_map(serde_json::Value::as_str).collect();
        for asset in files() {
            assert!(carried.contains(&asset.path.as_str()), "{} must be carried by the forwarder", asset.path);
        }
    }

    #[test]
    fn every_identity_has_the_namespace_form() {
        for asset in files() {
            assert!(cache_name(&asset.identity).is_some(), "{} names {}", asset.path, asset.identity);
        }
    }

    #[test]
    fn the_identity_is_blake3_of_the_bytes() {
        assert_eq!(identity_of(b""), "1f:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    }

    #[test]
    fn a_kept_identity_reads_back_and_other_bytes_are_refused() {
        let folder = tempfile::tempdir().unwrap();
        let content = folder.path().join(CONTENT_FOLDER);
        let identity = identity_of(b"mark");
        assert_eq!(cached(&content, &identity), None);
        assert!(keep(&content, &identity, b"other").is_err());
        assert!(!content.exists() || std::fs::read_dir(&content).unwrap().next().is_none(), "a refused keep writes nothing");
        keep(&content, &identity, b"mark").unwrap();
        assert_eq!(cached(&content, &identity).unwrap(), b"mark");
    }

    #[test]
    fn a_corrupted_cache_file_is_not_an_answer() {
        let folder = tempfile::tempdir().unwrap();
        let identity = identity_of(b"mark");
        keep(folder.path(), &identity, b"mark").unwrap();
        std::fs::write(folder.path().join(cache_name(&identity).unwrap()), b"changed").unwrap();
        assert_eq!(cached(folder.path(), &identity), None);
    }

    #[test]
    fn an_identity_that_is_not_the_namespace_form_names_no_file() {
        let folder = tempfile::tempdir().unwrap();
        for identity in ["1f:../../escape", "12:0925a153b94ba014c5bdc1ba0209157739feff6429af932218fa181c8b1f8e00", "1f:ABC"] {
            assert!(keep(folder.path(), identity, b"").is_err());
            assert_eq!(cached(folder.path(), identity), None);
        }
    }

    #[test]
    fn content_serves_only_listed_identities() {
        let folder = tempfile::tempdir().unwrap();
        let unlisted = identity_of(b"an account file");
        keep(folder.path(), &unlisted, b"an account file").unwrap();
        assert_eq!(respond_identity(&unlisted, folder.path()).status(), axum::http::StatusCode::NOT_FOUND);
    }

    fn answer(status: u16, body: &[u8]) -> HttpsAnswer {
        HttpsAnswer { status, headers: Vec::new(), body: body.to_vec() }
    }

    fn holder(host: &str) -> Reach {
        Reach { host: host.to_owned(), port: 443 }
    }

    #[test]
    fn a_missing_file_is_fetched_from_the_next_holder_that_has_its_bytes() {
        let folder = tempfile::tempdir().unwrap();
        let identity = identity_of(b"mark");
        let origins = [holder("first.example"), holder("second.example")];
        let mut asked = Vec::new();
        let kept = fetch_with(folder.path(), &identity, &origins, |reach, target| {
            asked.push((reach.host.clone(), target.to_owned()));
            Ok(if reach.host == "first.example" { answer(404, b"") } else { answer(200, b"mark") })
        });
        assert!(kept);
        assert_eq!(asked, [("first.example".to_owned(), format!("/content/{identity}")), ("second.example".to_owned(), format!("/content/{identity}"))]);
        assert_eq!(cached(folder.path(), &identity).unwrap(), b"mark");
    }

    #[test]
    fn a_holder_that_answers_other_bytes_keeps_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let identity = identity_of(b"mark");
        let kept = fetch_with(folder.path(), &identity, &[holder("wrong.example")], |_, _| Ok(answer(200, b"changed")));
        assert!(!kept);
        assert_eq!(cached(folder.path(), &identity), None);
    }

    #[test]
    fn an_unreachable_holder_is_passed_over_and_none_keeps_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let identity = identity_of(b"mark");
        let origins = [holder("down.example"), holder("also-down.example")];
        let kept = fetch_with(folder.path(), &identity, &origins, |_, _| Err(std::io::Error::other("synthetic connection lost")));
        assert!(!kept);
        assert_eq!(cached(folder.path(), &identity), None);
    }

    #[test]
    fn the_mark_is_named_as_svg_under_the_root() {
        let mark = files().iter().find(|asset| asset.path == "/brand/current/mark.svg").expect("the mark is served");
        assert_eq!(mark.content_type, "image/svg+xml");
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(bytes(folder.path(), mark), None, "no cache file and no static root, no file");
    }
}
