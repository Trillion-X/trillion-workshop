// src/workspace_session.rs
//
// Purpose: Admit workspace browser requests through the selected original account owner.
// Non-Negotiable Invariants: Hash the original cookie; read fresh session and own-records policy; never mint a sign-in or use the native key as a browser credential.
// Key Concepts: One shared selected owner, original session identity, policy generation, pinned kept-store DATA, the exact local listener origin and the account's public origin.
// Security Considerations: No credential Debug/Serialize, token retention, alternate account database, authorization cache or fallback authority.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.

pub(crate) mod owner_wait;

use crate::{
    account::{self, AccountError, NativeAccountOwner},
    workspace::{
        CurrentSession, SupplyFuture, WorkspaceError, WorkspacePermit, WorkspaceRequestHead,
        WorkspaceSession,
    },
    workspace_domain::{BrowserScope, DomainContext},
};
use axum::http::{header, HeaderMap, Uri};
use content_crypto::advanced::blake3;
use serde_json::Value;
use std::{
    fmt,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

const MAX_COOKIE_BYTES: usize = 16 * 1024;
const STORE_CONTEXT: &str = "trillion 2026-09-30 kept answers store";

fn singleton<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, WorkspaceError> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .map(|v| v.to_str().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error)))
        .transpose()?;
    if values.next().is_some() {
        return Err(crate::cause!(WorkspaceError::Invalid));
    }
    Ok(value)
}

/// The hosting app window's own session cookie. A browser signed in at the account's public origin carries the sign-in
/// the account's routes's cookie (`contract().session_cookie`) instead; both name a row of the same sign-in sessions.
/// Read here, and set only by the owner page entry (native_entry parent_kept `owner_page`).
pub(crate) const WINDOW_COOKIE: &str = "nm_session";

/// Borrow the original opaque cookie only within the admitted request. The page
/// owner uses the same parser for its original per-sign-in kept-answer key.
///
/// Two cookie names can name the browser's session: the hosting app window's `nm_session` (host-only to the window's
/// local address) and the account's sign-in cookie at the public origin. A request carrying both can only have come by
/// the public origin, because the sign-in cookie is never sent to the local address; the window cookie there is a
/// stale or foreign one (the old site's, or a window from another computer), so the sign-in cookie names the session
/// and the window cookie is ignored. Before this, such a browser was refused on every request ("invalid workspace
/// request": the connect callback a person is sent back to, every page) and could not sign in again without clearing
/// cookies by hand. Two cookies of the SAME name, or any second value for one name, are still ambiguous and refuse.
pub(crate) fn browser_token(head: &WorkspaceRequestHead) -> Result<&str, WorkspaceError> {
    let raw = singleton(&head.headers, "cookie")?.ok_or(crate::cause!(WorkspaceError::Unauthorized))?;
    if raw.len() > MAX_COOKIE_BYTES {
        return Err(crate::cause!(WorkspaceError::TooLarge));
    }
    let sign_in_name = account::signed_in::settings().cookie.as_str();
    let mut window = None;
    let mut sign_in = None;
    for part in raw.split(';') {
        // Cookie values remain opaque UTF-8 bytes: no URL decoding, case folding
        // or trimming their suffix. A second value for one name is ambiguous and refuses.
        let part = part.trim_start_matches([' ', '\t']);
        for (name, slot) in [(WINDOW_COOKIE, &mut window), (sign_in_name, &mut sign_in)] {
            if let Some(value) = part.strip_prefix(name).and_then(|rest| rest.strip_prefix('=')) {
                if slot.replace(value).is_some() {
                    return Err(crate::cause!(WorkspaceError::Invalid));
                }
            }
        }
    }
    sign_in
        .or(window)
        .filter(|value| !value.is_empty())
        .ok_or(crate::cause!(WorkspaceError::Unauthorized))
}
/// The session a request's sign-in token opens: the token is checked by its signature (`account::admit_browser_token`)
/// and its session id is the BLAKE3 hex of its text.
fn session_identity(head: &WorkspaceRequestHead) -> Result<String, WorkspaceError> {
    account::admit_browser_token(browser_token(head)?).map_err(account_error)
}

/// DATA-only original per-account kept-answer name. This does not derive or
/// reveal its per-sign-in encryption key. That belongs to the actual page owner.
#[derive(Clone)]
pub struct WorkspaceSessionSettings {
    store_prefix: String,
}
impl WorkspaceSessionSettings {
    pub fn from_source(first_answers: &[u8], identity: &str) -> Result<Self, WorkspaceError> {
        if first_answers.len() > 1024 * 1024
            || identity.len() != 64
            || blake3::hash(first_answers).to_hex().as_str() != identity
        {
            return Err(crate::cause!(WorkspaceError::Integrity));
        }
        let value: Value =
            serde_json::from_slice(first_answers).map_err(|error| crate::carry_cause!(WorkspaceError::Integrity, error))?;
        let prefix = value
            .pointer("/kept/store_prefix")
            .and_then(Value::as_str)
            .filter(|prefix| {
                !prefix.is_empty()
                    && prefix.len() <= 128
                    && prefix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            })
            .ok_or(crate::cause!(WorkspaceError::Integrity))?;
        Ok(Self {
            store_prefix: prefix.to_owned(),
        })
    }
    pub fn page_store(&self, account_id: &str) -> Result<String, WorkspaceError> {
        if account_id.is_empty()
            || account_id.len() > 512
            || account_id.chars().any(char::is_control)
        {
            return Err(crate::cause!(WorkspaceError::Unauthorized));
        }
        let digest = blake3::derive_key(STORE_CONTEXT, account_id.as_bytes());
        let hash = blake3::Hash::from(digest).to_hex();
        Ok(format!("{}{}", self.store_prefix, &hash[..32]))
    }
}

