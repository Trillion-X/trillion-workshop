// src/native_entry/parent_kept.rs
//
// Ported one to one from trillion-rust side/engine-keeps-nothing (2c742058, 5b3689b0, 542df2ce: src/native_entry/
// parent_kept.rs), onto main's names: held_values is src/secrets.rs, its AccountRoot is `SecretsKey`, its root.rs is
// src/secrets/secrets_key.rs (`SecretsKeySource::HostingApp`), a frame is a message (native::keep_message), the
// credential home is src/secrets/credential-home.json, and the window's cookie is workspace_session `WINDOW_COOKIE`.
// Dropped: the product_data pin of the credential home (main ships it with src/secrets.rs `CREDENTIAL_HOME`).
//
//! What the engine the app launched keeps, kept by the app and decided here.
//!
//! The engine decides what the app keeps for it (its vault root and its computer key); the app (the parent that launched
//! this engine) only stores them. They travel as one opaque blob: the parent sends back the last one it stored as the
//! launch message's `kept`, and every change here writes the whole blob to the parent in one `keep` message
//! (native::keep_message) on the private stdout. The engine writes no Keychain item and no secret file of its own, so an
//! engine run anywhere (a test, a proof on a copied state, a made-up account) can only hand its blob to the parent that
//! launched it.
//!
//! The vault root (main's secrets key) travels in the same blob (`VAULT_ROOT`): the engine opens the account's secrets
//! vault with the key the app sent back (secrets_key `SecretsKeySource::HostingApp`). When the app sends none yet, the
//! key this computer kept before (its own Keychain item, or the app's old key item it was first split from) is read
//! once, never written, and handed to the app; a computer that kept none gets a new key.
//!
//! The engine's own computer key travels in the blob too (`COMPUTER_KEY`, `ParentKept::computer_key`): made here once,
//! kept by the app, so the engine is the same computer of its account at every launch (its id in the computers row) and
//! a root another computer of the account sends it is sealed to that key (native_entry/computer/hosting.rs).
//!
//! The app shows its page the same way: it opens `native::OWNER_PAGE_PATH` with the binding as its bearer, and the
//! engine answers with the workspace's own session cookie (its state folder's browser session) and sends the browser
//! on to the page (`owner_page`). The app reads no file of the engine's state and names no cookie.
//!
//! Non-Negotiable Invariants:
//! - The parent never reads inside the blob; the engine never reads a store of the parent's.
//! - A blob that does not parse is nothing kept: the next value kept here hands the parent a blob that replaces the
//!   unreadable one. The app's own key and device key, which the account's sign-in issued before sign-in moved to the
//!   Better Auth Workshop tool (Nov 13 2026), are no longer read or kept: a blob that still holds them keeps them only
//!   as values this engine never reads.
//! - No key, binding or blob is logged, put in argv or in an error: one fixed word per refusal.
//! - The binding is compared in constant time and admits only the bearer of this launch (`owner_page`).
//!
//! AI Assistant Directive:
//! The extensive documentation in this codebase is a critical design feature.
//! You are forbidden from simplifying or removing it. Maintain and extend this detail.
use crate::native::{self, OwnerBinding, ParentWriter};
use axum::{
    extract::{Request, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

/// The name of the vault root in the kept blob.
const VAULT_ROOT: &str = "vault_root";

/// The name of this engine's own computer key in the kept blob (`ParentKept::computer_key`).
const COMPUTER_KEY: &str = "computer_key";

/// The blob of one launch: what the parent sent back, changed only by `keep`, each change handed to the parent.
pub(crate) struct ParentKept {
    values: Mutex<BTreeMap<String, Zeroizing<String>>>,
    writer: ParentWriter,
    boot_id: String,
}
impl ParentKept {
    /// The values in the launch message's `kept` (a JSON object of names to text), none when it sent none. A blob that
    /// does not parse logs `native-app-key kept=unreadable` once and is nothing kept.
    pub(crate) fn from_launch(kept: Option<Zeroizing<Vec<u8>>>, writer: ParentWriter, boot_id: &str) -> Self {
        let values = match kept {
            None => BTreeMap::new(),
            Some(bytes) => serde_json::from_slice::<BTreeMap<String, String>>(&bytes)
                .map(|values| values.into_iter().map(|(name, value)| (name, Zeroizing::new(value))).collect())
                .unwrap_or_else(|_| {
                    crate::quiet_eprintln!("native-app-key kept=unreadable cause={}", crate::cause!(kept_blob invalid_json));
                    BTreeMap::new()
                }),
        };
        Self { values: Mutex::new(values), writer, boot_id: boot_id.to_owned() }
    }
    /// The vault root for this launch: the one the app sent back, or (when it sent none) the one `before` finds on this
    /// computer, or a new one, handed to the app. A root the app sent that is not a root stops the start: making a new
    /// one would set the account's sealed values aside.
    pub(crate) fn vault_root(&self, before: impl FnOnce() -> crate::secrets::Result<Option<crate::secrets::SecretsKey>>)
        -> Result<crate::secrets::SecretsKey, crate::refusal_cause::CodedError<&'static str>> {
        use crate::account::KeptSecrets as _;
        if let Some(kept) = self.read(VAULT_ROOT).map_err(|error| crate::refusal_cause::CodedError::with_cause("the kept blob is unreadable", error.cause()))? {
            return crate::secrets::SecretsKey::new(kept).map_err(|error| crate::refusal_cause::CodedError::with_cause("the kept vault root is not a root", error.cause()));
        }
        let root = match before().map_err(|error| crate::refusal_cause::CodedError::with_cause("the vault root kept before could not be read", error.cause()))? {
            Some(root) => root,
            None => crate::secrets::secrets_key::generate().map_err(|error| crate::refusal_cause::CodedError::with_cause("a vault root could not be made", error.cause()))?,
        };
        if let Err(error) = self.keep(VAULT_ROOT, root.kept_text()) {
            crate::quiet_eprintln!("native-vault-root handed=no cause={}", error.cause());
        }
        Ok(root)
    }
    /// This engine's own computer key (`secrets_key::ComputerKey`): the one the app sent back in its blob, or (when it
    /// sent none yet) a new one, handed to the app in a keep message. Its signing key's public key is this engine's
    /// computer id in the account's computers row (`computers::ComputerSigner`), and a root another computer sends here
    /// is sealed to it, as at every `trillion-local serve` computer, whose key is its config's `place_key_file`. The
    /// app keeps it in the same Keychain item as the rest of the blob; the engine writes no file of it.
    ///
    /// Ported from old trillion (Trillion-X/trillion 7cbcbce9^): `computer/computer-sources.json:4` names the Keychain
    /// item the engine keeps its own key in (`trillion-agent-work-key`), and `macos/App/ComputerReader.swift:13-20`
    /// says the engine, not the app, decides what goes in it. Here the app keeps the blob and the engine decides the key.
    /// A key the app sent that is not a computer key stops this computer's part (never a new one: the account's row
    /// names the old id, and a root sealed to it would no longer open).
    pub(crate) fn computer_key(&self) -> Result<crate::secrets::secrets_key::ComputerKey, crate::refusal_cause::CodedError<&'static str>> {
        use crate::account::KeptSecrets as _;
        use base64::Engine as _;
        use ring::rand::SecureRandom as _;
        if let Some(kept) = self.read(COMPUTER_KEY).map_err(|error| crate::refusal_cause::CodedError::with_cause("the kept blob is unreadable", error.cause()))? {
            let bytes = base64::engine::general_purpose::STANDARD.decode(kept.trim().as_bytes())
                .map_err(|_| crate::refusal_cause::CodedError::new("the kept computer key is not a computer key"))?;
            return crate::secrets::secrets_key::ComputerKey::from_bytes(bytes).map_err(|error| crate::refusal_cause::CodedError::with_cause("the kept computer key is not a computer key", error.cause()));
        }
        let size = crate::secrets::secrets_key::computer_key_bytes().map_err(|error| crate::refusal_cause::CodedError::with_cause("the computer key size is unreadable", error.cause()))?;
        let mut bytes = Zeroizing::new(vec![0u8; size]);
        ring::rand::SystemRandom::new().fill(&mut bytes).map_err(|_| crate::refusal_cause::CodedError::new("a computer key could not be made"))?;
        let text = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*bytes));
        if let Err(error) = self.keep(COMPUTER_KEY, &text) {
            // Not kept by the app: this launch runs with it, the next makes another (a new id the row does not name).
            crate::quiet_eprintln!("native-computer-key handed=no cause={}", error.cause());
        }
        crate::secrets::secrets_key::ComputerKey::from_bytes(bytes.to_vec()).map_err(|error| crate::refusal_cause::CodedError::with_cause("a computer key could not be made", error.cause()))
    }
}
impl crate::account::KeptSecrets for ParentKept {
    fn read(&self, name: &str) -> crate::account::AccountResult<Option<Zeroizing<String>>> {
        let values = self.values.lock().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))?;
        Ok(values.get(name).cloned())
    }
    /// Held here at once, then handed to the parent in one `keep`
    /// message with every other value: kept when the parent's pipe took the whole message.
    fn keep(&self, name: &str, value: &str) -> crate::account::AccountResult<()> {
        let blob = {
            let mut values = self.values.lock().map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))?;
            values.insert(name.to_owned(), Zeroizing::new(value.to_owned()));
            let plain: BTreeMap<&str, &str> = values.iter().map(|(name, value)| (name.as_str(), value.as_str())).collect();
            Zeroizing::new(serde_json::to_vec(&plain).map_err(|error| crate::carry_cause!(crate::account::AccountError::SourceUnavailable, error))?)
        };
        let pipe_message = native::keep_message(&self.boot_id, &blob).map_err(|error| crate::account::AccountError::SourceUnavailable(error.cause()))?;
        self.writer.send(&pipe_message).map_err(|error| crate::account::AccountError::SourceUnavailable(error.cause()))
    }
}

