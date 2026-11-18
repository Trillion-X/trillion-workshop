// tools/connect-a-service-and-seal-its-key/do-work/sign-in-to-a-tool-server.mjs
//
// Purpose: A person signs in to a remote tool server that asks for OAuth 2.1, as the Model Context Protocol describes, so any
// AI can then call the server's tools by its address (tools:list and tools:run with {address}). The command line's connect
// runs it on the person's own computer (tools/use-your-tools-from-a-shell):
//   1. `discover(server)`: from the server's 401 challenge (its `resource_metadata` and `scope`), else its well-known
//      addresses, find its protected-resource document (RFC 9728) and its authorization server's metadata (RFC 8414 or
//      OpenID discovery).
//   2. `register(found, redirect)`: register this caller once as a public client (RFC 7591) whose redirect is the loopback
//      address the command listens on (RFC 8252 section 7.3).
//   3. `authorizeAddress(...)`: the address the person signs in at, with a PKCE S256 challenge, the server named as the
//      resource (RFC 8707) and a `state` only this sign-in knows.
//   4. `tradeInput(...)`: the input of `trade_tool` (tool:trade-a-tool-servers-sign-in-code-for-its-tokens), an http row the
//      person's engine runs: it trades the code and keeps the tokens, the token address and the client id as the fields of
//      the connection `connection_prefix` + the server's host, so this program never holds a token.
// Moved from tools/add-tool-source/do-work/sign-in.mjs on Nov 18 2026, when the tool-source list was deleted (no-tool-source-list
// plan T6); its pending record and the records door it wrote through are gone: the command holds the verifier and the state in
// memory while it waits for the one callback.
//
// Non-Negotiable Invariants:
// - No token, code verifier or secret is in any answer or log: the verifier goes only to the trade row's input; the tokens are
//   only ever a held word here.
// - A server whose authorization server does not offer PKCE S256, whose sign-in documents are not https, or which does not let
//   a new caller register, is refused in one plain line. Every address comes from the server's own documents; nothing is guessed.
// - The connection is named by the server's host, the label the engine gives a server called by its address.
//
// Security Considerations: PKCE's S256 is SHA-256 because RFC 7636 requires exactly that; it is not an identity this owner
// mints.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { createHash, randomBytes } from 'node:crypto';
import data from '../read-data/tool-server-sign-in.json' with { type: 'json' };

const { discovery: d, registration: r, probe, words } = data;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const refuse = (key, values = {}) => { throw new Error(fill(words[key], values)); };
const https = address => { try { return new URL(address).protocol === 'https:'; } catch { return false; } };

/** One request, bounded, with no credential, following at most `max_redirects` redirects each to https. */
async function ask(send, address, init = {}) {
  let at = address;
  for (let followed = 0; ; followed += 1) {
    const reply = await send(at, { ...init, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(probe.timeout_ms) });
    const next = [301, 302, 303, 307, 308].includes(reply.status) ? reply.headers.get('location') : null;
    if (!next) return reply;
    if (followed >= probe.max_redirects) throw new Error('followed too many redirects');
    at = new URL(next, at);
    if (at.protocol !== 'https:') throw new Error('was sent to an address that is not https');
    at = at.href;
  }
}

