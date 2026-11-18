//! OAuth 2.1 for AI apps, strictly to the standards and nothing else:
//! RFC 8414 metadata, RFC 7591 dynamic client registration (public clients,
//! `token_endpoint_auth_method: none`), authorization code with S256 PKCE only
//! (RFC 7636; `plain` refused), refresh token rotation (a used refresh token is
//! refused and revokes its grant), RFC 7009 revocation, and the bearer check
//! the MCP door calls. Redirect URIs: `https` anywhere, `http` only for
//! loopback hosts (RFC 8252 §7.3), private-use schemes (RFC 8252 §7.1) that
//! contain a dot; exact string match at /authorize. No CORS echo: the forwarder
//! decides CORS. Codes issued by the account routes carry `<address>.<random_text(32)>` for root token routing,
//! and are stored by `sha256_hex` of the whole text, just like access and refresh tokens.
//! Access and refresh tokens are `<address>.<random_text(32)>`, stored by
//! `sha256_hex` of the whole text, so the forwarder reads the account's address with no lookup.
//!
//! Stored values (the `value` JSON of each family), owned by this file:
//! - clients:  `Client`
//! - grants:   `Grant` (one per client per account; revoked = removed)
//! - tokens:   `Token` (kind code | access | refresh, and the spent markers
//!   used-code | used-refresh), id = sha256_hex(secret)
//! - requests: `Request` (an /authorize waiting for the person), id = random_hex(16)

use super::store::{Family, Row, Store};
use super::tokens::{self, pkce_s256_matches, random_hex, random_text, sha256_hex};
use super::{now_ms, contract, computer, Error, Principal, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Client {
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub created_at: u64,
    /// The client's id was chosen by the account's owner and published, not made at registration (`add_fixed`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fixed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Grant {
    pub client_id: String,
    pub scopes: Vec<String>,
    pub created_at: u64,
    /// How the person approved it: the way the approving session started by ("passkey", "window" or a way's name),
    /// or the key way that approved it; none on a grant made before this was kept. Read by `calls.rs` to pick the
    /// grant's tier (old trillion src/sign-in-calls.json:9 `approved_by`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Token {
    /// "code", "access" or "refresh"; "used-code" or "used-refresh" once spent.
    pub kind: String,
    pub grant_id: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    /// For a code: the redirect URI and S256 challenge it was issued for.
    pub redirect_uri: Option<String>,
    pub code_challenge: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Request {
    pub client_id: String,
    pub redirect_uri: String,
    pub state: Option<String>,
    pub scopes: Vec<String>,
    pub code_challenge: String,
}

const CODE: &str = "code";
const ACCESS: &str = "access";
const REFRESH: &str = "refresh";
/// A spent code, kept until the code's own expiry so a second presentation is
/// recognised as reuse (RFC 6749 §4.1.2) instead of as an unknown code.
const USED_CODE: &str = "used-code";
/// A rotated refresh token, kept until its own expiry so a second presentation
/// is recognised as reuse (OAuth 2.1 §4.3.1) and revokes the grant.
const USED_REFRESH: &str = "used-refresh";
/// How a principal names the OAuth grant it signs in as: `grant:<grant id>`.
pub(crate) const GRANT_SIGN_IN: &str = "grant:";
const CLIENT_NAME_DEFAULT: &str = "AI app";
const CLIENT_NAME_MAX: usize = 200;
const STATE_MAX: usize = 1024;
const GRANT_TYPES: [&str; 2] = ["authorization_code", "refresh_token"];
const RESPONSE_TYPES: [&str; 1] = ["code"];

/// The RFC 8414 metadata document for `origin` (e.g. "https://host").
pub(crate) fn metadata(origin: &str) -> Value {
    json!({
        "issuer": origin,
        "authorization_endpoint": format!("{origin}/authorize"),
        "token_endpoint": format!("{origin}/oauth/token"),
        "registration_endpoint": format!("{origin}/oauth/register"),
        "revocation_endpoint": format!("{origin}/oauth/revoke"),
        "response_types_supported": RESPONSE_TYPES,
        "grant_types_supported": GRANT_TYPES,
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": contract().scopes,
    })
}

#[derive(Deserialize)]
struct Registration {
    redirect_uris: Option<Vec<String>>,
    client_name: Option<String>,
    token_endpoint_auth_method: Option<String>,
    grant_types: Option<Vec<String>>,
    response_types: Option<Vec<String>>,
}

/// RFC 7591 registration from the request's JSON `body`. Answers the 201 body.
pub(crate) fn register(store: &Store<'_>, account: &str, body: &[u8]) -> Result<Value> {
    let answer = registration(body)?;
    let client_id = answer["client_id"].as_str().expect("registration id");
    store.insert(Family::Clients, &Row {
        id: client_id.to_owned(), account: account.to_owned(), expires_at: 0,
        value: Client { client_name: answer["client_name"].as_str().unwrap().to_owned(),
            redirect_uris: serde_json::from_value(answer["redirect_uris"].clone()).unwrap(),
            created_at: answer["client_id_issued_at"].as_u64().unwrap(), fixed: false },
    })?;
    Ok(answer)
}

fn registration(body: &[u8]) -> Result<Value> {
    if body.len() > computer().max_body_bytes {
        return Err(crate::cause!(Error::TooLarge));
    }
    let form: Registration = serde_json::from_slice(body)
        .map_err(|error| Error::InvalidClientMetadata("the body is not registration metadata", crate::refusal_cause::Caused::stored_cause(&error).unwrap_or_else(|| crate::cause!())))?;

    let redirect_uris = form.redirect_uris.unwrap_or_default();
    if redirect_uris.is_empty() {
        return Err(crate::cause!(Error::InvalidRedirectUri));
    }
    for (index, uri) in redirect_uris.iter().enumerate() {
        if !acceptable_redirect(uri) || redirect_uris[..index].contains(uri) {
            return Err(crate::cause!(Error::InvalidRedirectUri));
        }
    }

    if let Some(method) = &form.token_endpoint_auth_method {
        if method != "none" {
            return Err(Error::InvalidClientMetadata("only public clients register: token_endpoint_auth_method must be none", crate::cause!()));
        }
    }

    let client_name = match form.client_name {
        None => CLIENT_NAME_DEFAULT.to_string(),
        Some(name) => {
            if name.trim().is_empty() {
                return Err(Error::InvalidClientMetadata("client_name is empty", crate::cause!()));
            }
            if name.chars().count() > CLIENT_NAME_MAX {
                return Err(Error::InvalidClientMetadata("client_name is longer than 200 characters", crate::cause!()));
            }
            if name.chars().any(char::is_control) {
                return Err(Error::InvalidClientMetadata("client_name holds a control character", crate::cause!()));
            }
            name
        }
    };

    let grant_types = offered(form.grant_types, &GRANT_TYPES, "grant_types must be a non-empty list of supported grant types")?;
    let response_types = offered(form.response_types, &RESPONSE_TYPES, "response_types must be a non-empty list of supported response types")?;

    let client_id = random_hex(16);
    let created_at = now_s();
    Ok(json!({
        "client_id": client_id,
        "client_id_issued_at": created_at,
        "client_name": client_name,
        "redirect_uris": redirect_uris,
        "grant_types": grant_types,
        "response_types": response_types,
        "token_endpoint_auth_method": "none",
    }))
}

/// Public registration precedes account selection. Its identifier carries only public registration metadata,
/// never a credential or a publisher identity. Anyone may register these same words and redirects. Changing any
/// byte makes a different client: an existing code or grant remains bound to the exact identifier. Each account
/// still checks its own session, explicit consent, exact redirect and S256 PKCE. The forwarder stores nothing.
pub(crate) fn register_public(body: &[u8]) -> Result<Value> {
    let mut answer = registration(body)?;
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&answer).map_err(|error| crate::carry_cause!(Error::Storage, error))?);
    if encoded.len() > public_settings().max_id_bytes { return Err(crate::cause!(Error::TooLarge)); }
    answer["client_id"] = json!(format!("{}{encoded}", public_settings().prefix));
    Ok(answer)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublicSettings { prefix: String, max_id_bytes: usize, nonce_hex_chars: usize }

fn public_settings() -> &'static PublicSettings {
    &super::settings().public_registration
}

pub(crate) fn is_public_client(id: &str) -> bool { id.starts_with(&public_settings().prefix) }

pub(crate) fn public_client(id: &str) -> Result<Client> {
    let encoded = id.strip_prefix(&public_settings().prefix).ok_or_else(|| crate::cause!(Error::InvalidClient))?;
    if encoded.len() > public_settings().max_id_bytes { return Err(crate::cause!(Error::InvalidClient)); }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|error| crate::carry_cause!(Error::InvalidClient, error))?;
    let answer: Value = serde_json::from_slice(&bytes).map_err(|error| crate::carry_cause!(Error::InvalidClient, error))?;
    if URL_SAFE_NO_PAD.encode(serde_json::to_vec(&answer).map_err(|error| crate::carry_cause!(Error::InvalidClient, error))?) != encoded { return Err(crate::cause!(Error::InvalidClient)); }
    let nonce = answer["client_id"].as_str().ok_or_else(|| crate::cause!(Error::InvalidClient))?;
    if nonce.len() != public_settings().nonce_hex_chars || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(crate::cause!(Error::InvalidClient)); }
    let created_at = answer["client_id_issued_at"].as_u64().ok_or_else(|| crate::cause!(Error::InvalidClient))?;
    // Reapply the same registration rules at every account. No field can grant fixed-client status or rights.
    let checked = registration(&bytes).map_err(|error| Error::InvalidClient(error.cause()))?;
    Ok(Client { client_name: checked["client_name"].as_str().unwrap().to_owned(),
        redirect_uris: serde_json::from_value(checked["redirect_uris"].clone()).map_err(|error| crate::carry_cause!(Error::InvalidClient, error))?,
        created_at, fixed: false })
}

/// Longest fixed client id an owner may choose, and the characters it may hold (RFC 6749 §2.2 leaves its form to the
/// server; these keep it a plain word a connector screen takes).
const FIXED_ID_MAX: usize = 64;

/// One of the account's own AI-app clients with a fixed client id, as the owner chose it.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FixedClient {
    pub client_id: String,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
}

