// Purpose: reconcile an existing Mac credential through its original account,
// browser, addressed AccountControl gates and native-key root owner.
// Invariants: no new account, nonce, key, auth database or permissive fallback;
// current source, session, rights, generation and publications are rechecked.
// Key concepts: original issuer binding, full native-resource reach, current
// policy epoch, protected purpose-bound root and private account reply.
// Security: secret buffers zeroize and have redacted Debug; only the existing
// private native writer serializes a key. Missing current owners refuse.
// Source owners: native-account-key.mjs, native-account-key-issuance.mjs,
// derived-keys.mjs, account-control-state.mjs and credential-file.mjs in the
// existing Trillion owner. This module does not replace their persistent state.
//! Existing-credential reconciliation, independent of physical account storage.
//! A NativeCatalog proves snapshot identity, not current account rights. A host
//! must supply a live NativeAccountOwner; a historical reader alone is not one.

pub mod account_routes;
pub mod computers;
pub mod create;
pub(crate) mod erase;
// The account routes for AI harness hooks and the command a harness config runs (src/account/hooks.json).
pub(crate) mod devices;
pub(crate) mod rows;
pub(crate) mod signed_in;
pub mod person_present;
pub mod hooks;

use content_crypto::advanced::blake3;
use serde_json::Value;
use std::{collections::BTreeMap, fmt, sync::Arc};
use zeroize::Zeroizing;

pub const NATIVE_RESOURCE: &str = "@native-account";
pub const BROWSER_RESOURCE: &str = "@own-records";
pub const NATIVE_ROOT_NAME: &str = "NATIVE_KEY_DERIVATION_ROOT";
const NATIVE_CONTEXT: &str = "trillion native-browser-key v1";
const MAX_SAFE_TIME: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AccountError {
    InvalidInput(crate::refusal_cause::Cause),
    SourceUnavailable(crate::refusal_cause::Cause),
    SourceChanged(crate::refusal_cause::Cause),
    /// The read's own cancellation (its caller went away or stopped it), not a change to the source.
    Cancelled(crate::refusal_cause::Cause),
    /// The read's deadline passed before its last check, not a change to the source.
    DeadlineElapsed(crate::refusal_cause::Cause),
    BrowserInactive(crate::refusal_cause::Cause),
    RightsRefused(crate::refusal_cause::Cause),
    RightsChanging(crate::refusal_cause::Cause),
    KeyWithdrawn(crate::refusal_cause::Cause),
    OriginalBindingUnavailable(crate::refusal_cause::Cause),
    RecoveryPending(crate::refusal_cause::Cause),
    AlreadyIssued(crate::refusal_cause::Cause),
    RootUnavailable(crate::refusal_cause::Cause),
    /// The record read names a kind that stays on this computer, to a caller that is not running here.
    DeviceOnly(crate::refusal_cause::Cause),
    /// A records filter that no declared order narrows asked to read a kind too large to read row by row.
    WholeKind(crate::refusal_cause::Cause),
    /// The key's sign-in use note is due for the first time or its row is not settled, and this owner writes none:
    /// the account's own owner admits it.
    UseNoteRequired(crate::refusal_cause::Cause),
}
impl AccountError {
    /// Static construction site and condition; never caller input or private values.
    pub fn cause(&self) -> crate::refusal_cause::Cause { self.cause_ref().clone() }
    /// The same original cause, borrowed for standard error-source chains.
    pub fn cause_ref(&self) -> &crate::refusal_cause::Cause {
        match self {
            Self::InvalidInput(cause) => cause,
            Self::SourceUnavailable(cause) => cause,
            Self::SourceChanged(cause) => cause,
            Self::Cancelled(cause) => cause,
            Self::DeadlineElapsed(cause) => cause,
            Self::BrowserInactive(cause) => cause,
            Self::RightsRefused(cause) => cause,
            Self::RightsChanging(cause) => cause,
            Self::KeyWithdrawn(cause) => cause,
            Self::OriginalBindingUnavailable(cause) => cause,
            Self::RecoveryPending(cause) => cause,
            Self::AlreadyIssued(cause) => cause,
            Self::RootUnavailable(cause) => cause,
            Self::DeviceOnly(cause) => cause,
            Self::WholeKind(cause) => cause,
            Self::UseNoteRequired(cause) => cause,
        }
    }
}
crate::impl_caused!(AccountError);

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let words = match self {
            Self::InvalidInput(_) => "native account input refused",
            Self::SourceUnavailable(_) => "original account source unavailable",
            Self::SourceChanged(_) => "original account source changed",
            Self::Cancelled(_) => "the read was cancelled",
            Self::DeadlineElapsed(_) => "the read's deadline elapsed",
            Self::BrowserInactive(_) => "original browser sign-in inactive",
            Self::RightsRefused(_) => "current account rights refused",
            Self::RightsChanging(_) => "current account rights changing",
            Self::KeyWithdrawn(_) => "original Mac credential withdrawn or changed",
            Self::OriginalBindingUnavailable(_) => "original Mac issuer binding unavailable",
            Self::RecoveryPending(_) => "original Mac publication requires owner recovery",
            Self::AlreadyIssued(_) => "original Mac credential reveal window ended",
            Self::RootUnavailable(_) => "original native-key root unavailable",
            Self::DeviceOnly(_) => "a kind of record that stays on this computer",
            Self::WholeKind(_) => "a filter that would read every row of a large kind",
            Self::UseNoteRequired(_) => "a sign-in use note only the account's own owner writes",
        };
        write!(f, "{words}; cause={}", self.cause().id())
    }
}
impl std::error::Error for AccountError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(self.cause_ref()) }
}
pub type AccountResult<T> = Result<T, AccountError>;