async function readJson(send, address, init) {
  try {
    const reply = await ask(send, address, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
    if (reply.status !== 200 && reply.status !== 201) return null;
    const text = (await reply.text()).slice(0, probe.max_bytes);
    const value = JSON.parse(text);
    return object(value) ? value : null;
  } catch { return null; }
}

// RFC 8414 section 3 and RFC 9728 section 3: the well-known segment goes between the host and the path.
const wellKnown = (address, name) => {
  const url = new URL(address);
  return `${url.origin}/.well-known/${name}${url.pathname.replace(/\/$/, '')}`;
};

/** The `resource_metadata` and `scope` of a `WWW-Authenticate: Bearer ...` challenge, quoted or bare. */
export function challengeOf(header) {
  const found = {};
  for (const [, name, quoted, bare] of String(header ?? '').matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) found[name] = quoted ?? bare;
  return { resource_metadata: found.resource_metadata ?? null, scope: found.scope ?? null };
}

/** Where a server's sign-in lives: asked first with an initialize the server answers 401, then its documents. */
export async function discover(server, { send = fetch } = {}) {
  if (!https(server)) refuse('sign_in_not_https', { host: new URL(server).host });
  let challenge = { resource_metadata: null, scope: null };
  try {
    const reply = await ask(send, server, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'connect', version: '1' } } }) });
    if (reply.status === 401) challenge = challengeOf(reply.headers.get('www-authenticate'));
  } catch { /* the documents are still asked */ }
  const candidates = [challenge.resource_metadata, wellKnown(server, d.resource_well_known), `${new URL(server).origin}/.well-known/${d.resource_well_known}`].filter(Boolean);
  let resource = null;
  for (const address of candidates) {
    if (!https(address)) continue;
    const found = await readJson(send, address);
    if (found && Array.isArray(found[d.authorization_servers]) && found[d.authorization_servers].length) { resource = found; break; }
  }
  if (!resource) refuse('no_sign_in_document', { host: new URL(server).host });
  const issuer = String(resource[d.authorization_servers][0]);
  if (!https(issuer)) refuse('sign_in_not_https', { host: new URL(server).host });
  let metadata = null;
  for (const name of d.issuer_well_known) {
    for (const address of [wellKnown(issuer, name), `${issuer.replace(/\/$/, '')}/.well-known/${name}`]) {
      const found = await readJson(send, address);
      if (found && found[d.authorization_endpoint] && found[d.token_endpoint]) { metadata = found; break; }
    }
    if (metadata) break;
  }
  if (!metadata) refuse('no_issuer_document', { host: new URL(issuer).host });
  if (metadata[d.issuer] && metadata[d.issuer].replace(/\/$/, '') !== issuer.replace(/\/$/, '')) refuse('issuer_mismatch', { host: new URL(issuer).host });
  if (!(metadata[d.pkce_methods] ?? []).includes(d.pkce_method)) refuse('no_pkce', { host: new URL(issuer).host });
  const endpoints = [metadata[d.authorization_endpoint], metadata[d.token_endpoint]];
  if (!endpoints.every(https)) refuse('sign_in_not_https', { host: new URL(issuer).host });
  return {
    host: new URL(server).hostname,
    issuer,
    authorization_endpoint: String(endpoints[0]),
    token_endpoint: String(endpoints[1]),
    registration_endpoint: https(metadata[r.endpoint_field]) ? String(metadata[r.endpoint_field]) : null,
    scope: challenge.scope ?? (Array.isArray(resource.scopes_supported) ? resource.scopes_supported.join(' ') : null),
    resource: String(resource[d.resource] ?? server),
  };
}

/** Register this caller once with the authorization server (RFC 7591): a public client that signs in by code, under `name` (the
 *  caller's own site name: a shared tool names no product). */
export async function register(found, redirect, { send = fetch, name } = {}) {
  if (typeof name !== 'string' || !name) throw new Error('register needs the name the caller signs in as');
  if (!found.registration_endpoint) refuse('no_registration', { host: new URL(found.issuer).host });
  const client = await readJson(send, found.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [r.client_name_field]: name, [r.redirect_uris_field]: [redirect], ...r.body, ...(found.scope ? { [r.scope_field]: found.scope } : {}) }),
  });
  const id = client?.[r.client_id_field];
  if (typeof id !== 'string' || !id || /\s/.test(id)) refuse('registration_refused', { host: new URL(found.issuer).host });
  return id;
}

/** A fresh state and PKCE verifier for one sign-in. */
export function freshSignIn(random = randomBytes) {
  return { state: random(data.state_bytes).toString('hex'), verifier: random(data.verifier_bytes).toString('base64url') };
}

/** The address the person signs in at. */
export function authorizeAddress(found, clientId, redirect, { state, verifier }) {
  const address = new URL(found.authorization_endpoint);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: d.pkce_method, resource: found.resource, ...(found.scope ? { scope: found.scope } : {}) };
  for (const [name, value] of Object.entries(params)) address.searchParams.set(name, value);
  return address.toString();
}

/** The connection the server's sign-in is kept under: the prefix and the server's host. */
export const connectionOf = host => `${data.connection_prefix}${host}`;

/** The trade row's input for the code the person's callback handed back (`callback`: its query, as an object). */
export function tradeInput(found, clientId, redirect, { state, verifier }, callback) {
  if (!object(callback) || callback.state !== state) refuse('sign_in_expired');
  if (callback.error || typeof callback.code !== 'string' || !callback.code) refuse('sign_in_refused', { label: found.host });
  return { connection: { connection_id: connectionOf(found.host) }, token_url: found.token_endpoint, code: callback.code, redirect_uri: redirect,
    code_verifier: verifier, client_id: clientId, resource: found.resource };
}

/** The tool that trades the code. */
export const TRADE_TOOL = data.trade_tool;