/// Add an AI-app client with a fixed, published client id to `account` (ported from old trillion
/// src/fixed-oauth-clients.mjs, for an AI app whose own connector screen asks for a client id instead of registering
/// itself). The old file kept such clients as deploy data for everyone (records/oauth-client-records.json), read before
/// anyone signed in; here every fixed client is the account's own row (`client_of`) and nothing is kept centrally (PRINCIPLES
/// 3), so the account's owner adds it through the account routes (`sign-in:add-client`) with the id the app's screen will be given. It holds the old
/// file's invariants (src/fixed-oauth-clients.mjs:11-13): no secret (`token_endpoint_auth_method none`, S256 PKCE as
/// every client here), only the exact redirect addresses in its row, and no expiry; a registration never takes its id
/// (an id already held is refused, `Error::InvalidClientMetadata`). Authorize and token read it exactly as a registered
/// client. Answers the client as RFC 7591 would describe it.
pub(crate) fn add_fixed(store: &Store<'_>, account: &str, client: FixedClient) -> Result<Value> {
    let id_ok = !client.client_id.is_empty()
        && client.client_id.len() <= FIXED_ID_MAX
        && !is_public_client(&client.client_id)
        && client
            .client_id
            .bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if !id_ok {
        return Err(Error::InvalidClientMetadata("client_id is 1 to 64 letters, digits, dots, dashes or underscores", crate::cause!()));
    }
    let name = client.client_name.trim();
    if name.is_empty() || name.chars().count() > CLIENT_NAME_MAX || name.chars().any(char::is_control) {
        return Err(Error::InvalidClientMetadata("client_name is empty, too long or holds a control character", crate::cause!()));
    }
    if client.redirect_uris.is_empty() {
        return Err(crate::cause!(Error::InvalidRedirectUri));
    }
    for (index, uri) in client.redirect_uris.iter().enumerate() {
        if !acceptable_redirect(uri) || client.redirect_uris[..index].contains(uri) {
            return Err(crate::cause!(Error::InvalidRedirectUri));
        }
    }
    if store.get::<Client>(Family::Clients, &client.client_id)?.is_some() {
        return Err(Error::InvalidClientMetadata("that client_id is already a client", crate::cause!()));
    }
    let created_at = now_s();
    let row = Row {
        id: client.client_id.clone(),
        account: account.to_string(),
        expires_at: 0,
        value: Client { client_name: name.to_string(), redirect_uris: client.redirect_uris.clone(), created_at, fixed: true },
    };
    // A second add of the same id at once: the insert refuses one of them.
    store.insert(Family::Clients, &row).map_err(|error| Error::InvalidClientMetadata("that client_id is already a client", error.cause()))?;
    Ok(described(&row))
}

/// The account's clients with a fixed client id (old src/fixed-oauth-clients.mjs:28 `fixedClientIds`), each as RFC 7591
/// describes a client.
pub(crate) fn fixed(store: &Store<'_>, account: &str) -> Result<Vec<Value>> {
    Ok(store.list::<Client>(Family::Clients, account, usize::MAX)?.iter().filter(|row| row.value.fixed).map(described).collect())
}

/// Remove the fixed client `client_id` of `account`, and disconnect its grant: an app that loses its client signs in
/// no more. A registered client is not removed here. Answers whether one was removed.
pub(crate) fn remove_fixed(store: &Store<'_>, account: &str, client_id: &str) -> Result<bool> {
    match store.get::<Client>(Family::Clients, client_id)? {
        Some(row) if row.account == account && row.value.fixed => {}
        _ => return Ok(false),
    }
    for grant in grants(store, account)?.into_iter().filter(|grant| grant.value.client_id == client_id) {
        revoke_grant(store, account, &grant.id)?;
    }
    store.remove(Family::Clients, client_id)
}

fn described(row: &Row<Client>) -> Value {
    json!({
        "client_id": row.id,
        "client_id_issued_at": row.value.created_at,
        "client_name": row.value.client_name,
        "redirect_uris": row.value.redirect_uris,
        "grant_types": GRANT_TYPES,
        "response_types": RESPONSE_TYPES,
        "token_endpoint_auth_method": "none",
    })
}

/// The client an authorization request names and the redirect URI it is answered at. `Err(InvalidClient |
/// InvalidRedirectUri)` must be shown to the person, never redirected (RFC 6749 §4.1.2.1).
fn client_and_redirect(store: &Store<'_>, account: &str, query: &[(String, String)]) -> Result<(String, String)> {
    let client_id = param(query, "client_id")
        .map_err(|error| crate::carry_cause!(Error::InvalidClient, error))?
        .filter(|id| !id.is_empty())
        .ok_or(crate::cause!(Error::InvalidClient))?;
    let client = client_of(store, account, client_id)?;
    let redirect_uri = match param(query, "redirect_uri").map_err(|error| crate::carry_cause!(Error::InvalidRedirectUri, error))? {
        Some(uri) if client.value.redirect_uris.iter().any(|known| known == uri) => uri.to_string(),
        None if client.value.redirect_uris.len() == 1 => client.value.redirect_uris[0].clone(),
        _ => return Err(crate::cause!(Error::InvalidRedirectUri)),
    };
    Ok((client_id.to_string(), redirect_uri))
}

/// GET /authorize with its decoded query pairs. On success stores a `Request`
/// and answers its id (the forwarder sends the person to the connect page).
/// `Err(InvalidClient | InvalidRedirectUri)` must be shown to the person, never
/// redirected (RFC 6749 §4.1.2.1); any other refusal is redirected to the
/// client's redirect URI by `error_redirect`.
pub(crate) fn authorize(store: &Store<'_>, account: &str, query: &[(String, String)]) -> Result<String> {
    let (client_id, redirect_uri) = client_and_redirect(store, account, query)?;

    // From here on a refusal is redirected to the client, so the redirect URI is known.
    let state = param(query, "state")?.map(str::to_string);
    if state.as_deref().is_some_and(|state| state.chars().count() > STATE_MAX) {
        return Err(Error::InvalidRequest("state is longer than 1024 characters", crate::cause!()));
    }
    if param(query, "response_type")? != Some("code") {
        return Err(Error::InvalidRequest("response_type must be code", crate::cause!()));
    }
    let challenge = param(query, "code_challenge")?.ok_or(Error::InvalidRequest("code_challenge is required", crate::cause!()))?;
    if !s256_challenge(challenge) {
        return Err(Error::InvalidRequest("code_challenge must be an S256 challenge", crate::cause!()));
    }
    if param(query, "code_challenge_method")? != Some("S256") {
        return Err(Error::InvalidRequest("code_challenge_method must be S256", crate::cause!()));
    }
    let scopes = scopes_offered(param(query, "scope")?, &contract().scopes);
    let lifetimes = super::lists::current(store, account)?;

    let request_id = random_hex(16);
    store.insert(
        Family::Requests,
        &Row {
            id: request_id.clone(),
            account: account.to_string(),
            expires_at: expiry(lifetimes.request_seconds),
            value: Request {
                client_id,
                redirect_uri,
                state,
                scopes,
                code_challenge: challenge.to_string(),
            },
        },
    )?;
    Ok(request_id)
}

/// Where `authorize`'s refusal `error` of `query` is answered: the client's redirect URI with `error`,
/// `error_description` and the request's `state` (RFC 6749 §4.1.2.1), so the app that opened the page hears why and
/// the person is not left on a page that only says the request is not valid (old trillion src/worker.mjs:3711-3724
/// answered every refusal it could this way). `None` when the client or its redirect URI is the refusal, or cannot be
/// read: that refusal is shown to the person, never redirected.
pub(crate) fn error_redirect(store: &Store<'_>, account: &str, query: &[(String, String)], error: &Error) -> Option<String> {
    if matches!(error, Error::InvalidClient(_) | Error::InvalidRedirectUri(_)) {
        return None;
    }
    let (_, redirect_uri) = client_and_redirect(store, account, query).ok()?;
    let body = error_body(error);
    let pairs = [("error", body["error"].as_str()?), ("error_description", body["error_description"].as_str()?), ("cause", body["cause"].as_str()?)];
    // A state that is repeated or too long is the refusal itself; it is not sent back.
    let state = param(query, "state").ok().flatten().filter(|state| state.chars().count() <= STATE_MAX);
    redirect_to(&redirect_uri, &pairs, state).ok()
}

