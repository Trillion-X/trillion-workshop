// tools/connect-a-service-and-seal-its-key/do-work/connect-by-signing-in.mjs
//
// Connecting an account by signing in to the service itself: the start sends the person to the service's own sign-in
// page with a state (and a PKCE challenge when the descriptor asks for one), and the callback trades the code the
// service hands back for the tokens, which are kept sealed in the person's vault. Ported from old trillion
// src/connect.mjs handleConnectStart and handleConnectCallback (tag old-trillion-before-worker-retire, Worker wiring
// src/worker.mjs lines 823-835 and 4411; ports/connect-by-signing-in.json). The engine runs this as one
// @workshop-routes tool (trillion-rust src/server/tool-routes.json): input { path, method, query, account_id }, result
// { status, body } (JSON), or { status, body: text, http: { format: 'text' } } for the page the person reads.
//
//   GET /connect/start      query service, each starting value of the new row (the list's choice and boolean fields),
//                           account?, scopes?, wait_seconds?, return_to? -> 200 { authorize_url, service, connection_id,
//                           expires_at }. The engine lets no route tool answer a redirect (trillion-rust
//                           src/server/tool_http_response.rs), so the page or AI opens authorize_url itself.
//   GET /connect/callback   query state, code | error -> a plain page: connected, or why not
//   anything else           404 { error: 'Not found' }
//
// Everything about a service is its descriptor in this folder's records.json (read in
// place): authorize_url, token_url, scopes, scope_separator, auth_params, pkce, the vault NAMES of the sign-in app's id
// and secret, where the service sends the person back, how the new connection is checked (verifyRequest) and which
// field the access token fills. Which services are switched on here, and the http rows that trade each one's code, are
// sign-in-settings.json. Nothing here names a service.
//
// Non-Negotiable Invariants:
// - The code, the tokens and the sign-in app's secret never reach this program: the trade rows place the secret from
//   the vault as their request leaves and keep the reply's tokens in the vault (reply_holds_values) before the reply
//   is read. This program sees only the held word where a token was.
// - A state is kept only as its digest (the pending record's id), and is used once: the callback removes the pending
//   record, conditional on what it read, before anything else, so a second callback with the same state is refused.
// - Nothing sendable is written on a refusal: the connection row is written only after the code was traded and the
//   connection checked, by ONE records:write that already holds the starting values the start was given.
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const settings = JSON.parse(readFileSync(new URL('../sign-in-settings.json', import.meta.url), 'utf8'));
const descriptors = Object.values(JSON.parse(readFileSync(new URL('../records.json', import.meta.url), 'utf8')).things ?? {})
  .map(thing => thing?.payload)
  .filter(payload => payload?.kind === 'service-connection-descriptor' && typeof payload.vendor === 'string');

const encoder = new TextEncoder();
const words = settings.words;
const said = (text, fills = {}) => Object.entries(fills).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, String(value)), text);
const digest = text => makeHashCodeHexFromBytes(Buffer.from(text));
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
const base64url = bytes => Buffer.from(bytes).toString('base64url');
const json = (body, status = 200) => ({ status, body });
// The page the person reads after the service sends them back: plain words, never an active document.
const page = (text, status) => ({ status, body: text, http: { format: 'text', content_type: 'text/plain; charset=utf-8' } });
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const pendingId = state => `${settings.pending.id_prefix}${digest(state)}`;
// A list's rows are records of type record:<row_type>, each with an id under that same prefix.
const rowTypeOf = list => `record:${list.row_type}`;

// The descriptor of a service whose sign-in these routes run: switched on here, signing in on the service's own page
// by a flow listed here, and coming back to this callback.
function signInDescriptor(vendor) {
  const descriptor = descriptors.find(payload => payload.vendor === vendor);
  const acquire = descriptor?.acquire;
  if (!settings.services[vendor] || !acquire || !settings.flows.includes(acquire.flow)) return null;
  if (acquire.redirect?.transport !== 'hosted' || acquire.redirect.path !== settings.routes.callback) return null;
  return descriptor;
}