fn hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[cfg(test)]
fn timestamp(value: &Value) -> AccountResult<u64> {
    if let Some(at) = value.as_u64() {
        return (at > 0 && at <= MAX_SAFE_TIME)
            .then_some(at)
            .ok_or(crate::cause!(AccountError::InvalidInput));
    }
    let at =
        chrono::DateTime::parse_from_rfc3339(value.as_str().ok_or(crate::cause!(AccountError::InvalidInput))?)
            .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?
            .timestamp_millis();
    u64::try_from(at)
        .ok()
        .filter(|at| *at > 0 && *at <= MAX_SAFE_TIME)
        .ok_or(crate::cause!(AccountError::InvalidInput))
}
fn bounded_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
}

/// An input held by the existing Mac/Keychain owner, never a minted credential.
pub struct SecretNativeKey(Zeroizing<String>);
impl fmt::Debug for SecretNativeKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretNativeKey([redacted])")
    }
}
impl SecretNativeKey {
    pub fn parse(text: &str) -> AccountResult<Self> {
        // Two shapes are held: `nm_` + the account address + `_` + 64 hex, and `nm_` + 64 hex, the key the app already
        // holds and the secrets key of a vault keyed from it (src/secrets.rs, src/secrets/root.rs). Holding a key is not
        // signing in: who is signed in is only ever a checked JWT (`account/signed_in.rs`).
        let Some(rest) = text.strip_prefix("nm_") else { return Err(crate::cause!(AccountError::InvalidInput)) };
        let addressed = rest.split_at_checked(crate::account::rows::tokens::OWNER_HEX_LEN).is_some_and(|(address, secret)| {
            crate::account::rows::tokens::owner_text_ok(address) && secret.strip_prefix('_').is_some_and(|secret| hex(secret, 64))
        });
        if !addressed && !hex(rest, 64) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        Ok(Self(Zeroizing::new(text.to_owned())))
    }
    pub fn identity(&self) -> String {
        blake3::hash(self.0.as_bytes()).to_hex().to_string()
    }
}

/// Original logical account identity; the source adapter preserves both IDs.
#[derive(Clone, PartialEq, Eq)]
pub struct AccountIdentity {
    pub user_id: String,
    pub owner_id: String,
}
impl fmt::Debug for AccountIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AccountIdentity([redacted])")
    }
}

/// Supplied by the existing purpose-root owner. It must verify its current
/// original source/root generation on each derivation. It exposes no root getter.
pub trait NativeKeyDeriver {
    fn derive_existing(
        &self,
        account: &AccountIdentity,
        original_nonce: &str,
    ) -> AccountResult<SecretNativeKey>;
}