/// The pending request `request_id`, for the connect page.
pub(crate) fn pending(store: &Store<'_>, request_id: &str) -> Result<Option<(Request, Client)>> {
    let Some(request) = store.get::<Request>(Family::Requests, request_id)? else {
        return Ok(None);
    };
    let client = match client_of(store, &request.account, &request.value.client_id) {
        Ok(client) => client,
        Err(Error::InvalidClient(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok(Some((request.value, client.value)))
}

/// The signed-in person approved (`allow`) or refused the request. Consumes it
/// and answers the full redirect URL (with `code` and `state`, or with
/// `error=access_denied`). `within`, when given, narrows what is granted to those
/// scopes (a personal key approves within its own); nothing left of the request's
/// scopes is refused before the request is used.
#[cfg(test)]
pub(crate) fn decide(store: &Store<'_>, account: &str, request_id: &str, allow: bool,
    within: Option<&[String]>,
) -> Result<String> {
    decide_by(store, account, request_id, allow, within, None, None)
}

/// `decide`, keeping on the grant how the person approved it (`Grant::approved_by`).
pub(crate) fn decide_by(store: &Store<'_>, account: &str, request_id: &str, allow: bool,
    within: Option<&[String]>,
    approved_by: Option<&str>,
    address: Option<&str>,
) -> Result<String> {
    let mut request = match store.get::<Request>(Family::Requests, request_id)? {
        Some(row) if row.account == account => row.value,
        _ => return Err(Error::InvalidRequest("the request is unknown or has expired", crate::cause!())),
    };
    if let Some(within) = within {
        request.scopes.retain(|scope| within.contains(scope));
        if request.scopes.is_empty() {
            return Err(crate::cause!(Error::Unauthenticated));
        }
    }
    // Read before the request is used up, so a missing row leaves the request for a later answer.
    let lifetimes = super::lists::current(store, account)?;
    // One answer per request: whoever removes it answers, a racing second answer finds nothing.
    if !store.remove(Family::Requests, request_id)? {
        return Err(Error::InvalidRequest("the request is unknown or has expired", crate::cause!()));
    }

    if !allow {
        return redirect_to(&request.redirect_uri, &[("error", "access_denied")], request.state.as_deref());
    }
    let grant_id = grant_for(store, account, &request.client_id, &request.scopes,
        approved_by,
    )?;
    // The routing address is public, never authority. The account checks the fingerprint and all code bindings.
    let code = match address.filter(|address| tokens::owner_text_ok(address)) {
        Some(address) => format!("{address}.{}", random_text(32)),
        None => random_text(32),
    };
    mint(
        store,
        account,
        &code,
        Token {
            kind: CODE.to_string(),
            grant_id,
            client_id: request.client_id,
            scopes: request.scopes,
            redirect_uri: Some(request.redirect_uri.clone()),
            code_challenge: Some(request.code_challenge),
        },
        expiry(lifetimes.code_seconds),
    )?;
    redirect_to(&request.redirect_uri, &[("code", code.as_str())], request.state.as_deref())
}

/// POST /oauth/token with its decoded form pairs. Answers the RFC 6749 §5.1
/// JSON body (`access_token`, `token_type: "Bearer"`, `expires_in`,
/// `refresh_token`, `scope`).
pub(crate) fn token(store: &Store<'_>, account: &str, address: &str, form: &[(String, String)]) -> Result<Value> {
    match need(form, "grant_type", "grant_type is required")? {
        "authorization_code" => exchange_code(store, account, address, form),
        "refresh_token" => refresh(store, account, address, form),
        _ => Err(crate::cause!(Error::UnsupportedGrantType)),
    }
}

/// POST /oauth/revoke (RFC 7009). Always succeeds for an unknown token.
pub(crate) fn revoke(store: &Store<'_>, form: &[(String, String)]) -> Result<()> {
    let token = need(form, "token", "token is required")?;
    let id = sha256_hex(token);
    let Some(row) = store.get::<Token>(Family::Tokens, &id)? else { return Ok(()) };
    match row.value.kind.as_str() {
        ACCESS => {
            store.remove(Family::Tokens, &id)?;
        }
        // A refresh token is the grant's long-lived credential: with it gone the
        // app is disconnected, so the grant goes with its other tokens.
        REFRESH => revoke_grant(store, &row.account, &row.value.grant_id)?,
        _ => {}
    }
    Ok(())
}

/// The bearer check for the MCP door: an access token's principal, or `None`. A token in any other shape (including
/// the bare shape before addresses were added) is refused before any lookup.
pub(crate) fn bearer(store: &Store<'_>, access_token: &str) -> Result<Option<Principal>> {
    if tokens::credential_address(access_token).is_none() {
        return Ok(None);
    }
    let Some(row) = store.get::<Token>(Family::Tokens, &sha256_hex(access_token))? else { return Ok(None) };
    if row.value.kind != ACCESS || live_grant(store, &row.account, &row.value.grant_id)?.is_none() {
        return Ok(None);
    }
    Ok(Some(Principal {
        account: row.account,
        sign_in: format!("{GRANT_SIGN_IN}{}", row.value.grant_id),
        client_id: Some(row.value.client_id),
        scopes: row.value.scopes,
        expires_at_ms: row.expires_at,
    }))
}

/// The principal a standing grant made by an OAuth caller acts as now: the
/// grant `grant_id` of `account` while it exists, with the scopes the person
/// consented to. No token takes part, so a refresh (which keeps the grant)
/// changes nothing, while a revoke of its refresh token, a disconnect or a
/// replayed refresh token (each removes the grant) ends it.
pub(crate) fn standing(store: &Store<'_>, account: &str, grant_id: &str) -> Result<Option<Principal>> {
    Ok(live_grant(store, account, grant_id)?.map(|row| Principal {
        sign_in: format!("{GRANT_SIGN_IN}{}", row.id),
        account: row.account,
        client_id: Some(row.value.client_id),
        scopes: row.value.scopes,
        expires_at_ms: 0,
    }))
}

/// Every grant of `account` (the "connected AI apps" list), oldest first.
pub(crate) fn grants(store: &Store<'_>, account: &str) -> Result<Vec<Row<Grant>>> {
    let mut found = store.list::<Grant>(Family::Grants, account, usize::MAX)?;
    found.sort_by(|a, b| a.value.created_at.cmp(&b.value.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(found)
}

/// Removal of one of `account`'s grants, which also removes its tokens.
/// Answers whether the grant existed.
pub(crate) fn disconnect(store: &Store<'_>, account: &str, grant_id: &str) -> Result<bool> {
    if live_grant(store, account, grant_id)?.is_none() {
        return Ok(false);
    }
    revoke_grant(store, account, grant_id)?;
    Ok(true)
}

/// How the grant `grant_id` was approved, when it recorded it (`Grant::approved_by`).
pub(crate) fn approved_by(store: &Store<'_>, grant_id: &str) -> Result<Option<String>> {
    Ok(store.get::<Grant>(Family::Grants, grant_id)?.and_then(|row| row.value.approved_by))
}

/// The RFC 6749 error body for `error`: `{"error": ..., "error_description": ...}`.
pub(crate) fn error_body(error: &Error) -> Value {
    crate::quiet_eprintln!("sign-in-refusal cause={}", error.cause());
    let (code, description) = match error {
        Error::InvalidRequest(text, _) => ("invalid_request", *text),
        Error::InvalidClientMetadata(text, _) => ("invalid_client_metadata", *text),
        Error::InvalidRedirectUri(_) => ("invalid_redirect_uri", "the redirect URI is not allowed for this client"),
        Error::InvalidClient(_) => ("invalid_client", "the client is not known"),
        Error::InvalidGrant(_) => ("invalid_grant", "the code or token is unknown, used, expired or does not match"),
        Error::UnsupportedGrantType(_) => ("unsupported_grant_type", "the grant type is not offered"),
        Error::Unauthenticated(_) => ("invalid_token", "the access token is unknown, expired or turned off"),
        Error::TooLarge(_) => ("invalid_request", "the request body is larger than the limit"),
        Error::PasskeyRefused(_) | Error::Storage(_) | Error::SourceNotCurrent(_) => ("server_error", "the sign-in could not complete"),
        Error::WordsMissing(_) => {
            return json!({
                "error": "temporarily_unavailable",
                "error_description": "the account has no sign-in words row; its owner writes it with sign-in:set-words",
                "code": super::words_row::MISSING,
                "cause": error.cause().id(),
            });
        }
        Error::SettingsMissing(_) => {
            return json!({
                "error": "temporarily_unavailable",
                "error_description": "the account has no sign-in settings row; its owner writes it with sign-in:set-settings",
                "code": super::lists::MISSING,
                "cause": error.cause().id(),
            });
        }
    };
    json!({"error": code, "error_description": description, "cause": error.cause().id()})
}

/// The authorization code exchange (RFC 6749 §4.1.3 with PKCE). Nothing is spent
/// unless every check passes, so a wrong verifier cannot cost the legitimate
/// client its code; a code presented after it was spent revokes its grant.
fn exchange_code(store: &Store<'_>, account: &str, address: &str, form: &[(String, String)]) -> Result<Value> {
    let code = need(form, "code", "code is required")?;
    let redirect_uri = need(form, "redirect_uri", "redirect_uri is required")?;
    let client_id = need(form, "client_id", "client_id is required")?;
    let verifier = need(form, "code_verifier", "code_verifier is required")?;

    let id = sha256_hex(code);
    let Some(row) = store.get::<Token>(Family::Tokens, &id)? else { return Err(crate::cause!(Error::InvalidGrant)) };
    if row.account != account {
        return Err(crate::cause!(Error::InvalidGrant));
    }
    let token = row.value;
    if token.kind == USED_CODE {
        revoke_grant(store, account, &token.grant_id)?;
        return Err(crate::cause!(Error::InvalidGrant));
    }
    if token.kind != CODE {
        return Err(crate::cause!(Error::InvalidGrant));
    }
    let bound = token.client_id == client_id
        && token.redirect_uri.as_deref() == Some(redirect_uri)
        && token.code_challenge.as_deref().is_some_and(|challenge| pkce_s256_matches(verifier, challenge));
    if !bound || live_grant(store, account, &token.grant_id)?.is_none() {
        return Err(crate::cause!(Error::InvalidGrant));
    }
    // Read before the code is spent: a missing row costs the client nothing.
    let lifetimes = super::lists::current(store, account)?;

    if !store.remove(Family::Tokens, &id)? {
        revoke_grant(store, account, &token.grant_id)?;
        return Err(crate::cause!(Error::InvalidGrant));
    }
    store.insert(
        Family::Tokens,
        &Row {
            id,
            account: account.to_string(),
            expires_at: row.expires_at,
            value: Token { kind: USED_CODE.to_string(), ..token.clone() },
        },
    )?;
    issue(store, account, address, &token.grant_id, &token.client_id, &token.scopes, &lifetimes)
}

/// Refresh token rotation (OAuth 2.1 §4.3.1). A refresh token that was already
/// rotated revokes its grant; one that is unknown or does not match is refused
/// without touching anything.
fn refresh(store: &Store<'_>, account: &str, address: &str, form: &[(String, String)]) -> Result<Value> {
    let presented = need(form, "refresh_token", "refresh_token is required")?;
    let client_id = need(form, "client_id", "client_id is required")?;

    let id = sha256_hex(presented);
    let Some(row) = store.get::<Token>(Family::Tokens, &id)? else { return Err(crate::cause!(Error::InvalidGrant)) };
    if row.account != account || row.value.client_id != client_id {
        return Err(crate::cause!(Error::InvalidGrant));
    }
    let token = row.value;
    if token.kind == USED_REFRESH {
        revoke_grant(store, account, &token.grant_id)?;
        return Err(crate::cause!(Error::InvalidGrant));
    }
    if token.kind != REFRESH || live_grant(store, account, &token.grant_id)?.is_none() {
        return Err(crate::cause!(Error::InvalidGrant));
    }
    let scopes = scopes_within(param(form, "scope")?, &token.scopes)?;
    // Read before the refresh token is spent: a missing row costs the client nothing.
    let lifetimes = super::lists::current(store, account)?;

    if !store.remove(Family::Tokens, &id)? {
        revoke_grant(store, account, &token.grant_id)?;
        return Err(crate::cause!(Error::InvalidGrant));
    }
    store.insert(
        Family::Tokens,
        &Row {
            id,
            account: account.to_string(),
            expires_at: row.expires_at,
            value: Token { kind: USED_REFRESH.to_string(), ..token.clone() },
        },
    )?;
    issue(store, account, address, &token.grant_id, &token.client_id, &scopes, &lifetimes)
}

/// A new access token and a new refresh token for `grant_id`, each naming `address` (the account's address) in its text.
fn issue(
    store: &Store<'_>, account: &str, address: &str, grant_id: &str, client_id: &str, scopes: &[String],
    settings: &super::lists::AccountSettings,
) -> Result<Value> {
    let access = format!("{address}.{}", random_text(32));
    let refresh = format!("{address}.{}", random_text(32));
    let make = |kind: &str| Token {
        kind: kind.to_string(),
        grant_id: grant_id.to_string(),
        client_id: client_id.to_string(),
        scopes: scopes.to_vec(),
        redirect_uri: None,
        code_challenge: None,
    };
    mint(store, account, &access, make(ACCESS), expiry(settings.access_token_seconds))?;
    mint(store, account, &refresh, make(REFRESH), expiry(settings.refresh_token_seconds))?;
    Ok(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": settings.access_token_seconds,
        "refresh_token": refresh,
        "scope": scopes.join(" "),
    }))
}

/// Removes `grant_id` and every token of it (an account's grant only).
fn revoke_grant(store: &Store<'_>, account: &str, grant_id: &str) -> Result<()> {
    store.remove(Family::Grants, grant_id)?;
    for row in store.list::<Token>(Family::Tokens, account, usize::MAX)? {
        if row.value.grant_id == grant_id {
            store.remove(Family::Tokens, &row.id)?;
        }
    }
    Ok(())
}

/// The live grant `grant_id` of `account`, if any.
fn live_grant(store: &Store<'_>, account: &str, grant_id: &str) -> Result<Option<Row<Grant>>> {
    Ok(store.get::<Grant>(Family::Grants, grant_id)?.filter(|row| row.account == account))
}

/// The one grant of `account` for `client_id`: reused, with the consented
/// scopes, or created.
fn grant_for(store: &Store<'_>, account: &str, client_id: &str, scopes: &[String], approved_by: Option<&str>) -> Result<String> {
    let approved_by = approved_by.map(str::to_string);
    let existing = store
        .list::<Grant>(Family::Grants, account, usize::MAX)?
        .into_iter()
        .find(|row| row.value.client_id == client_id);
    match existing {
        Some(row) => {
            let value = Grant { client_id: client_id.to_string(), scopes: scopes.to_vec(), created_at: row.value.created_at, approved_by };
            store.put(Family::Grants, &Row { id: row.id.clone(), account: account.to_string(), expires_at: 0, value })?;
            Ok(row.id)
        }
        None => {
            let id = random_hex(16);
            let value = Grant { client_id: client_id.to_string(), scopes: scopes.to_vec(), created_at: now_s(), approved_by };
            store.insert(Family::Grants, &Row { id: id.clone(), account: account.to_string(), expires_at: 0, value })?;
            Ok(id)
        }
    }
}

/// The client metadata used by `account`, or `InvalidClient`. A public descriptor is metadata alone: this returned
/// view proves neither registration by this account nor permission to it. Only the account's session and grant do.
pub(crate) fn client_of(store: &Store<'_>, account: &str, client_id: &str) -> Result<Row<Client>> {
    if is_public_client(client_id) {
        return Ok(Row { id: client_id.to_owned(), account: account.to_owned(), expires_at: 0,
            value: public_client(client_id)? });
    }
    match store.get::<Client>(Family::Clients, client_id)? {
        Some(row) if row.account == account => Ok(row),
        _ => Err(crate::cause!(Error::InvalidClient)),
    }
}

/// Stores a token (or code) row whose id is the fingerprint of `secret`.
fn mint(store: &Store<'_>, account: &str, secret: &str, value: Token, expires_at: u64) -> Result<()> {
    store.insert(Family::Tokens, &Row { id: sha256_hex(secret), account: account.to_string(), expires_at, value })?;
    Ok(())
}

/// Which addresses an app may register for its sign-in to return to: `settings.json` `redirects`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RedirectSettings {
    /// Schemes no app may register, lower case and without the colon.
    pub refused_schemes: Vec<String>,
    /// The only hosts an `http` address may name (RFC 8252 §7.3).
    pub loopback_hosts: Vec<String>,
}

impl RedirectSettings {
    /// The schemes that run or read something where the sign-in returns stay refused, whatever the file says.
    pub(crate) fn valid(&self) -> bool {
        ["javascript", "data", "file"].iter().all(|scheme| self.refused_schemes.iter().any(|refused| refused == scheme))
            && self.refused_schemes.iter().all(|scheme| !scheme.is_empty() && *scheme == scheme.to_ascii_lowercase())
    }
}

/// Registration redirect URI rule, ported from old trillion's OAuth provider package (workers-oauth-provider 1.1.0,
/// dist/oauth-provider.js:251-269 `validateRedirectUriScheme`): any scheme except the refused ones (`settings.json`
/// `redirects`), and no control character. Old trimmed the address first; here an address with any control character,
/// at its ends too, is refused, since the app must send back the exact address it registered. Kept on top of old: `http`
/// only for a loopback host (RFC 8252 §7.3), and never a fragment (RFC 6749 §3.1.2). An app's own scheme need not
/// contain a dot (RFC 8252 §7.1 asks for a reverse domain name, but Trillion for iPhone registers
/// trillion-share://oauth/callback, and cursor:// and vscode:// are used the same way).
fn acceptable_redirect(uri: &str) -> bool {
    let rule = &super::settings().redirects;
    if uri.chars().any(char::is_control) {
        return false;
    }
    let Ok(url) = Url::parse(uri) else { return false };
    if url.fragment().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => true,
        "http" => url.host_str().is_some_and(|host| rule.loopback_hosts.iter().any(|loopback| loopback == host)),
        scheme => !rule.refused_schemes.iter().any(|refused| refused == scheme),
    }
}

/// The requested subset of `supported`, or every supported value when absent.
fn offered(requested: Option<Vec<String>>, supported: &[&str], refusal: &'static str) -> Result<Vec<String>> {
    let Some(requested) = requested else {
        return Ok(supported.iter().map(|value| value.to_string()).collect());
    };
    if requested.is_empty() || requested.iter().any(|value| !supported.contains(&value.as_str())) {
        return Err(Error::InvalidClientMetadata(refusal, crate::cause!()));
    }
    Ok(requested)
}

/// The scopes an authorization request is asked for: the requested ones this server offers, in the requested order
/// without duplicates; every offered one when none of those is requested. A scope this server does not offer is
/// dropped, never refused (RFC 6749 §3.3 lets the server ignore what it does not offer; old trillion granted
/// `pending.request.scope.filter(scope => scope === SCOPE)`, src/worker.mjs:3633, and its provider refused no scope at
/// /authorize). An app built for another issuer's scope names (the iPhone app before old trillion 81971a6aa4 asks for
/// "decisions") is asked for what this one offers; the person approves exactly that on the connect page, and the
/// token answer names the scopes granted.
fn scopes_offered(requested: Option<&str>, offered: &[String]) -> Vec<String> {
    let mut scopes: Vec<String> = Vec::new();
    for scope in requested.unwrap_or("").split_whitespace() {
        if offered.iter().any(|known| known == scope) && !scopes.iter().any(|known| known == scope) {
            scopes.push(scope.to_string());
        }
    }
    if scopes.is_empty() { offered.to_vec() } else { scopes }
}

/// The requested scopes, each of which must be in `allowed`; `allowed` when none
/// are requested. Duplicates are dropped, the requested order kept. A refresh asks within what its grant holds
/// (RFC 6749 §6), so a scope outside it is refused.
fn scopes_within(requested: Option<&str>, allowed: &[String]) -> Result<Vec<String>> {
    let Some(text) = requested.filter(|text| !text.trim().is_empty()) else { return Ok(allowed.to_vec()) };
    let mut scopes: Vec<String> = Vec::new();
    for scope in text.split_whitespace() {
        if !allowed.iter().any(|known| known == scope) {
            return Err(Error::InvalidRequest("scope is not offered here", crate::cause!()));
        }
        if !scopes.iter().any(|known| known == scope) {
            scopes.push(scope.to_string());
        }
    }
    Ok(scopes)
}

/// RFC 7636 §4.2: an S256 challenge is 43 unpadded base64url characters.
fn s256_challenge(text: &str) -> bool {
    text.len() == 43 && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `base` with `pairs` and then `state` appended to its query, as the redirect URL.
fn redirect_to(base: &str, pairs: &[(&str, &str)], state: Option<&str>) -> Result<String> {
    let mut url = Url::parse(base).map_err(|error| crate::carry_cause!(Error::InvalidRedirectUri, error))?;
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in pairs {
            query.append_pair(name, value);
        }
        if let Some(state) = state {
            query.append_pair("state", state);
        }
    }
    Ok(url.to_string())
}

/// The one value of parameter `name`; a repeated parameter is refused (RFC 6749 §3.1).
fn param<'a>(pairs: &'a [(String, String)], name: &str) -> Result<Option<&'a str>> {
    let mut found = pairs.iter().filter(|(key, _)| key.as_str() == name).map(|(_, value)| value.as_str());
    let first = found.next();
    if found.next().is_some() {
        return Err(Error::InvalidRequest("a parameter is repeated", crate::cause!()));
    }
    Ok(first)
}