// The value at the first path that has one (old src/connect.mjs firstAt): a string, or a number as its digits.
const firstAt = (value, paths) => {
  for (const path of paths ?? []) {
    const found = path.reduce((at, part) => (at === undefined || at === null ? undefined : at[part]), value);
    if (typeof found === 'string' && found) return found;
    if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  }
  return null;
};
// The scopes a token reply says were granted (old src/connect.mjs scopesReportedBy), or null when it says none.
function scopesReportedBy(grant, value) {
  const descriptor = grant ?? { response_path: ['scope'], separator: ' ' };
  const path = Array.isArray(descriptor.response_path) ? descriptor.response_path : ['scope'];
  const raw = path.reduce((at, part) => (at === undefined || at === null ? undefined : at[part]), value);
  if (typeof raw !== 'string' && !Array.isArray(raw)) return null;
  const separator = typeof descriptor.separator === 'string' && descriptor.separator ? descriptor.separator : /[\s,]+/;
  const scopes = typeof raw === 'string'
    ? raw.trim().split(separator).filter(Boolean)
    : raw.filter(scope => typeof scope === 'string' && scope.trim()).map(scope => scope.trim());
  return [...new Set(scopes)];
}

// The sign-in app's id, which every sign-in link carries in the open: the account's own sign-in-app row of its
// service connections names it plainly (the old Worker read the operator's service-plain-values). A run is never
// handed a vault value it could answer, so the id is never read from the vault here.
async function signInClientId(door, list, acquire) {
  const name = acquire.hosted_client?.id_name;
  if (!name) return null;
  for await (const row of door.list({ type: rowTypeOf(list), where: { kind: settings.sign_in_app_kind, client_id_name: name } })) {
    const id = text(row.value?.client_id);
    if (id && row.value?.status !== 'Retired') return id;
  }
  return null;
}

// The new row's starting values: every choice and boolean field of the list, as the start's query gives it. A choice
// may fall back to the value the list starts it at; a boolean must be said, so no row starts able to send by default.
function startingValues(list, query) {
  const values = {};
  const unsaid = [];
  for (const field of list.fields ?? []) {
    const given = query[field.id];
    if (field.kind === 'choice') {
      const value = given ?? field.starts;
      if (!(field.choices ?? []).includes(value)) unsaid.push(`${field.id} (one of ${(field.choices ?? []).join(', ')})`);
      else values[field.id] = value;
    } else if (field.kind === 'boolean') {
      if (given === 'true' || given === true) values[field.id] = true;
      else if (given === 'false' || given === false) values[field.id] = false;
      else unsaid.push(`${field.id} (true or false)`);
    }
  }
  return unsaid.length ? { error: said(words.starting_value, { why: unsaid.join(', ') }) } : { values };
}