/// Pure purpose-bound cryptography. The physical root/vault owner holds this
/// value and wraps it with its actual current-source checks before supplying
/// NativeKeyDeriver. This value by itself is not current account authority.
pub struct NativeKeyDerivationRoot {
    account: AccountIdentity,
    root: Zeroizing<[u8; 32]>,
}
impl fmt::Debug for NativeKeyDerivationRoot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeKeyDerivationRoot([redacted])")
    }
}
impl NativeKeyDerivationRoot {
    pub fn from_original_root(
        account: AccountIdentity,
        root: Zeroizing<[u8; 32]>,
    ) -> AccountResult<Self> {
        if !hex(&account.owner_id, 64) || !bounded_id(&account.user_id) {
            return Err(crate::cause!(AccountError::RootUnavailable));
        }
        Ok(Self { account, root })
    }
    pub fn derive_existing(
        &self,
        account: &AccountIdentity,
        nonce: &str,
    ) -> AccountResult<SecretNativeKey> {
        if account != &self.account || !hex(nonce, 32) {
            return Err(crate::cause!(AccountError::RootUnavailable));
        }
        let subkey = Zeroizing::new(blake3::derive_key(NATIVE_CONTEXT, &self.root[..]));
        let message = Zeroizing::new(
            serde_json::to_vec(&[account.owner_id.as_str(), account.user_id.as_str(), nonce])
                .map_err(|error| crate::carry_cause!(AccountError::InvalidInput, error))?,
        );
        let digest = blake3::keyed_hash(&subkey, &message);
        let text = Zeroizing::new(format!("nm_{}_{}", account.owner_id, digest.to_hex()));
        SecretNativeKey::parse(&text)
    }
}

/// A computer credential returned only over the admitted native parent pipe.
/// Its bytes remain zeroizing; only its BLAKE3 identity is public metadata.
pub struct SecretResourceKey(Zeroizing<String>);
impl fmt::Debug for SecretResourceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretResourceKey([redacted])")
    }
}
impl SecretResourceKey {
    pub(crate) fn parse(value: Zeroizing<String>) -> AccountResult<Self> {
        if !value.strip_prefix("tc_").is_some_and(|text| hex(text, 64)) {
            return Err(crate::cause!(AccountError::InvalidInput));
        }
        Ok(Self(value))
    }
    pub(crate) fn text(&self) -> &str {
        &self.0
    }
    pub(crate) fn identity(&self) -> String {
        blake3::hash(self.0.as_bytes()).to_hex().to_string()
    }
}

/// Read from the addressed gate's current original state owner, including its
/// policy/pause and authoritative sign-in-use owner. No gate is prefilled here.
pub struct NativeGateView {
    pub owner_id: String,
    pub gate_name: String,
    pub snapshot: Value,
    pub epoch: u64,
    pub updating: bool,
    pub paused: bool,
    pub authoritative_last_used: Option<String>,
}
impl fmt::Debug for NativeGateView {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeGateView([redacted])")
    }
}

/// The host's existing mounted account/authority owner supplies exact reads.
/// Every method must check its original source generation and scope. A bare
/// immutable NativeCatalog or restored historical policy cannot implement fresh
/// authority by asserting it is current. No default/allow-all implementation.
pub trait NativeAccountOwner {
    fn account(&self) -> AccountIdentity;
    fn now_ms(&mut self) -> AccountResult<u64>;
    fn assert_source_current(&mut self) -> AccountResult<()>;
    /// An admitted native host may enroll its computer through the same account.
    /// Suppliers without the current writable owner keep this capability absent.
    fn resource_connection_key(
        &mut self,
        _session_id: &str,
        _held: &SecretNativeKey,
    ) -> AccountResult<Option<SecretResourceKey>> {
        Ok(None)
    }
}

/// The window's own browser session, as the sign-in admits it now. `current`
/// asks the sign-in whether that session row is still live (not removed, not
/// expired), so every pause that held this admission asks it again.
#[derive(Clone)]
pub struct BrowserAdmission {
    pub account: AccountIdentity,
    pub current: crate::account::account_routes::Current,
}
impl BrowserAdmission {
    /// Whether the window's session row is still live in the sign-in now.
    pub fn still(&self) -> bool {
        (self.current)()
    }
    /// Whether `other` is this same window, both admissions still live.
    pub fn same_as(&self, other: &Self) -> bool {
        self.account == other.account && self.still() && other.still()
    }
}

