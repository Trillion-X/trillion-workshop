// packages/ai-tool-catalog/do-work/sign-in-to-a-tool-server.mjs
//
// A person signs in to a remote tool server that asks for OAuth 2.1, the way the Model Context Protocol describes:
//   1. find where the server's sign-in lives: its protected-resource document (RFC 9728, named by the 401 challenge
//      or at the well-known address), then its authorization server's metadata (RFC 8414, or OpenID discovery);
//   2. register this caller once per server (RFC 7591 dynamic registration, a public client with no secret);
//   3. send the person to the authorization page with a PKCE S256 challenge and the server named as the resource
//      (RFC 8707), and a `state` that only this sign-in knows;
//   4. build the token requests: the code exchange, and a refresh whose refresh token is placed by the caller's
//      locked box as a form field, so the refresh token never passes through here.
//
// Nothing here stores anything or sends a request it was not handed: `request` is the caller's fetch. The caller keeps
// the client id, the verifier, and the tokens where it keeps secrets. PKCE's S256 is SHA-256 because RFC 7636
// requires exactly that; it is not an identity.
//
// Invariants: a server whose authorization server does not offer S256 is refused (OAuth 2.1 requires PKCE); every
// address comes from the server's own documents, and an authorization server on another host is used only because
// the protected resource names it.

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function readJson(request, url) {
  const response = await request(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) return null;
  try { return await response.json(); } catch { return null; }
}

// RFC 8414 section 3 and RFC 9728 section 3: the well-known segment goes between the host and the path.
const wellKnown = (address, name) => {
  const url = new URL(address);
  const path = url.pathname.replace(/\/$/, '');
  return `${url.origin}/.well-known/${name}${path}`;
};

/**
 * Where a tool server's sign-in lives.
 *   server     the tool server's address
 *   challenge  `{ resource_metadata, scope }` from its 401 answer, when there was one
 */
export async function discoverSignIn({ server, challenge = {}, request = fetch }) {
  const candidates = [challenge.resource_metadata, wellKnown(server, 'oauth-protected-resource'), `${new URL(server).origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let resource = null;
  for (const url of candidates) {
    resource = await readJson(request, url);
    if (object(resource) && Array.isArray(resource.authorization_servers) && resource.authorization_servers.length) break;
    resource = null;
  }
  if (!resource) throw new Error(`${new URL(server).host} does not say where its sign-in is.`);
  const issuer = String(resource.authorization_servers[0]);
  let metadata = null;
  for (const url of [wellKnown(issuer, 'oauth-authorization-server'), wellKnown(issuer, 'openid-configuration'), `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`]) {
    metadata = await readJson(request, url);
    if (object(metadata) && metadata.authorization_endpoint && metadata.token_endpoint) break;
    metadata = null;
  }
  if (!metadata) throw new Error(`${new URL(issuer).host} does not publish its sign-in addresses.`);
  if (!(metadata.code_challenge_methods_supported ?? []).includes('S256')) throw new Error(`${new URL(issuer).host} does not offer the sign-in protection every OAuth 2.1 client must use (PKCE S256), so no sign-in is started.`);
  return {
    server,
    resource: String(resource.resource ?? server),
    issuer: String(metadata.issuer ?? issuer),
    authorization_endpoint: String(metadata.authorization_endpoint),
    token_endpoint: String(metadata.token_endpoint),
    ...(metadata.registration_endpoint ? { registration_endpoint: String(metadata.registration_endpoint) } : {}),
    scope: challenge.scope ?? (Array.isArray(resource.scopes_supported) ? resource.scopes_supported.join(' ') : null),
  };
}

/** Register this caller with the authorization server once (RFC 7591): a public client that signs in by code. */
export async function registerClient({ found, redirect_uri, client_name, request = fetch }) {
  if (!found.registration_endpoint) throw new Error(`${new URL(found.issuer).host} does not let a new caller register itself, so it needs a client id made on its own site first.`);
  const response = await request(found.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name, redirect_uris: [redirect_uri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', ...(found.scope ? { scope: found.scope } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.client_id !== 'string') throw new Error(`${new URL(found.issuer).host} refused to register this caller (${response.status})${typeof body?.error_description === 'string' ? `: ${body.error_description}` : ''}. Some servers admit only the apps they have approved; such a server is used from one of those apps, or once it approves this one.`);
  return { client_id: body.client_id };
}

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge (RFC 7636 section 4). */
export async function pkcePair(random = crypto.getRandomValues.bind(crypto)) {
  const verifier = base64url(random(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** The address the person opens to sign in. */
export function authorizationAddress({ found, client_id, redirect_uri, challenge, state }) {
  const url = new URL(found.authorization_endpoint);
  const fields = {
    response_type: 'code', client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: found.resource,
    ...(found.scope ? { scope: found.scope } : {}),
  };
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return url.href;
}

const form = fields => new URLSearchParams(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)).toString();

/**
 * The code exchange, as a request for the caller's locked box to send: the PKCE verifier is named, and the box places
 * it as the `code_verifier` form field.
 */
export function codeExchange({ found, client_id, code, verifier_name, redirect_uri }) {
  return {
    url: found.token_endpoint, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form({ grant_type: 'authorization_code', code, client_id, redirect_uri, resource: found.resource }),
    credential_injections: [{ secret_name: verifier_name, placement: { kind: 'form_field', name: 'code_verifier' } }],
  };
}

/**
 * A refresh, as a request for the caller's locked box to send: the refresh token is named, and the box places it as
 * the `refresh_token` form field.
 */
export function refreshRequest({ found, client_id, refresh_token_name }) {
  return {
    url: found.token_endpoint, method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form({ grant_type: 'refresh_token', client_id, resource: found.resource }),
    credential_injections: [{ secret_name: refresh_token_name, placement: { kind: 'form_field', name: 'refresh_token' } }],
  };
}

/** The tokens in a token endpoint's answer, and when the access token stops working. */
export function tokensFrom(body, now = Date.now()) {
  if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error(`The sign-in answered without an access token${typeof body?.error === 'string' ? `: ${body.error_description ?? body.error}` : ''}.`);
  return {
    access_token: body.access_token,
    ...(typeof body.refresh_token === 'string' && body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    ...(Number(body.expires_in) > 0 ? { expires_at: new Date(now + Number(body.expires_in) * 1000).toISOString() } : {}),
  };
}
