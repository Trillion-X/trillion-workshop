// tools/add-tool-source/do-work/sign-in.mjs
//
// Purpose: A person signs in to a remote tool server that asks for OAuth 2.1, as the Model Context Protocol describes, and
// the sign-in's token is kept in their vault for the engine to use (tool:add-tool-source, the one tool of the job).
//
//   1. start: from the server's 401 challenge find where its sign-in lives (its protected-resource document, RFC 9728,
//      then its authorization server's metadata, RFC 8414 or OpenID discovery), register this caller once (RFC 7591
//      dynamic registration: a public client with no secret), and answer the authorization address with a PKCE S256
//      challenge, the server named as the resource (RFC 8707) and a `state` only this sign-in knows.
//   2. finish: the page the person comes back to hands in `state` and `code`; the pending record is removed first (a
//      state is used once), the code is traded by the trade row (an http row: the tokens are kept in the vault by the engine
//      and never reach this program), and the request for the person's approval is written with the entry the engine reads
//      (`remote.sign_in`: the one address its tokens are refreshed at).
//
// Non-Negotiable Invariants:
// - No token, code verifier or secret is in any answer or log: the verifier waits in the pending record and goes to the trade
//   row; the tokens are only ever a held word here.
// - A state is kept only as its digest, used once, and expires.
// - A server whose authorization server does not offer PKCE S256, or whose sign-in documents are not https, or whose
//   authorization server does not let a new caller register, is refused in one plain line. Every address comes from the
//   server's own documents; nothing is guessed.
// - The address the person is sent back to is the sign-in tool's own setting (`sign_in.redirect_setting`), never an input.
// - A source is kept only by the person's own approval (the engine's tools:add-source), never by this sign-in.
//
// Security Considerations: PKCE's S256 is SHA-256 because RFC 7636 requires exactly that; it is not an identity this owner
// mints (the state's digest is BLAKE3, content-identity).
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import { createHash, randomBytes } from 'node:crypto';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from '../read-data/add-tool-source.json' with { type: 'json' };
import { ask, read } from './ask-the-web.mjs';

const { sign_in: signIn, row, words } = data;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const refuse = (key, values = {}) => { throw new Error(fill(words[key], values)); };
const https = address => { try { return new URL(address).protocol === 'https:'; } catch { return false; } };
const digest = text => makeHashCodeHexFromBytes(Buffer.from(text));
const pendingId = state => `${signIn.pending.prefix}${digest(state)}`;
const connectionOf = label => `${signIn.connection_prefix}${label}`;

async function readJson(send, address) {
  try {
    const reply = await ask(send, address, { headers: { accept: 'application/json' } });
    if (reply.status !== 200) return null;
    const value = JSON.parse(await read(reply));
    return object(value) ? value : null;
  } catch { return null; }
}

// RFC 8414 section 3 and RFC 9728 section 3: the well-known segment goes between the host and the path.
const wellKnown = (address, name) => {
  const url = new URL(address);
  return `${url.origin}/.well-known/${name}${url.pathname.replace(/\/$/, '')}`;
};

/** Where a server's sign-in lives: from its 401 challenge `{ resource_metadata, scope }`, else the well-known addresses. */
export async function discover(server, challenge, send) {
  const d = signIn.discovery;
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
  if (metadata[d.issuer] && metadata[d.issuer] !== issuer) refuse('issuer_mismatch', { host: new URL(issuer).host });
  if (!(metadata[d.pkce_methods] ?? []).includes(d.pkce_method)) refuse('no_pkce', { host: new URL(issuer).host });
  const endpoints = [metadata[d.authorization_endpoint], metadata[d.token_endpoint]];
  if (!endpoints.every(https)) refuse('sign_in_not_https', { host: new URL(issuer).host });
  return {
    issuer,
    authorization_endpoint: String(endpoints[0]),
    token_endpoint: String(endpoints[1]),
    registration_endpoint: https(metadata[signIn.registration.endpoint_field]) ? String(metadata[signIn.registration.endpoint_field]) : null,
    scope: challenge.scope ?? (Array.isArray(resource.scopes_supported) ? resource.scopes_supported.join(' ') : null),
    resource: String(resource[d.resource] ?? server),
  };
}

/** Register this caller once with the authorization server (RFC 7591): a public client that signs in by code. */
async function register(found, redirect, send) {
  if (!found.registration_endpoint) refuse('no_registration', { host: new URL(found.issuer).host });
  const r = signIn.registration;
  let client;
  try {
    const reply = await ask(send, found.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ [r.client_name_field]: signIn.client_name, [r.redirect_uris_field]: [redirect], ...r.body, ...(found.scope ? { [r.scope_field]: found.scope } : {}) }),
    });
    client = reply.status === 200 || reply.status === 201 ? JSON.parse(await read(reply)) : null;
  } catch { client = null; }
  const id = client?.[r.client_id_field];
  if (typeof id !== 'string' || !id || /\s/.test(id)) refuse('registration_refused', { host: new URL(found.issuer).host });
  return id;
}