async function handleConnectStart(input, { door }) {
  const query = input.query ?? {};
  const service = String(query.service ?? '');
  const descriptor = signInDescriptor(service);
  if (!descriptor) return json({ error: said(words.unknown_service, { service: service || 'That service' }) }, 404);
  const acquire = descriptor.acquire;
  const list = await door.read('list', settings.list);
  const clientId = list ? await signInClientId(door, list, acquire) : null;
  if (!clientId) return json({ error: said(words.not_switched_on, { service: descriptor.name ?? service }) }, 503);
  const starting = startingValues(list, query);
  if (starting.error) return json({ error: starting.error }, 400);
  const waited = query.wait_seconds === undefined ? settings.pending.link_seconds : Number(query.wait_seconds);
  if (!Number.isSafeInteger(waited) || waited < 1) return json({ error: words.bad_wait }, 400);
  const returnTo = query.return_to === undefined ? null : String(query.return_to);
  if (returnTo !== null && !/^\/(?!\/)[^\s\\]*$/.test(returnTo)) return json({ error: words.bad_return }, 400);
  const account = text(query.account);
  // The scopes this connection asks for: the descriptor's own, or the subset the start names (a read-only mailbox asks
  // for fewer than one that drafts). A scope the descriptor does not list is refused, never sent.
  const asked = query.scopes === undefined ? null : String(query.scopes).split(/[\s,]+/).filter(Boolean);
  const unknownScopes = (asked ?? []).filter(scope => !(acquire.scopes ?? []).includes(scope));
  if ((asked && !asked.length) || unknownScopes.length) return json({ error: said(words.bad_scopes, { why: unknownScopes.join(', ') || 'none named' }) }, 400);
  const scopes = asked ?? acquire.scopes ?? [];
  const redirectOrigin = `${settings.public_origin}${settings.route_prefix}`;
  const now = Date.now();
  const expiresAt = new Date(now + (waited + settings.pending.state_seconds) * 1000).toISOString();
  const connectionId = `service_connection:${service}:${random()}`;
  const state = random();
  // PKCE (RFC 7636 S256): the challenge is SHA-256 because the protocol fixes it; it is the service's check, not an
  // identity this service mints. The verifier waits with the state for the callback, then goes to the token request.
  const verifier = acquire.pkce ? base64url(crypto.getRandomValues(new Uint8Array(32))) : null;
  const pending = {
    service, connection_id: connectionId, initial: starting.values, scopes, expires_at: expiresAt,
    ...(account ? { account } : {}), ...(returnTo ? { return_to: returnTo } : {}), ...(verifier ? { code_verifier: verifier } : {}),
  };
  // A pending sign-in whose time has passed is removed with this write, as the Worker KV let its states expire.
  const expired = [];
  for await (const record of door.list({ type: settings.pending.type })) {
    if (!(Date.parse(record.value?.expires_at) > now)) expired.push({ id: record.id, type: settings.pending.type, value: null, expected: { type: settings.pending.type, value: record.value } });
  }
  const id = pendingId(state);
  await door.write([{ id, type: settings.pending.type, value: pending, expected: null }, ...expired], { key: `connect-start:${id}` });
  const address = new URL(acquire.authorize_url);
  const params = {
    client_id: clientId, redirect_uri: `${redirectOrigin}${acquire.redirect.path}`, response_type: 'code', scope: scopes.join(acquire.scope_separator ?? ' '), state,
    ...(verifier ? { code_challenge: base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))), code_challenge_method: 'S256' } : {}),
    ...(acquire.auth_params ?? {}),
    ...(account && acquire.account_hint_param ? { [acquire.account_hint_param]: account } : {}),
  };
  for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
  return json({ authorize_url: address.toString(), service, connection_id: connectionId, expires_at: expiresAt });
}

// Why a nested run did not answer: the engine's own words (it has replaced every held value in them).
const failed = answer => String(answer?.error ?? words.not_checked).slice(0, 300);
// `{connection_id}` in a verify row's input template, as the new connection's id.
const filled = (template, connectionId) => JSON.parse(JSON.stringify(template).replaceAll('{connection_id}', connectionId));