/// A narrow adapter over the SAME selected account used by native
/// reconciliation. A request is admitted on `admission`: by default that same
/// owner, and in the native host a second read-only owner of the same account
/// under the same state lock (`SelectedAccount::admission_owner`), so checking a
/// browser's rights never waits behind the account's writer (a page write, a
/// long read). The account seam owns saved expiry, original @own-records gate
/// scope and fresh session/generation checks; a write is admitted again by the
/// account owner when it commits.
///
/// Current scope is the selected ordinary local browser. Look/showcase/contact
/// confirmation and renewal are not implemented here; missing owners refuse.
pub struct WorkspaceSessions<O> {
    owner: Arc<Mutex<O>>,
    /// Where a request's session is admitted (`admit`): `owner`, or an owner of the same account kept only for session checks.
    admission: Arc<Mutex<O>>,
    /// The addresses a request may come by: the local listener first, then the account's public origin when it has one.
    addresses: Vec<Address>,
    settings: WorkspaceSessionSettings,
}
/// One origin the workspace answers at: `origin` is `scheme://authority`, host and port only.
#[derive(Clone)]
struct Address {
    origin: String,
    authority: String,
    scheme: String,
}
impl<O> Clone for WorkspaceSessions<O> {
    fn clone(&self) -> Self {
        Self {
            owner: self.owner.clone(),
            admission: self.admission.clone(),
            addresses: self.addresses.clone(),
            settings: self.settings.clone(),
        }
    }
}
impl<O> fmt::Debug for WorkspaceSessions<O> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WorkspaceSessions([redacted])")
    }
}

fn account_error(error: AccountError) -> WorkspaceError {
    let cause = error.cause();
    match error {
        AccountError::BrowserInactive(_)
        | AccountError::RightsRefused(_)
        | AccountError::KeyWithdrawn(_) => WorkspaceError::Unauthorized(cause),
        AccountError::InvalidInput(_) => WorkspaceError::Invalid(cause),
        AccountError::RightsChanging(_) | AccountError::SourceChanged(_) => WorkspaceError::Conflict(cause),
        _ => WorkspaceError::Unavailable(cause),
    }
}