/** The page the person comes back to: the `redirect_uri` the sign-in tool keeps in the person's own settings, https only. */
async function redirectUri(door) {
  const setting = signIn.redirect_setting;
  const kept = await door.readRecord(setting.kind, setting.id);
  const address = kept?.value?.[setting.field];
  if (typeof address !== 'string' || !https(address)) refuse('no_redirect');
  return address;
}

/** Start a sign-in to `entry`'s server: the pending record, and the address the person signs in at. */
export async function startSignIn({ entry, challenge, send, door, now = Date.now() }) {
  const server = entry.remote.url;
  if (!https(server)) refuse('sign_in_not_https', { host: new URL(server).host });
  const redirect = await redirectUri(door);
  const found = await discover(server, challenge, send);
  const clientId = await register(found, redirect, send);
  const state = randomBytes(signIn.state_bytes).toString('hex');
  const verifier = randomBytes(signIn.verifier_bytes).toString('base64url');
  const expires = new Date(now + signIn.pending.seconds * 1000).toISOString();
  const pending = {
    label: entry.label, entry: { ...entry, remote: { ...entry.remote, sign_in: { token_url: found.token_endpoint, client_id: clientId } } },
    resource: found.resource, code_verifier: verifier, redirect_uri: redirect, expires_at: expires,
  };
  const expired = [];
  for await (const held of door.list({ type: signIn.pending.type })) {
    if (!(Date.parse(held.value?.expires_at) > now)) expired.push({ id: held.id, type: signIn.pending.type, value: null, expected: { type: signIn.pending.type, value: held.value } });
  }
  const id = pendingId(state);
  await door.write([{ id, type: signIn.pending.type, value: pending, expected: null }, ...expired], { key: `sign-in-start:${id}` });
  const address = new URL(found.authorization_endpoint);
  const challengeText = createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirect, state, code_challenge: challengeText, code_challenge_method: signIn.discovery.pkce_method, resource: found.resource, ...(found.scope ? { scope: found.scope } : {}) };
  for (const [name, value] of Object.entries(params)) address.searchParams.set(name, value);
  return { authorize_url: address.toString(), expires_at: expires, host: new URL(found.issuer).host };
}

/** The person came back with `{ state, code, error }`: trade the code, and write the request for their approval. */
export async function finishSignIn({ callback, door, now = Date.now() }) {
  if (!object(callback) || typeof callback.state !== 'string' || !callback.state) refuse('sign_in_expired');
  const id = pendingId(callback.state);
  const held = await door.readRecord(signIn.pending.type, id);
  if (!held) refuse('sign_in_expired');
  // Used once: removed, conditional on what was read, before anything else.
  await door.write([{ id, type: signIn.pending.type, value: null, expected: held }], { key: `sign-in-finish:${id}` });
  const pending = held.value;
  if (!(Date.parse(pending.expires_at) > now)) refuse('sign_in_expired');
  const { entry } = pending;
  if (callback.error || typeof callback.code !== 'string' || !callback.code) refuse('sign_in_refused', { label: entry.label });
  let traded;
  try {
    traded = await door.run(signIn.trade_tool, {
      connection: { connection_id: connectionOf(entry.label) }, token_url: entry.remote.sign_in.token_url, code: callback.code,
      redirect_uri: pending.redirect_uri, code_verifier: pending.code_verifier, client_id: entry.remote.sign_in.client_id, resource: pending.resource,
    }, { key: `sign-in-trade:${id}` });
  } catch (error) {
    refuse('sign_in_not_traded', { label: entry.label, why: String(error?.said ?? error?.message ?? 'it was refused').slice(0, 200) });
  }
  if (!object(traded)) refuse('sign_in_not_traded', { label: entry.label, why: 'it answered nothing' });
  const approve = { address: data.approve.address, method: data.approve.method, input: { entry, learned: 'probe' } };
  const requestId = `${row.prefix}${entry.label}`;
  await door.write([{ id: requestId, type: row.kind, value: { label: entry.label, address: entry.remote.url, kind: entry.kind, learned: 'probe', entry, approve, status: row.waiting } }], { key: `add-tool-source:${entry.label}:signed-in` });
  return { source: { label: entry.label, kind: entry.kind, learned: 'probe', row: requestId }, entry, approve, said: fill(words.signed_in, { label: entry.label }) };
}