/// The browser sessions a verified sign-in token admitted in this process (`admit_browser_token`): the session id (the
/// BLAKE3 hex of the token) to the account address the token names, its sign-in name and when it expires. The token is
/// checked once, by its signature (`signed_in`); every later check of the session reads this, so a session ends when
/// its token expires. Nothing is written: a restart forgets every session, which only refuses.
struct BrowserSession {
    address: String,
    sign_in: String,
    expires_at_ms: u64,
    fresh: bool,
    admitted_at_ms: u64,
    issued_at_ms: Option<u64>,
}

/// The most browser sessions one process keeps at once (each lives until its token expires).
const MOST_BROWSER_SESSIONS: usize = 4096;

fn browser_sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, BrowserSession>> {
    static SESSIONS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, BrowserSession>>> = std::sync::OnceLock::new();
    SESSIONS.get_or_init(Default::default)
}

/// Check the sign-in token a browser presented and keep its session: answers the session id. A token that does not
/// check is refused; nothing is kept for it.
pub(crate) fn admit_browser_token(token: &str) -> AccountResult<String> {
    let principal = crate::account::signed_in::verify(token).map_err(|refused| match refused {
        crate::account::signed_in::Refused::Invalid(cause) => AccountError::BrowserInactive(cause),
        crate::account::signed_in::Refused::KeysUnavailable(cause) => AccountError::SourceUnavailable(cause),
    })?;
    let id = blake3::hash(token.as_bytes()).to_hex().to_string();
    let now = crate::account::rows::now_ms();
    let mut sessions = browser_sessions().lock().map_err(|error| crate::carry_cause!(AccountError::SourceUnavailable, error))?;
    sessions.retain(|_, session| session.expires_at_ms > now);
    if sessions.len() >= MOST_BROWSER_SESSIONS && !sessions.contains_key(&id) {
        return Err(crate::cause!(AccountError::SourceUnavailable));
    }
    let fresh = principal.fresh();
    sessions.insert(id.clone(), BrowserSession { address: principal.account, sign_in: principal.sign_in,
        expires_at_ms: principal.expires_at_ms, fresh, admitted_at_ms: now, issued_at_ms: principal.issued_at_ms });
    Ok(id)
}

/// Whether session `session_id` is live and its pass was issued within Better Auth's fresh-session age: the person is
/// present (`account::person_present`).
pub(crate) fn browser_session_fresh(session_id: &str) -> bool {
    let now = crate::account::rows::now_ms();
    let age = crate::account::signed_in::settings().fresh_age_seconds.saturating_mul(1000);
    browser_sessions().lock().ok().and_then(|sessions| sessions.get(session_id).map(|session| {
        session.expires_at_ms > now && session.fresh
            && session.issued_at_ms.is_some_and(|at| now.saturating_sub(at) <= age)
            && now.saturating_sub(session.admitted_at_ms) <= age.saturating_add(age)
    })).unwrap_or(false)
}

/// The sign-in name of session `session_id` when it is live now and names the account at `address`.
fn browser_session_live(session_id: &str, address: &str) -> Option<String> {
    let now = crate::account::rows::now_ms();
    let sessions = browser_sessions().lock().ok()?;
    sessions.get(session_id).filter(|session| session.expires_at_ms > now && session.address == address).map(|session| session.sign_in.clone())
}

/// Ends session `session_id`, as when its token is gone.
#[cfg(test)]
pub(crate) fn end_browser_session_for_tests(session_id: &str) {
    browser_sessions().lock().unwrap().remove(session_id);
}

/// Makes session `session_id` expired, as when its token's time ran out.
#[cfg(test)]
pub(crate) fn expire_browser_session_for_tests(session_id: &str) {
    if let Some(session) = browser_sessions().lock().unwrap().get_mut(session_id) {
        session.expires_at_ms = 1;
    }
}