/// Whether `request` carries this launch's owner binding as its bearer.
fn bound(owner: &OwnerBinding, request: &Request) -> bool {
    request.headers().get(header::AUTHORIZATION)
        .and_then(|value| value.as_bytes().strip_prefix(b"Bearer "))
        .is_some_and(|bearer| owner.admits(bearer))
}

/// The app's way into its page: `GET OWNER_PAGE_PATH?to=<the page path, base64 URL text>` with the owner binding as
/// the bearer is answered 303 to that path (the root when none) with the workspace's session cookie from the state
/// folder `state` (HttpOnly, SameSite Strict, the whole site, gone with the browser session). Any other bearer is 401,
/// a path that is not this site's own is 400, a state with no browser session is 503; none of them sets a cookie.
pub(crate) fn owner_page(router: Router, owner: Arc<OwnerBinding>, state: PathBuf) -> Router {
    router.route(native::OWNER_PAGE_PATH, get(open_page).with_state(Arc::new((owner, state))))
}

/// The page path `to` names: a path of this site (one leading slash, no backslash, no control character).
fn page_path(query: Option<&str>) -> Option<String> {
    use base64::Engine as _;
    let Some(query) = query else { return Some("/".to_owned()) };
    let mut named = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key != "to" || named.is_some() { return None; }
        named = Some(value);
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(named?).ok()?;
    let path = String::from_utf8(bytes).ok()?;
    (path.starts_with('/') && !path.starts_with("//") && !path.contains('\\') && !path.chars().any(char::is_control)
        && path.len() <= 4096).then_some(path)
}