impl<O: NativeAccountOwner + Send + 'static> WorkspaceSessions<O> {
    /// Host compositions must retain this exact selected owner, rather than
    /// pairing one account's session checks with another account's record supply.
    pub fn has_owner(&self, owner: &Arc<Mutex<O>>) -> bool {
        Arc::ptr_eq(&self.owner, owner)
    }
    /// The owner a request is admitted on: the one a read that must not wait behind the account's writer (a page write,
    /// a long read) takes to admit and to admit again.
    pub(crate) fn admission(&self) -> Arc<Mutex<O>> {
        self.admission.clone()
    }
    /// Admit every request on `admission`, an owner of the same account that holds no writer: the host makes it with
    /// `SelectedAccount::admission_owner`, which refuses any other account.
    pub fn with_admission(mut self, admission: Arc<Mutex<O>>) -> Self {
        self.admission = admission;
        self
    }
    pub fn new(
        owner: Arc<Mutex<O>>,
        origin: &str,
        settings: WorkspaceSessionSettings,
    ) -> Result<Self, WorkspaceError> {
        let uri: Uri = origin.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        let authority = uri.authority().ok_or(crate::cause!(WorkspaceError::Invalid))?.as_str();
        let address: SocketAddr = authority.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        if uri.scheme_str() != Some("http")
            || !address.ip().is_loopback()
            || address.port() == 0
            || origin != format!("http://{authority}")
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        Ok(Self {
            admission: owner.clone(),
            owner,
            addresses: vec![Address {
                origin: origin.into(),
                authority: authority.into(),
                scheme: "http".into(),
            }],
            settings,
        })
    }

    /// Also answer at the account's public origin (`https://host[:port]`, its computer's `public_origin`), where the old
    /// Worker served the workspace (src/worker.mjs workspaceAddress): a browser signed in there is admitted by the
    /// same session rows. Any other address stays refused.
    pub fn with_public_origin(mut self, origin: &str) -> Result<Self, WorkspaceError> {
        let uri: Uri = origin.parse().map_err(|error| crate::carry_cause!(WorkspaceError::Invalid, error))?;
        let authority = uri
            .authority()
            .ok_or(crate::cause!(WorkspaceError::Invalid))?
            .as_str()
            .to_owned();
        if uri.scheme_str() != Some("https")
            || authority.contains('@')
            || origin != format!("https://{authority}")
        {
            return Err(crate::cause!(WorkspaceError::Invalid));
        }
        self.addresses.truncate(1);
        self.addresses.push(Address {
            origin: origin.into(),
            authority,
            scheme: "https".into(),
        });
        Ok(self)
    }

    /// The address a request came by, from its one Host; its Origin, when sent, and its absolute target, when given,
    /// must be that same address. Anything else is refused before any account read.
    fn address_of(&self, head: &WorkspaceRequestHead) -> Result<&Address, WorkspaceError> {
        let host = singleton(&head.headers, header::HOST.as_str())?;
        let address = self
            .addresses
            .iter()
            .find(|address| host == Some(address.authority.as_str()))
            .ok_or(crate::cause!(WorkspaceError::Forbidden))?;
        if singleton(&head.headers, header::ORIGIN.as_str())?
            .is_some_and(|origin| origin != address.origin)
            || head
                .uri
                .authority()
                .is_some_and(|v| v.as_str() != address.authority)
            || head.uri.scheme_str().is_some_and(|v| v != address.scheme)
        {
            return Err(crate::cause!(WorkspaceError::Forbidden));
        }
        Ok(address)
    }

    fn admit(
        &self,
        head: &WorkspaceRequestHead,
        permit: &WorkspacePermit,
    ) -> Result<WorkspaceSession, WorkspaceError> {
        self.admit_at(head, permit, false).inspect_err(|error| {
            crate::quiet_eprintln!("workspace-refusal path={} cause={}", head.uri.path(), error.cause());
        })
    }
    fn admit_at(
        &self,
        head: &WorkspaceRequestHead,
        permit: &WorkspacePermit,
        read_only: bool,
    ) -> Result<WorkspaceSession, WorkspaceError> {
        if permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        // A request with no sign-in names no account, whatever address it came by: it answers sign-in required.
        let id = session_identity(head)?;
        self.address_of(head)?;
        let mut owner = owner_wait::acquire(&self.admission, || permit.cancelled()).map_err(
            |error| match error {
                owner_wait::Error::Cancelled(cause) => WorkspaceError::Conflict(cause),
                owner_wait::Error::Unavailable(cause) => WorkspaceError::Unavailable(cause),
            },
        )?;
        let account = if read_only { account::current_browser_read_only(&mut *owner, &id) }
            else { account::current_browser(&mut *owner, &id) }.map_err(account_error)?.account;
        if permit.cancelled() {
            return Err(crate::cause!(WorkspaceError::Conflict));
        }
        self.settings.page_store(&account.user_id)?;
        if account.owner_id.len() != 64
            || !account
                .owner_id
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
        {
            return Err(crate::cause!(WorkspaceError::Unauthorized));
        }
        Ok(WorkspaceSession {
            account_id: account.user_id,
            session_id: id,
        })
    }

    /// Re-read the actual cookie/session/gate before a canonical request or
    /// result disclosure. A previously constructed WorkspaceSession is no grant.
    /// Resource-specific execution/commit checks still belong to the executor.
    pub fn authorize(&self, context: DomainContext) -> SupplyFuture<BrowserScope> {
        self.authorize_at(context, false)
    }
    pub(crate) fn authorize_read_only(&self, context: DomainContext) -> SupplyFuture<BrowserScope> {
        self.authorize_at(context, true)
    }
    fn authorize_at(&self, context: DomainContext, read_only: bool) -> SupplyFuture<BrowserScope> {
        let owner = self.clone();
        Box::pin(async move {
            crate::storage::request_work::spawn_blocking(move || {
                let fresh = owner.admit_at(&context.head, &context.permit, read_only)?;
                if fresh.account_id != context.session.account_id
                    || fresh.session_id != context.session.session_id
                {
                    return Err(crate::cause!(WorkspaceError::Conflict));
                }
                Ok(BrowserScope {
                    origin: owner.address_of(&context.head)?.origin.clone(),
                    page_store: owner.settings.page_store(&fresh.account_id)?,
                    read_only: false,
                })
            })
            .await
            .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?
        })
    }
}
impl<O: NativeAccountOwner + Send + 'static> CurrentSession for WorkspaceSessions<O> {
    fn current(
        &self,
        head: WorkspaceRequestHead,
        permit: WorkspacePermit,
    ) -> SupplyFuture<WorkspaceSession> {
        let owner = self.clone();
        Box::pin(async move {
            crate::storage::request_work::spawn_blocking(move || owner.admit(&head, &permit))
                .await
                .map_err(|error| crate::carry_cause!(WorkspaceError::Unavailable, error))?
        })
    }
    fn origin_of(&self, head: &WorkspaceRequestHead) -> Option<String> {
        self.address_of(head)
            .ok()
            .map(|address| address.origin.clone())
    }
}