/// The window's own browser session, admitted now: a session a verified sign-in token opened for this account
/// (`admit_browser_token`) and whose token has not expired. No gate, generation or policy epoch.
pub fn current_browser(
    owner: &mut impl NativeAccountOwner,
    session_id: &str,
) -> AccountResult<BrowserAdmission> {
    current_browser_at(owner, session_id).map(|(admission, _)| admission)
}

/// The same current browser admission (a session is never slid or made by a check).
pub(crate) fn current_browser_read_only(
    owner: &mut impl NativeAccountOwner,
    session_id: &str,
) -> AccountResult<BrowserAdmission> {
    current_browser_at(owner, session_id).map(|(admission, _)| admission)
}

/// The source a page's browser session stands for when a delivered tool answer is recovered: who the session's sign-in
/// is on this account, never its token.
pub(crate) fn browser_recovery_source(
    owner: &mut impl NativeAccountOwner,
    session_id: &str,
) -> AccountResult<(BrowserAdmission, Value)> {
    let (admission, sign_in) = current_browser_at(owner, session_id)?;
    let name = browser_session_live(session_id, sign_in.address()).ok_or(crate::cause!(AccountError::BrowserInactive))?;
    let mut scopes = crate::account::signed_in::settings().person_scopes.clone();
    scopes.sort();
    scopes.dedup();
    let source = serde_json::json!({"account": sign_in.account(), "address": sign_in.address(),
        "source": {"sign_in": name, "account": sign_in.address(), "effective_scopes": scopes}});
    owner.assert_source_current()?;
    if owner.account() != admission.account || !admission.still() {
        return Err(crate::cause!(AccountError::SourceChanged));
    }
    Ok((admission, source))
}

fn current_browser_at(
    owner: &mut impl NativeAccountOwner,
    session_id: &str,
) -> AccountResult<(BrowserAdmission, Arc<crate::account::account_routes::SignIn>)> {
    if !hex(session_id, 64) {
        return Err(crate::cause!(AccountError::InvalidInput));
    }
    owner.assert_source_current()?;
    let account = owner.account();
    let sign_in = crate::account::account_routes::opened_for(&account.user_id)
        .ok_or(crate::cause!(AccountError::BrowserInactive))?;
    if browser_session_live(session_id, sign_in.address()).is_none() {
        return Err(crate::cause!(AccountError::BrowserInactive));
    }
    owner.assert_source_current()?;
    let (id, retained) = (session_id.to_owned(), sign_in.clone());
    let current: crate::account::account_routes::Current =
        Arc::new(move || browser_session_live(&id, sign_in.address()).is_some());
    Ok((BrowserAdmission { account, current }, retained))
}

/// The key of the app that runs trillion-local, the parent a computer key was enrolled under. Personal keys left the
/// engine with sign-in (Better Auth Workshop tool, Nov 13 2026), so no such key is live: refused, failing closed.
pub(crate) fn native_parent_key_current(
    owner: &mut impl NativeAccountOwner,
    _digest: &str,
) -> AccountResult<()> {
    owner.assert_source_current()?;
    Err(crate::cause!(AccountError::KeyWithdrawn))
}

/// Where the hosting app's own secrets are kept: the blob the app stores for the program that launched with it
/// (native_entry parent_kept). A read that cannot answer is an error, never "nothing kept".
pub(crate) trait KeptSecrets {
    fn read(&self, name: &str) -> AccountResult<Option<Zeroizing<String>>>;
    fn keep(&self, name: &str, value: &str) -> AccountResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use std::time::Duration;
    fn now() -> u64 {
        timestamp(&json!("2026-10-25T21:00:00.000Z")).unwrap()
    }
    /// The owner id the test account has (`Fixture::new`).
    fn test_owner() -> String {
        blake3::hash(b"synthetic-original-owner")
            .to_hex()
            .to_string()
    }
    fn held() -> SecretNativeKey {
        SecretNativeKey::parse(&format!(
            "nm_{}_{}",
            test_owner(),
            blake3::hash(b"SYNTHETIC_TEST_CREDENTIAL_ONLY").to_hex()
        ))
        .unwrap()
    }
    struct Fixture {
        account: AccountIdentity,
        source_current: bool,
        clock: u64,
    }
    impl Fixture {
        fn new() -> Self {
            let account = AccountIdentity {
                user_id: "synthetic-account-user".into(),
                owner_id: blake3::hash(b"synthetic-original-owner")
                    .to_hex()
                    .to_string(),
            };
            Self {
                account,
                source_current: true,
                clock: now(),
            }
        }
    }
    impl NativeAccountOwner for Fixture {
        fn account(&self) -> AccountIdentity {
            self.account.clone()
        }
        fn now_ms(&mut self) -> AccountResult<u64> {
            Ok(self.clock)
        }
        fn assert_source_current(&mut self) -> AccountResult<()> {
            if self.source_current {
                Ok(())
            } else {
                Err(crate::cause!(AccountError::SourceChanged))
            }
        }
    }