async fn open_page(State(page): State<Arc<(Arc<OwnerBinding>, PathBuf)>>, request: Request) -> Response {
    let no_store = [(header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        (header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"))];
    if !bound(&page.0, &request) { return (StatusCode::UNAUTHORIZED, no_store).into_response(); }
    let Some(to) = page_path(request.uri().query()) else { return (StatusCode::BAD_REQUEST, no_store).into_response() };
    let Ok(token) = crate::account_source::ProtectedBrowserSession::token(&page.1) else {
        return (StatusCode::SERVICE_UNAVAILABLE, no_store).into_response();
    };
    let cookie = Zeroizing::new(format!("{}={}; Path=/; HttpOnly; SameSite=Strict", crate::workspace_session::WINDOW_COOKIE, token.as_str()));
    let (Ok(mut cookie), Ok(location)) = (HeaderValue::from_str(&cookie), HeaderValue::from_str(&to)) else {
        return (StatusCode::BAD_REQUEST, no_store).into_response();
    };
    cookie.set_sensitive(true);
    (StatusCode::SEE_OTHER, no_store, [(header::SET_COOKIE, cookie), (header::LOCATION, location)]).into_response()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::account::KeptSecrets as _;
    use axum::body::Body;
    use std::{io::Read as _, os::unix::net::UnixStream, time::Duration};
    use tower::ServiceExt;

    const BOOT: &str = "synthetic-kept-boot-0001";

    fn launch(kept: Option<&[u8]>) -> native::Launch {
        let mut frame = serde_json::json!({"version": native::LAUNCH_VERSION, "boot_id": BOOT, "state_identity": "a".repeat(64),
            "origin": "http://127.0.0.1:7199", "owner_pid": std::process::id(), "readiness_key": "b".repeat(64),
            "owner_binding": "d".repeat(64)});
        if let Some(kept) = kept {
            use base64::Engine as _;
            frame["kept"] = serde_json::json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(kept));
        }
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        native::Launch::parse(&bytes).unwrap()
    }
    pub(crate) fn pipe() -> (ParentWriter, UnixStream) {
        let (parent, engine) = UnixStream::pair().unwrap();
        parent.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        (ParentWriter::new(native::PrivateOutput::new(engine.into()).unwrap()), parent)
    }
    fn read_message(parent: &mut UnixStream) -> serde_json::Value {
        let mut bytes = Vec::new();
        let mut byte = [0u8; 1];
        while parent.read(&mut byte).unwrap() == 1 && byte[0] != b'\n' { bytes.push(byte[0]); }
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn the_parents_blob_comes_back_and_every_keep_hands_it_the_whole_blob() {
        let mut sent = launch(Some(br#"{"synthetic_first":"synthetic-kept-value"}"#));
        let (_, kept) = sent.take_owner_and_kept();
        let (writer, mut parent) = pipe();
        let held = ParentKept::from_launch(kept, writer, BOOT);
        assert_eq!(held.read("synthetic_first").unwrap().unwrap().as_str(), "synthetic-kept-value");
        assert!(held.read("synthetic_second").unwrap().is_none());
        held.keep("synthetic_second", "synthetic-second-value").unwrap();
        let frame = read_message(&mut parent);
        assert_eq!((frame["version"].as_str(), frame["operation"].as_str(), frame["boot_id"].as_str()),
            (Some(native::KEPT_VERSION), Some("keep"), Some(BOOT)));
        use base64::Engine as _;
        let blob = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(frame["kept"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&blob).unwrap(),
            serde_json::json!({"synthetic_first": "synthetic-kept-value", "synthetic_second": "synthetic-second-value"}));
        // The parent sends this blob back as the next launch's `kept`, and the same values are held there.
        let (_, again) = launch(Some(&blob)).take_owner_and_kept();
        let (writer, _parent) = pipe();
        let next = ParentKept::from_launch(again, writer, BOOT);
        assert_eq!(next.read("synthetic_second").unwrap().unwrap().as_str(), "synthetic-second-value");
    }

    #[test]
    fn an_unreadable_blob_is_nothing_kept_and_a_closed_parent_keeps_nothing() {
        let (_, kept) = launch(Some(b"not a blob")).take_owner_and_kept();
        let (writer, parent) = pipe();
        let held = ParentKept::from_launch(kept, writer, BOOT);
        assert!(held.read("synthetic_first").unwrap().is_none());
        drop(parent);
        assert!(held.keep("synthetic_first", "synthetic-kept-value").is_err(), "a parent that is gone stores nothing");
        // Still held here for this launch.
        assert_eq!(held.read("synthetic_first").unwrap().unwrap().as_str(), "synthetic-kept-value");
    }

    /// The engine's own computer key (`ParentKept::computer_key`): with none in the blob a new one is made and handed to
    /// the app in a keep message beside what it kept; the blob it sends back at the next launch gives the same key, so the
    /// same computer id; a kept key that is not a computer key is refused, never replaced by a new one.
    #[test]
    fn the_engines_computer_key_is_made_once_kept_by_the_app_and_the_same_at_the_next_launch() {
        use base64::Engine as _;
        let id = |key: &crate::secrets::secrets_key::ComputerKey| crate::account::computers::ComputerSigner::of(key).unwrap().computer_id();
        let blob = format!(r#"{{"vault_root":"{}"}}"#, root_text('c'));
        let (_, kept) = launch(Some(blob.as_bytes())).take_owner_and_kept();
        let (writer, mut parent) = pipe();
        let held = ParentKept::from_launch(kept, writer, BOOT);
        let first = held.computer_key().unwrap();
        let frame = read_message(&mut parent);
        let handed = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(frame["kept"].as_str().unwrap()).unwrap();
        let handed: serde_json::Value = serde_json::from_slice(&handed).unwrap();
        assert_eq!(handed["vault_root"].as_str(), Some(root_text('c').as_str()), "the rest of the blob is handed back with it");
        let text = handed[COMPUTER_KEY].as_str().unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(text).unwrap().len(),
            crate::secrets::secrets_key::computer_key_bytes().unwrap());
        // Asked again in the same launch: the same key, nothing handed again.
        assert_eq!(id(&held.computer_key().unwrap()), id(&first));
        // The next launch, with the blob the app kept: the same computer.
        let (_, again) = launch(Some(&serde_json::to_vec(&handed).unwrap())).take_owner_and_kept();
        let (writer, _parent) = pipe();
        let next = ParentKept::from_launch(again, writer, BOOT);
        assert_eq!(id(&next.computer_key().unwrap()), id(&first));
        // Another launch with no key makes another computer.
        let (writer, _parent) = pipe();
        assert_ne!(id(&ParentKept::from_launch(None, writer, BOOT).computer_key().unwrap()), id(&first));
        // A kept key that is not one stops this computer's part: no new id is made over it.
        for broken in [r#"{"computer_key":"not base64!"}"#, r#"{"computer_key":"AAAA"}"#] {
            let (_, kept) = launch(Some(broken.as_bytes())).take_owner_and_kept();
            let (writer, _parent) = pipe();
            assert!(ParentKept::from_launch(kept, writer, BOOT).computer_key().is_err(), "{broken}");
        }
    }

    fn root_text(fill: char) -> String {
        format!("nm_{}", fill.to_string().repeat(64))
    }

    #[test]
    fn the_vault_root_comes_from_the_app_and_the_one_kept_before_is_read_once_and_handed_over() {
        // The app sent its root back: used as it is, nothing read from the computer, nothing handed over.
        let blob = format!(r#"{{"vault_root":"{}"}}"#, root_text('a'));
        let (_, kept) = launch(Some(blob.as_bytes())).take_owner_and_kept();
        let (writer, _parent) = pipe();
        let held = ParentKept::from_launch(kept, writer, BOOT);
        let root = held.vault_root(|| panic!("a root the app sent is never looked for")).unwrap();
        assert_eq!(root.kept_text(), root_text('a'));
        // The app sent none: the root kept before is read once and handed to the app in a keep frame.
        let (writer, mut parent) = pipe();
        let held = ParentKept::from_launch(None, writer, BOOT);
        let root = held.vault_root(|| Ok(Some(crate::secrets::SecretsKey::new(Zeroizing::new(root_text('b'))).unwrap()))).unwrap();
        assert_eq!(root.kept_text(), root_text('b'));
        let frame = read_message(&mut parent);
        use base64::Engine as _;
        let handed = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(frame["kept"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&handed).unwrap()["vault_root"], root_text('b'));
        // None kept anywhere: a new root, handed over too.
        let (writer, mut parent) = pipe();
        let held = ParentKept::from_launch(None, writer, BOOT);
        let made = held.vault_root(|| Ok(None)).unwrap();
        assert!(made.kept_text().starts_with("nm_") && made.kept_text() != root_text('b'));
        assert!(read_message(&mut parent)["kept"].is_string());
    }

    #[test]
    fn a_broken_root_from_the_app_or_an_unreadable_one_from_before_stops_the_start() {
        let (_, kept) = launch(Some(br#"{"vault_root":"not-a-root"}"#)).take_owner_and_kept();
        let (writer, _parent) = pipe();
        assert!(ParentKept::from_launch(kept, writer, BOOT).vault_root(|| Ok(None)).is_err(), "never replaced by a new root");
        let (writer, _parent) = pipe();
        let held = ParentKept::from_launch(None, writer, BOOT);
        assert!(held.vault_root(|| Err(crate::secrets::Error::Keychain("the Keychain did not answer", crate::cause!()))).is_err(),
            "a computer whose store did not answer is not one that kept nothing");
    }

    #[tokio::test]
    async fn the_owner_page_sets_the_session_cookie_only_for_the_binding_and_only_to_this_sites_paths() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        {
            use std::{io::Write as _, os::unix::fs::OpenOptionsExt as _};
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.path().join("browser-session.key"))
                .unwrap().write_all("c".repeat(64).as_bytes()).unwrap();
        }
        let (owner, _) = launch(None).take_owner_and_kept();
        let page = owner_page(Router::new(), Arc::new(owner.unwrap()), dir.path().to_owned());
        let ask = |bearer: &str, query: Option<String>| {
            let page = page.clone();
            let mut uri = native::OWNER_PAGE_PATH.to_owned();
            if let Some(query) = query { uri = format!("{uri}?{query}"); }
            let request = Request::builder().uri(uri).header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty()).unwrap();
            async move { page.oneshot(request).await.unwrap() }
        };
        let to = |path: &str| format!("to={}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path));
        let owner = "d".repeat(64);
        let opened = ask(&owner, Some(to("/work/today?x=1"))).await;
        assert_eq!(opened.status(), StatusCode::SEE_OTHER);
        assert_eq!(opened.headers()[header::LOCATION], "/work/today?x=1");
        assert_eq!(opened.headers()[header::SET_COOKIE].to_str().unwrap(),
            format!("nm_session={}; Path=/; HttpOnly; SameSite=Strict", "c".repeat(64)));
        assert_eq!(opened.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(ask(&owner, None).await.headers()[header::LOCATION], "/");
        let refused = ask(&"e".repeat(64), Some(to("/"))).await;
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
        assert!(refused.headers().get(header::SET_COOKIE).is_none());
        for path in ["//elsewhere.example/", "https://elsewhere.example/", "/a\\b", "relative"] {
            let answer = ask(&owner, Some(to(path))).await;
            assert_eq!(answer.status(), StatusCode::BAD_REQUEST, "{path}");
            assert!(answer.headers().get(header::SET_COOKIE).is_none());
        }
        assert_eq!(ask(&owner, Some("to=e30&to=e30".into())).await.status(), StatusCode::BAD_REQUEST);
        std::fs::remove_file(dir.path().join("browser-session.key")).unwrap();
        let unready = ask(&owner, Some(to("/"))).await;
        assert_eq!(unready.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(unready.headers().get(header::SET_COOKIE).is_none());
    }

    /// The launch message exactly as the Mac app writes it (trillion-apps macos/Shared/LocalRuntimeReadiness.swift
    /// `launchFrame`: JSONSerialization with sortedKeys and withoutEscapingSlashes, then one newline; `bootID` an
    /// uppercase UUID, `owner_pid` a number, the readiness key and owner binding lowercase hex of 32 bytes, `kept` the
    /// stored blob's base64 URL text when the app has one), built byte for byte rather than through serde.
    pub(crate) fn apps_launch_message(boot: &str, origin: &str, owner_binding: &str, kept: Option<&str>) -> Vec<u8> {
        let kept = kept.map(|kept| format!(r#""kept":"{kept}","#)).unwrap_or_default();
        format!(concat!(r#"{{"boot_id":"{boot}",{kept}"origin":"{origin}","owner_binding":"{owner}","owner_pid":{pid},"#,
            r#""readiness_key":"{key}","state_identity":"{state}","version":"trillion.local-runtime-launch/v1"}}"#, "\n"),
            boot = boot, kept = kept, origin = origin, owner = owner_binding, pid = std::process::id(),
            key = "0f".repeat(32), state = "a".repeat(64)).into_bytes()
    }

    /// Each stage the Mac app's launch proof hit after trillion-rust #176 (case lead-66, the proof on the person's Mac), with
    /// the app's exact message: (1) `launch-channel:read-frame` and (2) its bound: the app may send up to its
    /// `max_frame_bytes`, 4096 (trillion-apps computer/loopback-guard.json), and a message with a full kept blob is
    /// past main's old 1024; (3) `launch-channel:parse-frame`: the app always sends `owner_binding`, which main's
    /// launch refused as an unknown field; (4) the owner page the app opens with the binding, which sets the window's cookie
    /// the app checks (LocalWorkspaceBrowserSession.swift `prepare`: one cookie, HttpOnly, SameSite Strict, Path /, no
    /// expiry, answered 303).
    #[tokio::test]
    async fn the_apps_exact_launch_message_reaches_each_launch_stage() {
        use base64::Engine as _;
        let boot = "6F9619FF-8B86-D011-B42D-00C04FC964FF";
        let origin = "http://127.0.0.1:7199";
        let owner_hex = "3c".repeat(32);
        // The blob the engine last handed the app (keep_message), stored and sent back as it was.
        let blob = serde_json::to_vec(&serde_json::json!({"vault_root": root_text('e')})).unwrap();
        let blob_text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&blob);
        // The largest blob the engine hands out (MAX_KEPT_BYTES), so the largest message the app sends.
        let full_text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(vec![b'x'; native::MAX_KEPT_BYTES]);
        let full = apps_launch_message(boot, origin, &owner_hex, Some(&full_text));
        assert!(full.len() > 1024 && full.len() <= native::MAX_LAUNCH_BYTES, "{} bytes", full.len());
        assert_eq!(native::MAX_LAUNCH_BYTES, 4096, "the app's max_frame_bytes");

        for message in [apps_launch_message(boot, origin, &owner_hex, None), apps_launch_message(boot, origin, &owner_hex, Some(&blob_text)), full.clone()] {
            // (1, 2) read-frame: one bounded line from the private stdin, as run_selected reads it.
            let (mut parent, engine) = UnixStream::pair().unwrap();
            std::io::Write::write_all(&mut parent, &message).unwrap();
            let mut input = native::PrivateInput::new(engine.into()).unwrap();
            let read = input.read_message(native::MAX_LAUNCH_BYTES, Duration::from_secs(2)).unwrap();
            assert_eq!(read.as_bytes(), &message[..]);
            // (3) parse-frame, then the owner and state checks run_selected makes next.
            let mut launch = native::Launch::parse(read.as_bytes()).unwrap();
            launch.assert_selection(&"a".repeat(64), origin).unwrap();
            let (owner, _) = launch.take_owner_and_kept();
            assert!(owner.unwrap().admits(owner_hex.as_bytes()));
        }
        // Without the owner binding (the frame main's old engine took), the launch is refused at parse-frame.
        let without = String::from_utf8(apps_launch_message(boot, origin, &owner_hex, None)).unwrap()
            .replace(&format!(r#""owner_binding":"{owner_hex}","#), "");
        assert_eq!(native::Launch::parse(without.as_bytes()).unwrap_err(), crate::cause!(native::Error::InvalidLaunch));

        // The blob comes back as it was stored.
        let mut launch = native::Launch::parse(&apps_launch_message(boot, origin, &owner_hex, Some(&blob_text))).unwrap();
        let (owner, kept) = launch.take_owner_and_kept();
        assert_eq!(kept.as_deref().map(|kept| &kept[..]), Some(&blob[..]));
        let (writer, _parent) = pipe();
        let held = Arc::new(ParentKept::from_launch(kept, writer, boot));
        assert_eq!(held.vault_root(|| panic!("a root the app sent is never looked for")).unwrap().kept_text(), root_text('e'));
        let owner = Arc::new(owner.unwrap());

        // (4) the owner page, as the app asks it (no `to`: the root), and the cookie the app accepts.
        let dir = tempfile::tempdir().unwrap();
        {
            use std::{io::Write as _, os::unix::fs::OpenOptionsExt as _};
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.path().join("browser-session.key"))
                .unwrap().write_all("c".repeat(64).as_bytes()).unwrap();
        }
        let page = owner_page(Router::new(), owner, dir.path().to_owned());
        let request = Request::builder().uri(native::OWNER_PAGE_PATH).header(header::AUTHORIZATION, format!("Bearer {owner_hex}"))
            .body(Body::empty()).unwrap();
        let answer = page.oneshot(request).await.unwrap();
        assert_eq!(answer.status(), StatusCode::SEE_OTHER);
        let cookies: Vec<_> = answer.headers().get_all(header::SET_COOKIE).iter().map(|value| value.to_str().unwrap().to_owned()).collect();
        assert_eq!(cookies, vec![format!("nm_session={}; Path=/; HttpOnly; SameSite=Strict", "c".repeat(64))]);
        assert!(!cookies[0].contains("Expires") && !cookies[0].contains("Max-Age"), "a session cookie");
    }
}