// Trade the code for the tokens (every trade row in order), then check the connection with the service: the account
// it names, the plain values it fills and the scopes the service granted, or the words of why not.
async function tradeAndCheck(door, descriptor, saved, code) {
  const { acquire, verifyRequest = {} } = descriptor;
  const service = settings.services[saved.service];
  const connection = { connection_id: saved.connection_id };
  const redirectOrigin = `${settings.public_origin}${settings.route_prefix}`;
  let grantedScopes = null;
  let traded = null;
  for (const [index, tool] of service.trade.entries()) {
    const input = index === 0
      ? { connection, code, redirect_uri: `${redirectOrigin}${acquire.redirect.path}`, ...(saved.code_verifier ? { code_verifier: saved.code_verifier } : {}) }
      : { connection };
    const answer = await door.run(tool, input, { key: `trade-${index}` });
    if (answer?.error !== undefined || !answer?.result || typeof answer.result !== 'object') return { why: failed(answer) };
    if (index === 0) grantedScopes = scopesReportedBy(acquire.granted_scopes, answer.result);
    traded = answer.result;
  }
  // The last trade's reply names the token where the descriptor says (token_paths), else where it fills its field.
  if (!firstAt(traded, acquire.token_paths ?? [[acquire.fills_field ?? 'access_token']])) return { why: words.no_token };
  const checked = await door.run(service.verify.tool, filled(service.verify.input, saved.connection_id), { key: 'verify' });
  if (checked?.error !== undefined || !checked?.result || typeof checked.result !== 'object') return { why: `${words.not_checked} ${failed(checked)}` };
  const body = checked.result;
  // A sign-in that may reach several accounts (acquire.choose) connects only when it reaches exactly one, whose label
  // and plain values the descriptor's choose names (a secret field of it is kept by the checking row, never read here).
  let chosen = null;
  if (acquire.choose) {
    const reached = (acquire.choose.items_path ?? []).reduce((at, part) => (at === undefined || at === null ? undefined : at[part]), body);
    if (!Array.isArray(reached) || reached.length === 0) return { why: words.no_account };
    if (reached.length > 1) return { why: words.many_accounts };
    chosen = reached[0];
  }
  const secrets = new Set((descriptor.credentialFields ?? []).filter(field => field.secret).map(field => field.id));
  const chosenFills = (acquire.choose?.fills ?? []).filter(fill => !secrets.has(fill.field));
  const label = firstAt(body, (verifyRequest.account_label_from ?? []).filter(item => item.from === 'body').map(item => item.path))
    ?? (chosen && acquire.choose.label_path ? firstAt(chosen, [acquire.choose.label_path]) : null);
  const plain = Object.fromEntries([
    ...chosenFills.map(fill => [fill.field, firstAt(chosen, [fill.path])]),
    ...(verifyRequest.fills ?? []).map(fill => [fill.field, firstAt(body, [fill.path])]),
  ].filter(([, value]) => value));
  if (saved.account && !label) return { why: said(words.unnamed_account, { expected: saved.account }) };
  if (saved.account && label.toLocaleLowerCase('en-US') !== saved.account.toLocaleLowerCase('en-US')) {
    return { why: said(words.other_account, { account: label, expected: saved.account }) };
  }
  return { label, plain, grantedScopes };
}

async function handleConnectCallback(input, { door }) {
  const query = input.query ?? {};
  const state = String(query.state ?? '');
  const id = state ? pendingId(state) : null;
  const saved = id ? await door.readRecord(settings.pending.type, id) : null;
  if (!saved) return page(words.expired, 410);
  // Used once: removed, conditional on what was read, before anything else; a second callback finds nothing.
  await door.write([{ id, type: settings.pending.type, value: null, expected: saved }], { key: `connect-callback:${id}:${random()}` });
  const value = saved.value;
  if (!(Date.parse(value.expires_at) > Date.now())) return page(words.expired, 410);
  const descriptor = signInDescriptor(value.service);
  const name = descriptor?.name ?? value.service;
  if (!descriptor || query.error || !text(query.code)) return page(said(words.not_connected, { service: name }), 400);
  const done = await tradeAndCheck(door, descriptor, value, String(query.code));
  if (done.why) return page(said(words.refused, { service: name, why: done.why }), 400);
  const list = await door.read('list', settings.list);
  const account = done.label ?? value.connection_id;
  const row = {
    name: done.label ? `${name}: ${done.label}` : name,
    kind: settings.account_kind,
    vendor: value.service,
    connection_id: value.connection_id,
    ...(done.label ? { account_label: done.label } : {}),
    ...(Object.keys(done.plain).length ? { plain: done.plain } : {}),
    ...(done.grantedScopes ? { granted_scopes: done.grantedScopes } : {}),
    connected_at: new Date().toISOString(),
    ...value.initial,
  };
  const rowId = `${rowTypeOf(list)}:${value.connection_id.split(':').slice(1).join('-')}`;
  await door.write([{ id: rowId, type: rowTypeOf(list), value: row, expected: null }], { key: `connect-row:${rowId}` });
  return page(value.return_to
    ? said(words.connected_back, { service: name, account, back: `${settings.public_origin}${value.return_to}` })
    : said(words.connected, { service: name, account }), 200);
}

/** The page route { path, method, query } -> { status, body } (or a plain page). */
export async function answerConnectRoute(input = {}, { door } = {}) {
  const method = String(input.method ?? 'GET').toUpperCase();
  const path = String(input.path ?? '').split('?')[0];
  if (method === 'GET' && path === settings.routes.start) return handleConnectStart(input, { door });
  if (method === 'GET' && path === settings.routes.callback) return handleConnectCallback(input, { door });
  return json({ error: words.not_found }, 404);
}