    #[test]
    fn actual_native_host_uses_the_existing_account_fixture_answers_no_old_account_message_and_stops_on_parent_eof(
    ) {
        use std::{
            io::{Read, Write},
            net::{TcpListener, TcpStream},
            os::unix::net::UnixStream,
            sync::mpsc,
            thread,
        };
        let owner = Fixture::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let state = "a".repeat(64);
        let boot = "synthetic-host-account-boot";
        let launch = serde_json::to_string(&json!({"version":crate::native::LAUNCH_VERSION,
            "boot_id":boot,"state_identity":state,"origin":origin,
            "owner_pid":std::process::id(),"readiness_key":"b".repeat(64),"owner_binding":"d".repeat(64)}))
        .unwrap()
            + "\n";
        let launch = crate::native::Launch::parse(launch.as_bytes()).unwrap();
        let (mut parent_input, child_input) = UnixStream::pair().unwrap();
        let (child_output, mut parent_output) = UnixStream::pair().unwrap();
        parent_output
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        let (finished, result) = mpsc::sync_channel(1);
        let host = thread::spawn(move || {
            // Construct the mount in the host thread; no extra authority fixture
            // or alternate owner is introduced for this composition control.
            let mount = crate::native_host::AccountMount {
                owner,
                state_identity: state,
                host_events: None,
            };
            let served = crate::native_host::serve(
                listener,
                launch,
                crate::native::PrivateInput::new(child_input.into()).unwrap(),
                crate::native::PrivateOutput::new(child_output.into()).unwrap(),
                mount,
                axum::Router::new(),
            );
            finished.send(served).unwrap();
        });
        // The app keeps no key through this pipe any more: an old account request is let go, unanswered.
        let request =
            serde_json::to_string(&json!({"operation":"native-account-key","boot_id":boot,
            "request_id":"c".repeat(64),"key":held().0.as_str()}))
            .unwrap()
                + "\n";
        parent_input.write_all(request.as_bytes()).unwrap();
        let mut byte = [0u8; 1];
        assert!(
            parent_output.read(&mut byte).is_err(),
            "the host answered an account request"
        );
        let mut readiness = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
        readiness
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            readiness,
            "GET {} HTTP/1.1\r\nHost: {address}\r\n{}: {}\r\nConnection: close\r\n\r\n",
            crate::native::READINESS_PATH,
            crate::native::CHALLENGE_HEADER,
            "d".repeat(64)
        )
        .unwrap();
        let mut response = String::new();
        readiness.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        let proof: Value =
            serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(proof["workspace_qualified"], false);
        assert_eq!(proof["origin"], origin);
        drop(readiness);
        drop(parent_input);
        assert!(result.recv_timeout(Duration::from_secs(6)).unwrap().is_ok());
        host.join().unwrap();
        assert!(TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_err());
    }
}

#[cfg(test)]
mod stop_reason_tests {
    use super::AccountError;

    /// A read that stopped at its own cancel or deadline names that stop; it does not claim the source changed.
    #[test]
    fn a_read_stopped_by_its_cancel_or_deadline_names_that_stop() {
        let cancelled = AccountError::Cancelled(crate::cause!());
        let elapsed = AccountError::DeadlineElapsed(crate::cause!());
        assert_eq!(cancelled.to_string().split(';').next(), Some("the read was cancelled"));
        assert_eq!(elapsed.to_string().split(';').next(), Some("the read's deadline elapsed"));
        assert!(!cancelled.to_string().contains("source changed") && !elapsed.to_string().contains("source changed"));
    }
}