/// A non-empty parameter `name`, or `InvalidRequest(missing)`.
fn need<'a>(pairs: &'a [(String, String)], name: &str, missing: &'static str) -> Result<&'a str> {
    match param(pairs, name)? {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(Error::InvalidRequest(missing, crate::cause!())),
    }
}

fn expiry(seconds: u64) -> u64 {
    now_ms().saturating_add(seconds.saturating_mul(1000))
}

fn now_s() -> u64 {
    now_ms() / 1000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memory::Memory;

    const ACCOUNT: &str = "owner";
    /// A well-formed owner id for the tests (64 lowercase hex).
    const OWNER: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    const OTHER: &str = "someone-else";
    const REDIRECT: &str = "https://app.example/callback";
    const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn memory() -> Memory {
        crate::account::sign_in::lists::test_memory()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect()
    }

    fn refused<T>(result: Result<T>) -> Error {
        match result {
            Err(error) => error,
            Ok(_) => panic!("the call should have been refused"),
        }
    }

    fn register_app(store: &Store<'_>, body: &str) -> Result<Value> {
        register(store, ACCOUNT, body.as_bytes())
    }

    /// A public client with one redirect URI; answers its client id.
    fn app(store: &Store<'_>) -> String {
        let answer = register_app(store, r#"{"client_name":"Test app","redirect_uris":["https://app.example/callback"]}"#).unwrap();
        answer["client_id"].as_str().unwrap().to_string()
    }

    fn ask(store: &Store<'_>, client_id: &str) -> String {
        authorize(
            store,
            ACCOUNT,
            &pairs(&[
                ("response_type", "code"),
                ("client_id", client_id),
                ("redirect_uri", REDIRECT),
                ("code_challenge", CHALLENGE),
                ("code_challenge_method", "S256"),
                ("state", "xyz"),
            ]),
        )
        .unwrap()
    }

    fn code_of(url: &str) -> String {
        Url::parse(url).unwrap().query_pairs().find(|(name, _)| name == "code").map(|(_, value)| value.into_owned()).expect("the redirect carries a code")
    }

    /// The whole approval; answers the code.
    fn approve(store: &Store<'_>, client_id: &str) -> String {
        let request = ask(store, client_id);
        code_of(&decide(store, ACCOUNT, &request, true, None).unwrap())
    }

    fn exchange(store: &Store<'_>, code: &str, client_id: &str) -> Result<Value> {
        token(
            store,
            ACCOUNT,
            OWNER,
            &pairs(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", REDIRECT),
                ("client_id", client_id),
                ("code_verifier", VERIFIER),
            ]),
        )
    }

    /// A full sign-in: the token answer.
    fn sign_in(store: &Store<'_>, client_id: &str) -> Value {
        exchange(store, &approve(store, client_id), client_id).unwrap()
    }

    fn refresh_with(store: &Store<'_>, refresh: &str, client_id: &str, scope: Option<&str>) -> Result<Value> {
        let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", client_id)];
        if let Some(scope) = scope {
            form.push(("scope", scope));
        }
        token(store, ACCOUNT, OWNER, &pairs(&form))
    }

    fn bearer_of(store: &Store<'_>, access: &str) -> Option<Principal> {
        bearer(store, access).unwrap()
    }

    #[test]
    fn metadata_describes_the_server() {
        let document = metadata("https://host.example");
        assert_eq!(document["issuer"], "https://host.example");
        assert_eq!(document["authorization_endpoint"], "https://host.example/authorize");
        assert_eq!(document["token_endpoint"], "https://host.example/oauth/token");
        assert_eq!(document["registration_endpoint"], "https://host.example/oauth/register");
        assert_eq!(document["revocation_endpoint"], "https://host.example/oauth/revoke");
        assert_eq!(document["response_types_supported"], json!(["code"]));
        assert_eq!(document["grant_types_supported"], json!(["authorization_code", "refresh_token"]));
        assert_eq!(document["code_challenge_methods_supported"], json!(["S256"]));
        assert_eq!(document["token_endpoint_auth_methods_supported"], json!(["none"]));
        assert_eq!(document["revocation_endpoint_auth_methods_supported"], json!(["none"])
        );
        assert_eq!(document["scopes_supported"], json!(["records", "tools"]));
    }

    #[test]
    fn root_registration_works_in_two_separate_accounts_without_copying_clients_or_grants() {
        let client = register_public(br#"{"client_name":"A new AI","redirect_uris":["https://app.example/callback"]}"#).unwrap();
        let id = client["client_id"].as_str().unwrap();
        let first = memory();
        let second = memory();
        for (memory, address) in [(&first, OWNER.to_owned()), (&second, "ab".repeat(32))] {
            let store = Store::new(memory);
            assert!(store.list::<Client>(Family::Clients, ACCOUNT, usize::MAX).unwrap().is_empty());
            let request = ask(&store, id);
            assert_eq!(pending(&store, &request).unwrap().unwrap().1.client_name, "A new AI");
            let code = code_of(&decide_by(&store, ACCOUNT, &request, true, None, Some("passkey"), Some(&address)).unwrap());
            assert_eq!(tokens::credential_address(&code), Some(address.as_str()));
            let changed = register_public(br#"{"client_name":"Another AI","redirect_uris":["https://app.example/callback"]}"#).unwrap();
            assert!(matches!(exchange(&store, &code, changed["client_id"].as_str().unwrap()), Err(Error::InvalidGrant(_))));
            let reply = token(&store, ACCOUNT, &address, &pairs(&[("grant_type","authorization_code"),("code",&code),("client_id",id),("redirect_uri",REDIRECT),("code_verifier",VERIFIER)])).unwrap();
            assert!(reply["access_token"].as_str().unwrap().starts_with(&format!("{address}.")));
            let rotated = refresh_with(&store, reply["refresh_token"].as_str().unwrap(), id, None).unwrap();
            assert!(bearer_of(&store, rotated["access_token"].as_str().unwrap()).is_some());
            assert_eq!(grants(&store, ACCOUNT).unwrap().len(), 1);
            assert!(store.list::<Client>(Family::Clients, ACCOUNT, usize::MAX).unwrap().is_empty());
        }
        let isolated = memory();
        assert!(bearer(&Store::new(&isolated), &format!("{OWNER}.{}", random_text(32))).unwrap().is_none());
    }

    #[test]
    fn root_client_metadata_cannot_change_a_redirect_or_claim_fixed_rights() {
        let reply = register_public(br#"{"redirect_uris":["https://app.example/callback"]}"#).unwrap();
        let id = reply["client_id"].as_str().unwrap();
        let memory = memory(); let store = Store::new(&memory);
        let bad_redirect = pairs(&[("response_type","code"),("client_id",id),("redirect_uri","https://attacker.example/cb"),("code_challenge",CHALLENGE),("code_challenge_method","S256")]);
        assert!(matches!(authorize(&store, ACCOUNT, &bad_redirect), Err(Error::InvalidRedirectUri(_))));
        let mut data: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(id.strip_prefix(&public_settings().prefix).unwrap()).unwrap()).unwrap();
        data["redirect_uris"] = json!(["javascript:alert(1)"]);
        let forged = format!("{}{}", public_settings().prefix, URL_SAFE_NO_PAD.encode(serde_json::to_vec(&data).unwrap()));
        assert!(matches!(public_client(&forged), Err(Error::InvalidClient(_))));
        assert!(matches!(public_client(&format!("{}{}", public_settings().prefix, "a".repeat(public_settings().max_id_bytes + 1))), Err(Error::InvalidClient(_))));
        assert!(matches!(public_client("public.invalid"), Err(Error::InvalidClient(_))));
        assert!(!public_client(id).unwrap().fixed);
    }

    #[test]
    fn register_issues_a_public_client() {
        let memory = memory();
        let store = Store::new(&memory);
        let answer = register_app(&store, r#"{"redirect_uris":["http://127.0.0.1:8080/cb"]}"#).unwrap();
        let client_id = answer["client_id"].as_str().unwrap();
        assert_eq!(client_id.len(), 32);
        assert_eq!(answer["client_name"], "AI app");
        assert_eq!(answer["redirect_uris"], json!(["http://127.0.0.1:8080/cb"]));
        assert_eq!(answer["grant_types"], json!(["authorization_code", "refresh_token"]));
        assert_eq!(answer["response_types"], json!(["code"]));
        assert_eq!(answer["token_endpoint_auth_method"], "none");
        assert!(answer["client_id_issued_at"].as_u64().unwrap() > 0);
        let stored = store.get::<Client>(Family::Clients, client_id).unwrap().unwrap();
        assert_eq!(stored.account, ACCOUNT);
        assert_eq!(stored.expires_at, 0);
    }

    #[test]
    fn register_refuses_bad_metadata() {
        let memory = memory();
        let store = Store::new(&memory);
        let invalid_redirect = [
            r#"{}"#,
            r#"{"redirect_uris":[]}"#,
            r#"{"redirect_uris":["http://example.com/cb"]}"#,
            r#"{"redirect_uris":["https://app.example/cb#frag"]}"#,
            r#"{"redirect_uris":["javascript:alert(1)"]}"#,
            r#"{"redirect_uris":["JavaScript:alert(1)"]}"#,
            r#"{"redirect_uris":["data:text/html,hi"]}"#,
            r#"{"redirect_uris":["file:///etc/passwd"]}"#,
            r#"{"redirect_uris":["vbscript:msgbox(1)"]}"#,
            r#"{"redirect_uris":["blob:https://app.example/1"]}"#,
            r#"{"redirect_uris":["mailto:person@example.test"]}"#,
            r#"{"redirect_uris":["trillion-share://oauth/call\u0007back"]}"#,
            r#"{"redirect_uris":["trillion-share://oauth/callback\n"]}"#,
            r#"{"redirect_uris":["not a uri"]}"#,
            r#"{"redirect_uris":["https://app.example/cb","https://app.example/cb"]}"#,
        ];
        for body in invalid_redirect {
            assert_eq!(refused(register_app(&store, body)), crate::cause!(Error::InvalidRedirectUri), "{body}");
        }
        let invalid_metadata = [
            "not json",
            r#"{"redirect_uris":["https://app.example/cb"],"token_endpoint_auth_method":"client_secret_basic"}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"client_name":"   "}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"client_name":"bad\u0007name"}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"grant_types":["password"]}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"grant_types":[]}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"response_types":["token"]}"#,
        ];
        for body in invalid_metadata {
            assert!(matches!(refused(register_app(&store, body)), Error::InvalidClientMetadata(_, _)), "{body}");
        }
        let long_name = format!(r#"{{"redirect_uris":["https://app.example/cb"],"client_name":"{}"}}"#, "n".repeat(201));
        assert!(matches!(refused(register_app(&store, &long_name)), Error::InvalidClientMetadata(_, _)));
    }

    #[test]
    fn register_accepts_the_allowed_forms() {
        let memory = memory();
        let store = Store::new(&memory);
        let accepted = [
            r#"{"redirect_uris":["https://app.example/cb"],"token_endpoint_auth_method":"none"}"#,
            r#"{"redirect_uris":["http://localhost/cb"]}"#,
            r#"{"redirect_uris":["http://[::1]:9000/cb"]}"#,
            r#"{"redirect_uris":["com.example.app:/oauth2redirect"]}"#,
            r#"{"redirect_uris":["myapp:/cb"]}"#,
            r#"{"redirect_uris":["trillion-share://oauth/callback"]}"#,
            r#"{"redirect_uris":["cursor://anysphere.cursor-retrieval/oauth/callback"]}"#,
            r#"{"redirect_uris":["vscode://vscode.github-authentication/did-authenticate"]}"#,
            r#"{"redirect_uris":["https://app.example/cb"],"grant_types":["refresh_token"],"response_types":["code"]}"#,
        ];
        for body in accepted {
            register_app(&store, body).unwrap_or_else(|error| panic!("{body} refused: {error:?}"));
        }
        let long = format!(r#"{{"redirect_uris":["https://app.example/cb"],"client_name":"{}"}}"#, "n".repeat(200));
        assert_eq!(register_app(&store, &long).unwrap()["client_name"].as_str().unwrap().len(), 200);
    }

    #[test]
    fn an_apps_own_scheme_is_admitted_and_only_its_exact_address_receives_the_sign_in() {
        const IPHONE: &str = "trillion-share://oauth/callback";
        let memory = memory();
        let store = Store::new(&memory);
        // The body Trillion for iPhone sends (trillion-apps ios/Shared/TrillionAccount.swift:178).
        let answer = register_app(
            &store,
            r#"{"client_name":"Trillion for iPhone","redirect_uris":["trillion-share://oauth/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}"#,
        )
        .unwrap();
        assert_eq!(answer["redirect_uris"], json!([IPHONE]));
        let client_id = answer["client_id"].as_str().unwrap();
        let asked = |redirect: &str| {
            authorize(
                &store,
                ACCOUNT,
                &pairs(&[
                    ("response_type", "code"),
                    ("client_id", client_id),
                    ("redirect_uri", redirect),
                    ("code_challenge", CHALLENGE),
                    ("code_challenge_method", "S256"),
                    ("state", "xyz"),
                ]),
            )
        };
        for other in ["trillion-share://oauth/other", "trillion-share://evil/callback", "https://evil.example/cb"] {
            assert_eq!(refused(asked(other)), crate::cause!(Error::InvalidRedirectUri), "{other}");
        }
        let request = asked(IPHONE).unwrap();
        let returned = decide(&store, ACCOUNT, &request, true, None).unwrap();
        let url = Url::parse(&returned).unwrap();
        assert_eq!(format!("{}://{}{}", url.scheme(), url.host_str().unwrap(), url.path()), IPHONE, "{returned}");
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(query.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["code", "state"], "{returned}");
        assert!(query.contains(&("state".into(), "xyz".into())));
        let code = code_of(&returned);
        let tokens = token(
            &store,
            ACCOUNT,
            OWNER,
            &pairs(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", IPHONE), ("client_id", client_id), ("code_verifier", VERIFIER)]),
        )
        .unwrap();
        assert!(tokens["access_token"].is_string(), "{tokens}");
    }

    #[test]
    fn the_refused_redirect_schemes_are_the_sign_ins_data_and_keep_javascript_data_and_file() {
        let rule = &crate::account::sign_in::settings().redirects;
        assert!(rule.valid());
        let mut without = RedirectSettings { refused_schemes: vec!["data".into(), "file".into()], loopback_hosts: vec![] };
        assert!(!without.valid());
        without.refused_schemes.push("javascript".into());
        assert!(without.valid());
    }

    #[test]
    fn register_refuses_a_body_over_the_limit() {
        let memory = memory();
        let store = Store::new(&memory);
        let body = vec![b' '; computer().max_body_bytes + 1];
        assert_eq!(refused(register(&store, ACCOUNT, &body)), crate::cause!(Error::TooLarge));
    }

    #[test]
    fn authorize_stores_a_request_the_connect_page_can_read() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let request = ask(&store, &client_id);
        let (pending_request, client) = pending(&store, &request).unwrap().expect("the request is pending");
        assert_eq!(pending_request.client_id, client_id);
        assert_eq!(pending_request.redirect_uri, REDIRECT);
        assert_eq!(pending_request.state.as_deref(), Some("xyz"));
        assert_eq!(pending_request.scopes, vec!["records", "tools"]);
        assert_eq!(pending_request.code_challenge, CHALLENGE);
        assert_eq!(client.client_name, "Test app");
        assert!(pending(&store, "no-such-request").unwrap().is_none());
    }

    #[test]
    fn authorize_refuses_unknown_clients_and_redirects_that_are_not_the_clients() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let base = |client: &str, redirect: Option<&str>| {
            let mut list = vec![
                ("response_type", "code"),
                ("client_id", client),
                ("code_challenge", CHALLENGE),
                ("code_challenge_method", "S256"),
            ];
            if let Some(redirect) = redirect {
                list.push(("redirect_uri", redirect));
            }
            pairs(&list)
        };
        assert_eq!(refused(authorize(&store, ACCOUNT, &base("no-such-client", Some(REDIRECT)))), crate::cause!(Error::InvalidClient));
        assert_eq!(refused(authorize(&store, ACCOUNT, &base("", Some(REDIRECT)))), crate::cause!(Error::InvalidClient));
        assert_eq!(refused(authorize(&store, OTHER, &base(&client_id, Some(REDIRECT)))), crate::cause!(Error::InvalidClient));
        assert_eq!(refused(authorize(&store, ACCOUNT, &base(&client_id, Some("https://evil.example/cb")))), crate::cause!(Error::InvalidRedirectUri));
    }

    #[test]
    fn authorize_needs_a_redirect_uri_when_the_client_has_several() {
        let memory = memory();
        let store = Store::new(&memory);
        let answer = register_app(&store, r#"{"redirect_uris":["https://app.example/a","https://app.example/b"]}"#).unwrap();
        let client_id = answer["client_id"].as_str().unwrap();
        let query = pairs(&[("response_type", "code"), ("client_id", client_id), ("code_challenge", CHALLENGE), ("code_challenge_method", "S256")]);
        assert_eq!(refused(authorize(&store, ACCOUNT, &query)), crate::cause!(Error::InvalidRedirectUri));
        let mut with_redirect = query.clone();
        with_redirect.push(("redirect_uri".into(), "https://app.example/b".into()));
        assert!(authorize(&store, ACCOUNT, &with_redirect).is_ok());
        let mut repeated = with_redirect.clone();
        repeated.push(("redirect_uri".into(), "https://app.example/b".into()));
        assert_eq!(refused(authorize(&store, ACCOUNT, &repeated)), crate::cause!(Error::InvalidRedirectUri));
    }

    #[test]
    fn authorize_takes_the_only_redirect_uri_when_none_is_named() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let query = pairs(&[("response_type", "code"), ("client_id", &client_id), ("code_challenge", CHALLENGE), ("code_challenge_method", "S256")]);
        let request = authorize(&store, ACCOUNT, &query).unwrap();
        assert_eq!(pending(&store, &request).unwrap().unwrap().0.redirect_uri, REDIRECT);
    }

    #[test]
    fn authorize_refuses_bad_parameters_after_the_redirect_is_known() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let good = [
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", REDIRECT),
            ("code_challenge", CHALLENGE),
            ("code_challenge_method", "S256"),
        ];
        let with = |change: &[(&str, &str)], dropped: &[&str]| {
            let mut list: Vec<(&str, &str)> = good.iter().copied().filter(|(name, _)| !dropped.contains(name)).collect();
            list.extend_from_slice(change);
            pairs(&list)
        };
        let long_state = "s".repeat(1025);
        let refusals = [
            with(&[("response_type", "token")], &["response_type"]),
            with(&[], &["response_type"]),
            with(&[], &["code_challenge"]),
            with(&[("code_challenge", "short")], &["code_challenge"]),
            with(&[], &["code_challenge_method"]),
            with(&[("code_challenge_method", "plain")], &["code_challenge_method"]),
            with(&[("state", long_state.as_str())], &[]),
            with(&[("state", "one"), ("state", "two")], &[]),
        ];
        for query in &refusals {
            assert!(matches!(refused(authorize(&store, ACCOUNT, query)), Error::InvalidRequest(_, _)), "{query:?}");
        }
        let max_state = "s".repeat(1024);
        let ok = with(&[("state", max_state.as_str()), ("scope", "tools records tools")], &[]);
        let request = authorize(&store, ACCOUNT, &ok).unwrap();
        assert_eq!(pending(&store, &request).unwrap().unwrap().0.scopes, vec!["tools", "records"]);
    }

    /// The iPhone app built before old trillion 81971a6aa4 (and today's app when it cannot read the door's metadata)
    /// asks for "decisions", the old issuer's one scope. the owner, 2026-11-05 7:45 PM MST: that request showed "This
    /// sign-in request is not valid" and nothing else. A scope this door does not offer is dropped, never refused.
    #[test]
    fn authorize_asks_for_the_offered_scopes_whatever_scope_names_the_app_was_built_with() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let asked = |scope: Option<&str>| {
            let mut list = vec![("response_type", "code"), ("client_id", client_id.as_str()), ("redirect_uri", REDIRECT),
                ("code_challenge", CHALLENGE), ("code_challenge_method", "S256")];
            list.extend(scope.map(|scope| ("scope", scope)));
            let request = authorize(&store, ACCOUNT, &pairs(&list)).unwrap();
            pending(&store, &request).unwrap().unwrap().0.scopes
        };
        let offered = contract().scopes.clone();
        assert_eq!(asked(Some("decisions")), offered, "the old issuer's scope asks for what this door offers");
        assert_eq!(asked(None), offered);
        assert_eq!(asked(Some("  ")), offered);
        assert_eq!(asked(Some("records admin")), vec!["records"], "an offered scope keeps the request narrow");
        assert_eq!(asked(Some("tools decisions tools")), vec!["tools"]);
    }

    #[test]
    fn a_refusal_after_the_redirect_is_known_goes_back_to_the_app_with_its_state() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let query = |extra: &[(&str, &str)]| {
            let mut list = vec![("client_id", client_id.as_str()), ("redirect_uri", REDIRECT), ("response_type", "token")];
            list.extend_from_slice(extra);
            pairs(&list)
        };
        let asked = query(&[("state", "s-1")]);
        let error = refused(authorize(&store, ACCOUNT, &asked));
        let url = Url::parse(&error_redirect(&store, ACCOUNT, &asked, &error).unwrap()).unwrap();
        assert_eq!(url.as_str().split('?').next(), Some(REDIRECT));
        let answer: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(answer, vec![
            ("error".to_string(), "invalid_request".to_string()),
            ("error_description".to_string(), "response_type must be code".to_string()),
            ("cause".to_string(), error.cause().id()),
            ("state".to_string(), "s-1".to_string()),
        ]);
        // A state that is itself the refusal is not sent back; the refusal still is.
        let repeated = query(&[("state", "a"), ("state", "b")]);
        let error = refused(authorize(&store, ACCOUNT, &repeated));
        let url = Url::parse(&error_redirect(&store, ACCOUNT, &repeated, &error).unwrap()).unwrap();
        assert!(url.query_pairs().all(|(name, _)| name != "state"));
        // The client and its redirect URI are never redirected to (RFC 6749 §4.1.2.1).
        let unknown = pairs(&[("client_id", "no-such-client"), ("redirect_uri", REDIRECT)]);
        assert_eq!(error_redirect(&store, ACCOUNT, &unknown, &crate::cause!(Error::InvalidClient)), None);
        let elsewhere = pairs(&[("client_id", client_id.as_str()), ("redirect_uri", "https://evil.example/cb")]);
        assert_eq!(error_redirect(&store, ACCOUNT, &elsewhere, &crate::cause!(Error::InvalidRedirectUri)), None);
        assert_eq!(error_redirect(&store, ACCOUNT, &elsewhere, &Error::InvalidRequest("x", crate::cause!())), None,
            "a redirect URI that is not the client's is never answered at");
    }

    #[test]
    fn decide_allow_redirects_with_the_code_and_state_and_keeps_the_query() {
        let memory = memory();
        let store = Store::new(&memory);
        let answer = register_app(&store, r#"{"redirect_uris":["https://app.example/cb?lang=en"]}"#).unwrap();
        let client_id = answer["client_id"].as_str().unwrap();
        let request = authorize(
            &store,
            ACCOUNT,
            &pairs(&[("response_type", "code"), ("client_id", client_id), ("code_challenge", CHALLENGE), ("code_challenge_method", "S256"), ("state", "xyz")]),
        )
        .unwrap();
        let url = Url::parse(&decide(&store, ACCOUNT, &request, true, None).unwrap()).unwrap();
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(url.host_str(), Some("app.example"));
        assert!(query.contains(&("lang".into(), "en".into())));
        assert!(query.contains(&("state".into(), "xyz".into())));
        assert_eq!(query.iter().filter(|(k, _)| k == "code").count(), 1);
    }

    #[test]
    fn decide_deny_redirects_with_access_denied_and_the_state() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let request = ask(&store, &client_id);
        let url = Url::parse(&decide(&store, ACCOUNT, &request, false, None).unwrap()).unwrap();
        let query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(query, vec![("error".to_string(), "access_denied".to_string()), ("state".to_string(), "xyz".to_string())]);
        assert!(store.list::<Token>(Family::Tokens, ACCOUNT, usize::MAX).unwrap().is_empty());
    }

    #[test]
    fn decide_consumes_the_request_and_refuses_unknown_expired_or_foreign_ones() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let request = ask(&store, &client_id);
        let unknown = || Error::InvalidRequest("the request is unknown or has expired", crate::cause!());
        assert_eq!(refused(decide(&store, OTHER, &request, true, None)), unknown());
        assert_eq!(refused(decide(&store, ACCOUNT, "no-such-request", true, None)), unknown());
        decide(&store, ACCOUNT, &request, true, None).unwrap();
        assert_eq!(refused(decide(&store, ACCOUNT, &request, true, None)), unknown());

        let expired = random_hex(16);
        store
            .put(
                Family::Requests,
                &Row {
                    id: expired.clone(),
                    account: ACCOUNT.into(),
                    expires_at: 1,
                    value: Request {
                        client_id: client_id.clone(),
                        redirect_uri: REDIRECT.into(),
                        state: None,
                        scopes: vec!["records".into()],
                        code_challenge: CHALLENGE.into(),
                    },
                },
            )
            .unwrap();
        assert_eq!(refused(decide(&store, ACCOUNT, &expired, true, None)), unknown());
        assert!(pending(&store, &expired).unwrap().is_none());
    }

    #[test]
    fn one_grant_per_client_per_account() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let first = sign_in(&store, &client_id);
        let second = sign_in(&store, &client_id);
        assert_ne!(first["access_token"], second["access_token"]);
        let listed = grants(&store, ACCOUNT).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].value.client_id, client_id);
        assert!(grants(&store, OTHER).unwrap().is_empty());
    }

    #[test]
    fn the_exchange_issues_tokens_and_stores_only_their_fingerprints() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let access = answer["access_token"].as_str().unwrap();
        let refresh = answer["refresh_token"].as_str().unwrap();
        assert_eq!(answer["token_type"], "Bearer");
        assert_eq!(answer["expires_in"], super::super::lists::for_tests().access_token_seconds);
        assert_eq!(answer["scope"], "records tools");
        assert!(store.get::<Token>(Family::Tokens, access).unwrap().is_none());
        assert!(store.get::<Token>(Family::Tokens, refresh).unwrap().is_none());
        assert_eq!(store.get::<Token>(Family::Tokens, &sha256_hex(access)).unwrap().unwrap().value.kind, ACCESS);
        assert_eq!(store.get::<Token>(Family::Tokens, &sha256_hex(refresh)).unwrap().unwrap().value.kind, REFRESH);

        let principal = bearer_of(&store, access).expect("the access token is a principal");
        assert_eq!(principal.account, ACCOUNT);
        assert_eq!(principal.client_id.as_deref(), Some(client_id.as_str()));
        assert_eq!(principal.scopes, vec!["records", "tools"]);
        assert!(principal.sign_in.starts_with("grant:"));
        assert!(principal.expires_at_ms > now_ms());
        assert!(bearer(&store, "not-a-token").unwrap().is_none());
        assert!(bearer(&store, "").unwrap().is_none());
    }

    #[test]
    fn a_code_is_spent_by_its_first_exchange_and_its_reuse_revokes_the_grant() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let code = approve(&store, &client_id);
        let answer = exchange(&store, &code, &client_id).unwrap();
        let access = answer["access_token"].as_str().unwrap().to_string();
        let refresh = answer["refresh_token"].as_str().unwrap().to_string();
        assert!(bearer_of(&store, &access).is_some());

        assert_eq!(refused(exchange(&store, &code, &client_id)), crate::cause!(Error::InvalidGrant));
        assert!(bearer_of(&store, &access).is_none());
        assert!(grants(&store, ACCOUNT).unwrap().is_empty());
        assert_eq!(refused(refresh_with(&store, &refresh, &client_id, None)), crate::cause!(Error::InvalidGrant));
    }

    #[test]
    fn a_failed_check_refuses_the_exchange_without_spending_the_code() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let code = approve(&store, &client_id);
        let wrong_verifier = "a".repeat(43);
        let attempt = |redirect: &str, client: &str, verifier: &str| {
            token(
                &store,
                ACCOUNT,
                OWNER,
                &pairs(&[("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect), ("client_id", client), ("code_verifier", verifier)]),
            )
        };
        assert_eq!(refused(attempt(REDIRECT, &client_id, &wrong_verifier)), crate::cause!(Error::InvalidGrant));
        assert_eq!(refused(attempt("https://evil.example/cb", &client_id, VERIFIER)), crate::cause!(Error::InvalidGrant));
        assert_eq!(refused(attempt(REDIRECT, "other-client", VERIFIER)), crate::cause!(Error::InvalidGrant));
        assert!(attempt(REDIRECT, &client_id, VERIFIER).is_ok());
    }

    #[test]
    fn the_exchange_refuses_missing_parameters_and_wrong_codes() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let code = approve(&store, &client_id);
        let missing = [
            ("code", vec![("grant_type", "authorization_code"), ("redirect_uri", REDIRECT), ("client_id", client_id.as_str()), ("code_verifier", VERIFIER)]),
            ("redirect_uri", vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("client_id", client_id.as_str()), ("code_verifier", VERIFIER)]),
            ("client_id", vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", REDIRECT), ("code_verifier", VERIFIER)]),
            ("code_verifier", vec![("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", REDIRECT), ("client_id", client_id.as_str())]),
        ];
        for (name, list) in missing {
            assert!(matches!(refused(token(&store, ACCOUNT, OWNER, &pairs(&list))), Error::InvalidRequest(_, _)), "{name}");
        }
        assert_eq!(refused(exchange(&store, "never-issued", &client_id)), crate::cause!(Error::InvalidGrant));
        assert!(exchange(&store, &code, &client_id).is_ok());
    }

    #[test]
    fn an_expired_code_is_refused() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let grant = random_hex(16);
        store
            .put(
                Family::Grants,
                &Row {
                    id: grant.clone(),
                    account: ACCOUNT.into(),
                    expires_at: 0,
                    value: Grant { client_id: client_id.clone(), scopes: vec!["records".into()], created_at: 1, approved_by: None },
                },
            )
            .unwrap();
        store
            .put(
                Family::Tokens,
                &Row {
                    id: sha256_hex("old-code"),
                    account: ACCOUNT.into(),
                    expires_at: 1,
                    value: Token {
                        kind: CODE.into(),
                        grant_id: grant,
                        client_id: client_id.clone(),
                        scopes: vec!["records".into()],
                        redirect_uri: Some(REDIRECT.into()),
                        code_challenge: Some(CHALLENGE.into()),
                    },
                },
            )
            .unwrap();
        assert_eq!(refused(exchange(&store, "old-code", &client_id)), crate::cause!(Error::InvalidGrant));
    }

    #[test]
    fn refresh_rotates_and_a_reused_refresh_token_revokes_the_grant() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let first = sign_in(&store, &client_id);
        let (access1, refresh1) = (first["access_token"].as_str().unwrap(), first["refresh_token"].as_str().unwrap());

        let original_expiry = store.get::<Token>(Family::Tokens, &sha256_hex(refresh1)).unwrap().unwrap().expires_at;
        let second = refresh_with(&store, refresh1, &client_id, None).unwrap();
        let (access2, refresh2) = (second["access_token"].as_str().unwrap(), second["refresh_token"].as_str().unwrap());
        assert_ne!(refresh1, refresh2);
        assert_eq!(second["scope"], "records tools");
        assert!(bearer_of(&store, access2).is_some());

        let marker = store.get::<Token>(Family::Tokens, &sha256_hex(refresh1)).unwrap().expect("the spent refresh token is remembered");
        assert_eq!(marker.value.kind, USED_REFRESH);
        assert_eq!(marker.expires_at, original_expiry);

        assert_eq!(refused(refresh_with(&store, refresh1, &client_id, None)), crate::cause!(Error::InvalidGrant));
        assert!(bearer_of(&store, access1).is_none());
        assert!(bearer_of(&store, access2).is_none());
        assert_eq!(refused(refresh_with(&store, refresh2, &client_id, None)), crate::cause!(Error::InvalidGrant));
        assert!(grants(&store, ACCOUNT).unwrap().is_empty());
    }

    #[test]
    fn token_lifetimes_are_the_accounts_own_row_and_a_missing_row_spends_nothing() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let first = sign_in(&store, &client_id);
        assert_eq!(first["expires_in"], 3600);
        // The owner shortens the access token: the next token uses it.
        let mut shorter = crate::account::sign_in::lists::for_tests();
        shorter.access_token_seconds = 60;
        crate::account::sign_in::lists::set(&store, ACCOUNT, 1, shorter).unwrap();
        let second = refresh_with(&store, first["refresh_token"].as_str().unwrap(), &client_id, None).unwrap();
        assert_eq!(second["expires_in"], 60);
        // With no row, a refresh is refused with the row's code and its token is not spent.
        let refresh = second["refresh_token"].as_str().unwrap();
        store.remove(Family::Lists, &format!("settings:sign-in:{ACCOUNT}")).unwrap();
        assert_eq!(refused(refresh_with(&store, refresh, &client_id, None)), crate::cause!(Error::SettingsMissing));
        assert_eq!(error_body(&crate::cause!(Error::SettingsMissing))["code"], "sign_in_settings_missing");
        assert_eq!(store.get::<Token>(Family::Tokens, &sha256_hex(refresh)).unwrap().unwrap().value.kind, REFRESH);
        crate::account::sign_in::lists::set(&store, ACCOUNT, 0, crate::account::sign_in::lists::for_tests()).unwrap();
        assert_eq!(refresh_with(&store, refresh, &client_id, None).unwrap()["expires_in"], 3600);
    }

    #[test]
    fn a_refresh_scope_may_narrow_but_not_widen() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let refresh = answer["refresh_token"].as_str().unwrap().to_string();
        assert_eq!(refused(refresh_with(&store, &refresh, &client_id, Some("records admin"))), Error::InvalidRequest("scope is not offered here", crate::cause!()));
        let narrowed = refresh_with(&store, &refresh, &client_id, Some("records")).unwrap();
        assert_eq!(narrowed["scope"], "records");
        assert_eq!(bearer_of(&store, narrowed["access_token"].as_str().unwrap()).unwrap().scopes, vec!["records"]);
    }

    #[test]
    fn an_unknown_or_mismatched_refresh_token_is_refused_and_spends_nothing() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let refresh = answer["refresh_token"].as_str().unwrap().to_string();
        assert_eq!(refused(refresh_with(&store, "never-issued", &client_id, None)), crate::cause!(Error::InvalidGrant));
        assert_eq!(refused(refresh_with(&store, &refresh, "other-client", None)), crate::cause!(Error::InvalidGrant));
        assert!(refresh_with(&store, &refresh, &client_id, None).is_ok());
        let missing = token(&store, ACCOUNT, OWNER, &pairs(&[("grant_type", "refresh_token"), ("client_id", client_id.as_str())]));
        assert!(matches!(refused(missing), Error::InvalidRequest(_, _)));
    }

    #[test]
    fn an_expired_refresh_token_is_refused() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let refresh = answer["refresh_token"].as_str().unwrap().to_string();
        let row = store.get::<Token>(Family::Tokens, &sha256_hex(&refresh)).unwrap().unwrap();
        store.put(Family::Tokens, &Row { expires_at: 1, ..row }).unwrap();
        assert_eq!(refused(refresh_with(&store, &refresh, &client_id, None)), crate::cause!(Error::InvalidGrant));
    }

    #[test]
    fn other_grant_types_are_unsupported() {
        let memory = memory();
        let store = Store::new(&memory);
        let refusal = token(&store, ACCOUNT, OWNER, &pairs(&[("grant_type", "client_credentials")]));
        assert_eq!(refused(refusal), crate::cause!(Error::UnsupportedGrantType));
    }

    #[test]
    fn revoke_removes_an_access_token_only() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let (access, refresh) = (answer["access_token"].as_str().unwrap(), answer["refresh_token"].as_str().unwrap());
        revoke(&store, &pairs(&[("token", access)])).unwrap();
        assert!(bearer_of(&store, access).is_none());
        assert!(refresh_with(&store, refresh, &client_id, None).is_ok());
    }

    #[test]
    fn revoke_of_a_refresh_token_disconnects_the_grant() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let (access, refresh) = (answer["access_token"].as_str().unwrap().to_string(), answer["refresh_token"].as_str().unwrap().to_string());
        revoke(&store, &pairs(&[("token", refresh.as_str()), ("token_type_hint", "refresh_token")])).unwrap();
        assert!(bearer_of(&store, &access).is_none());
        assert!(grants(&store, ACCOUNT).unwrap().is_empty());
        assert_eq!(refused(refresh_with(&store, &refresh, &client_id, None)), crate::cause!(Error::InvalidGrant));
    }

    #[test]
    fn revoke_answers_ok_for_an_unknown_token_and_refuses_a_missing_one() {
        let memory = memory();
        let store = Store::new(&memory);
        assert!(revoke(&store, &pairs(&[("token", "never-issued")])).is_ok());
        assert!(matches!(refused(revoke(&store, &pairs(&[]))), Error::InvalidRequest(_, _)));
    }

    #[test]
    fn a_bearer_fails_once_its_grant_is_disconnected_or_its_token_expired() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        let answer = sign_in(&store, &client_id);
        let access = answer["access_token"].as_str().unwrap().to_string();
        let listed = grants(&store, ACCOUNT).unwrap();
        assert_eq!(listed.len(), 1);
        let grant_id = listed[0].id.clone();

        assert!(!disconnect(&store, OTHER, &grant_id).unwrap());
        assert!(bearer_of(&store, &access).is_some());
        assert!(disconnect(&store, ACCOUNT, &grant_id).unwrap());
        assert!(bearer_of(&store, &access).is_none());
        assert!(!disconnect(&store, ACCOUNT, &grant_id).unwrap());
        assert!(grants(&store, ACCOUNT).unwrap().is_empty());

        let answer = sign_in(&store, &client_id);
        let live = answer["access_token"].as_str().unwrap().to_string();
        let grant_id = grants(&store, ACCOUNT).unwrap()[0].id.clone();
        store
            .put(
                Family::Tokens,
                &Row {
                    id: sha256_hex("expired-access"),
                    account: ACCOUNT.into(),
                    expires_at: 1,
                    value: Token {
                        kind: ACCESS.into(),
                        grant_id,
                        client_id: client_id.clone(),
                        scopes: vec!["records".into()],
                        redirect_uri: None,
                        code_challenge: None,
                    },
                },
            )
            .unwrap();
        assert!(bearer_of(&store, "expired-access").is_none());
        assert!(bearer_of(&store, &live).is_some());
    }

    #[test]
    fn the_grant_list_is_per_account() {
        let memory = memory();
        let store = Store::new(&memory);
        let client_id = app(&store);
        sign_in(&store, &client_id);
        assert_eq!(grants(&store, ACCOUNT).unwrap().len(), 1);
        assert!(grants(&store, OTHER).unwrap().is_empty());
    }

    #[test]
    fn invalid_public_client_conditions_keep_distinct_exact_causes() {
        let wrong_prefix = public_client("private-client-without-the-public-prefix").unwrap_err();
        let oversized = public_client(&format!("{}{}", public_settings().prefix,
            "x".repeat(public_settings().max_id_bytes + 1))).unwrap_err();
        assert!(matches!(wrong_prefix, Error::InvalidClient(_)));
        assert!(matches!(oversized, Error::InvalidClient(_)));
        assert_ne!(wrong_prefix.cause(), oversized.cause());
        let source = include_str!("oauth.rs");
        let first_line = source.lines().nth(wrong_prefix.cause().line() as usize - 1).unwrap();
        let second_line = source.lines().nth(oversized.cause().line() as usize - 1).unwrap();
        assert!(first_line.contains("id.strip_prefix"));
        assert!(second_line.contains("encoded.len() > public_settings().max_id_bytes"));
        for error in [wrong_prefix, oversized] {
            let cause = error.cause();
            let body = error_body(&error);
            assert_eq!(body["error"], "invalid_client");
            assert_eq!(body["cause"], cause.id());
            assert_eq!(cause.file(), "src/account/sign_in/oauth.rs");
            assert!(!body.to_string().contains("private-client-without-the-public-prefix"));
        }
    }

    #[test]
    fn source_cause_survives_sign_in_known_and_ways_classification() {
        let original = crate::cause!(Error::SettingsMissing);
        let cause = original.cause();
        let known = super::super::known::Refused::from(original.clone());
        let ways = super::super::ways::Refused::from(original);
        assert_eq!(known.cause(), cause);
        assert_eq!(ways.cause(), cause);
        assert!(matches!(known, super::super::known::Refused::Storage(_)));
        assert!(matches!(ways, super::super::ways::Refused::Missing(_)));
    }

    #[test]
    fn error_body_carries_the_rfc_6749_codes() {
        let code = |error: Error| error_body(&error)["error"].as_str().unwrap().to_string();
        assert_eq!(code(Error::InvalidRequest("x", crate::cause!())), "invalid_request");
        assert_eq!(code(Error::InvalidClientMetadata("x", crate::cause!())), "invalid_client_metadata");
        assert_eq!(code(crate::cause!(Error::InvalidRedirectUri)), "invalid_redirect_uri");
        assert_eq!(code(crate::cause!(Error::InvalidClient)), "invalid_client");
        assert_eq!(code(crate::cause!(Error::InvalidGrant)), "invalid_grant");
        assert_eq!(code(crate::cause!(Error::UnsupportedGrantType)), "unsupported_grant_type");
        assert_eq!(code(crate::cause!(Error::Unauthenticated)), "invalid_token");
        assert_eq!(code(crate::cause!(Error::Storage)), "server_error");
        assert_eq!(code(crate::cause!(Error::SourceNotCurrent)), "server_error");
        let body = error_body(&crate::cause!(Error::InvalidGrant));
        assert!(body["error_description"].as_str().unwrap().len() > 0);
    }

    fn fixed_client(id: &str, redirect: &str) -> FixedClient {
        FixedClient { client_id: id.into(), client_name: "Connector app".into(), redirect_uris: vec![redirect.into()] }
    }

    #[test]
    fn a_fixed_client_the_owner_adds_signs_in_like_a_registered_one_with_its_exact_redirect_only() {
        let mem = memory();
        let store = Store::new(&mem);
        let added = add_fixed(&store, ACCOUNT, fixed_client("connector-app", REDIRECT)).unwrap();
        assert_eq!(added["client_id"], "connector-app");
        assert_eq!(added["token_endpoint_auth_method"], "none");
        let row = store.get::<Client>(Family::Clients, "connector-app").unwrap().unwrap();
        assert_eq!((row.expires_at, row.value.fixed), (0, true), "it never expires");
        let answer = sign_in(&store, "connector-app");
        assert!(bearer_of(&store, answer["access_token"].as_str().unwrap()).is_some());
        assert_eq!(fixed(&store, ACCOUNT).unwrap(), vec![added]);
        // Only its exact redirect address receives a sign-in.
        let other = authorize(&store, ACCOUNT, &pairs(&[
            ("response_type", "code"), ("client_id", "connector-app"), ("redirect_uri", "https://app.example/other"),
            ("code_challenge", CHALLENGE), ("code_challenge_method", "S256"),
        ]));
        assert_eq!(refused(other), crate::cause!(Error::InvalidRedirectUri));
    }

    #[test]
    fn a_fixed_client_is_refused_a_taken_or_malformed_id_and_bad_redirects_and_its_removal_ends_its_grant() {
        let mem = memory();
        let store = Store::new(&mem);
        let registered = app(&store);
        assert!(matches!(add_fixed(&store, ACCOUNT, fixed_client(&registered, REDIRECT)), Err(Error::InvalidClientMetadata(_, _))), "a registered id is not taken");
        for id in ["", "has space", "slash/id", &"x".repeat(65)] {
            assert!(matches!(add_fixed(&store, ACCOUNT, fixed_client(id, REDIRECT)), Err(Error::InvalidClientMetadata(_, _))), "{id:?}");
        }
        for redirect in ["http://app.example/callback", "https://app.example/cb#frag", "not a url"] {
            assert_eq!(add_fixed(&store, ACCOUNT, fixed_client("ok-id", redirect)), Err(crate::cause!(Error::InvalidRedirectUri)), "{redirect}");
        }
        let mut blank = fixed_client("ok-id", REDIRECT);
        blank.client_name = "  ".into();
        assert!(matches!(add_fixed(&store, ACCOUNT, blank), Err(Error::InvalidClientMetadata(_, _))));
        add_fixed(&store, ACCOUNT, fixed_client("ok-id", REDIRECT)).unwrap();
        assert!(matches!(add_fixed(&store, ACCOUNT, fixed_client("ok-id", REDIRECT)), Err(Error::InvalidClientMetadata(_, _))), "added once");

        let answer = sign_in(&store, "ok-id");
        let access = answer["access_token"].as_str().unwrap();
        assert!(!remove_fixed(&store, ACCOUNT, &registered).unwrap(), "a registered client is not removed here");
        assert!(!remove_fixed(&store, "someone-else", "ok-id").unwrap(), "another account removes nothing of this one");
        assert!(remove_fixed(&store, ACCOUNT, "ok-id").unwrap());
        assert!(bearer_of(&store, access).is_none(), "its grant ends with it");
        assert!(fixed(&store, ACCOUNT).unwrap().is_empty());
        assert!(!remove_fixed(&store, ACCOUNT, "ok-id").unwrap());
    }

    #[test]
    fn a_grant_keeps_how_the_person_approved_it() {
        let mem = memory();
        let store = Store::new(&mem);
        let client = app(&store);
        let request = ask(&store, &client);
        decide_by(&store, ACCOUNT, &request, true, None, Some("email-code"), None).unwrap();
        let grant = grants(&store, ACCOUNT).unwrap().remove(0);
        assert_eq!(
            approved_by(&store, &grant.id).unwrap().as_deref(), Some("email-code"));
        let request = ask(&store, &client);
        decide(&store, ACCOUNT, &request, true, None).unwrap();
        assert_eq!(approved_by(&store, &grant.id).unwrap(), None, "a later approval says how it was approved");
    }

}
