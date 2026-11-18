// extension/src/trillion.mjs
//
// PURPOSE
//   Everything the browser extension says to the person's Trillion account: signing in the way any AI app does
//   (OAuth with PKCE, registered by itself at the registration address the server's discovery document names), calling the account's tools on /mcp, and keeping a
//   picture or recording of the page in the person's files through the addressed Namespace resource.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The only way in is the account's own sign-in. The extension never holds a personal key or a session cookie.
//   2. The sign-in comes back to this extension's own page (signed-in.html); the code is exchanged there with the
//      verifier this extension made, so no other page can finish it.
//   3. A token that stops working is refreshed once; if that fails the person is signed out and told to sign in.
//   4. Nothing is reported as sent unless the account answered with the handoff it keeps.
//
// SECURITY
//   Tokens live in chrome.storage.local, readable only by this extension. PKCE S256 is what the OAuth protocol
//   requires of a public client, computed with the browser's own crypto.

import { needsPlanTitle } from 'trillion-workshop/tools/workspace-screens/web/src/plan-needs.mjs';
import { planCards } from 'trillion-workshop/tools/workspace-screens/web/src/plan-cards.mjs';
import { cancelFileUpload, uploadFile } from './file-upload.mjs';
import settings from '../settings.json' with { type: 'json' };
import words from '../words.json' with { type: 'json' };
import { retryableStatus, Unreachable } from './outbox.mjs';
import { sanitizeErrorText } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';

/** A refusal as an error a person may read: the service's words through the one failure-words gate (words written for
 *  an AI, an id or a status code become words.refused), the service's own words kept as `said` for their AI. */
const refusal = said => Object.assign(new Error(sanitizeErrorText(typeof said === 'string' ? said : '', words.refused)), { said: typeof said === 'string' ? said : '' });

export const ORIGIN = settings.origin;
const REDIRECT = () => chrome.runtime.getURL('signed-in.html');

function decodeMcpResponse(raw, contentType) {
  const type = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  let text = raw;
  if (type === 'text/event-stream') {
    text = String(raw).split(/\r?\n/).filter(line => line.startsWith('data:')).at(-1)?.slice(5).trim();
    if (!text) throw refusal('The account returned an empty MCP event stream.');
  } else if (type !== 'application/json' && !type.endsWith('+json')) {
    throw refusal('The account returned an invalid MCP response type.');
  }
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.id !== 1) {
    throw refusal('The account returned an invalid MCP response id.');
  }
  return message;
}

const local = {
  get: async key => (await chrome.storage.local.get(key))[key] ?? null,
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  drop: key => chrome.storage.local.remove(key),
};

// Web Locks serialize token read/modify/write transactions across the popup, callback page and worker.
const withTokenLock = operation => navigator.locks.request('trillion-extension-tokens', operation);
const sameSignIn = (left, right) => Boolean(left && right && (left.session_id && right.session_id
  ? left.session_id === right.session_id
  : left.access_token === right.access_token && left.refresh_token === right.refresh_token));
const sameTokenSnapshot = (left, right) => Boolean(left && right && left.access_token === right.access_token
  && left.refresh_token === right.refresh_token && (left.session_id ?? null) === (right.session_id ?? null));
const requestTokens = new WeakMap();

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = (length = 32) => base64url(crypto.getRandomValues(new Uint8Array(length)));

// The sign-in server's own addresses (RFC 8414: /.well-known/oauth-authorization-server), read once per worker run, never typed paths.
let discovered = null;
async function serverAddresses() {
  if (discovered) return discovered;
  const document = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json().catch(() => ({}));
  for (const name of ['registration_endpoint', 'authorization_endpoint', 'token_endpoint']) if (typeof document[name] !== 'string') throw refusal(`The sign-in server does not name its ${name}.`);
  discovered = document;
  return discovered;
}

// This extension's own sign-in app on the account service, registered once per install (its redirect names this
// install's id, so it is registered here rather than published as a fixed client).
async function clientId() {
  const saved = await local.get('client');
  if (saved?.redirect === REDIRECT()) return saved.client_id;
  const response = await fetch((await serverAddresses()).registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: settings.client_name, redirect_uris: [REDIRECT()], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.client_id) throw refusal(body.error_description ?? body.error);
  await local.set('client', { client_id: body.client_id, redirect: REDIRECT() });
  return body.client_id;
}

/** Opens Trillion's sign-in in a tab; signed-in.html finishes it. */
export async function startSignIn() {
  const client_id = await clientId();
  const verifier = randomText(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = randomText(16);
  await withTokenLock(() => local.set('signing_in', { verifier, state, client_id }));
  const url = new URL((await serverAddresses()).authorization_endpoint);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id, redirect_uri: REDIRECT(), code_challenge: challenge, code_challenge_method: 'S256', state, scope: settings.scope, resource: `${ORIGIN}/mcp` })) url.searchParams.set(key, value);
  await chrome.tabs.create({ url: url.href });
}

async function tokenRequest(fields, expectedTokens = null, expectedState = null) {
  const response = await fetch((await serverAddresses()).token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) throw refusal(body.error_description ?? body.error);
  return withTokenLock(async () => {
    const current = await local.get('tokens');
    if (expectedTokens && !sameTokenSnapshot(current, expectedTokens)) return null;
    if (expectedState && (await local.get('signing_in'))?.state !== expectedState) return null;
    // Carry identity only from the sign-in that initiated this refresh; never borrow it from a replacement.
    const account = fields.grant_type === 'refresh_token' ? expectedTokens?.account ?? null : null;
    const next = { access_token: body.access_token, refresh_token: body.refresh_token ?? expectedTokens?.refresh_token ?? null,
      expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      session_id: expectedTokens?.session_id ?? crypto.randomUUID(), ...(account ? { account, ...(expectedTokens?.account_source ? { account_source: expectedTokens.account_source } : {}) } : {}) };
    await local.set('tokens', next);
    return next;
  });
}

/** Called by signed-in.html with the address Trillion sent the person back to. */
export async function finishSignIn(address) {
  const params = new URL(address).searchParams;
  const pending = await local.get('signing_in');
  if (params.get('error')) throw refusal(params.get('error_description') ?? params.get('error'));
  if (!pending || params.get('state') !== pending.state || !params.get('code')) throw new Error('This sign-in was not started here. Open Send to Trillion and sign in again.');
  const next = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: REDIRECT(), client_id: pending.client_id, code_verifier: pending.verifier }, null, pending.state);
  if (!next) throw new SignInNeeded();
  await withTokenLock(async () => {
    if ((await local.get('signing_in'))?.state === pending.state) await local.drop('signing_in');
  });
}

export const signedIn = async () => Boolean(await local.get('tokens'));
/** Signs out. `end` also ends this sign-in on the account first (a person signing out), best effort and briefly, so the
 *  sign-in cannot be used again from anywhere; a sign-in the account already refused is only forgotten here. */
export async function signOut({ end = false, expectedTokens = null } = {}) {
  const tokens = await withTokenLock(async () => {
    // An explicit sign-out also cancels any callback whose token exchange is still in flight.
    if (!expectedTokens) await local.drop('signing_in');
    return local.get('tokens');
  });
  if (expectedTokens && !sameTokenSnapshot(tokens, expectedTokens)) return;
  if (end && tokens?.account && tokens.account_source === 'mcp-initialize') {
    const device = await local.get('browser-notification-device');
    if (device?.account === tokens.account && device.device_id) {
      const removal = runWorkshopTool('tool:remove-my-notification-device', { device_id: device.device_id }, {
        requestKey: crypto.randomUUID(), expectedAccount: tokens.account, waitSeconds: 0,
      }).catch(() => null);
      await Promise.race([removal, new Promise(resolve => setTimeout(resolve, 3000))]);
      await Promise.all([local.drop('browser-notification-device'), local.drop('browser-notification-state')]);
    }
  }
  if (end && tokens?.access_token) {
    await fetch(`${ORIGIN}/mcp/api/sign-in/end`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
  }
  await withTokenLock(async () => {
    const current = await local.get('tokens');
    if (expectedTokens ? sameTokenSnapshot(current, expectedTokens) : sameSignIn(current, tokens)) await local.drop('tokens');
  });
}

/** The current account identity from the authenticated MCP admission metadata, or null when it cannot be confirmed. */
export async function signedInAccount() {
  const tokens = await local.get('tokens');
  if (!tokens) return null;
  if (tokens.account && tokens.account_source === 'mcp-initialize') return tokens.account;
  const id = await signedFetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: settings.client_name, version: chrome.runtime.getManifest?.().version ?? '1' },
    } }),
  }, null, tokens).then(async response => {
    let answer;
    try { answer = decodeMcpResponse(await response.text(), response.headers.get('content-type')); }
    catch { return null; }
    const used = requestTokens.get(response);
    const account = answer?.result?._meta?.['ai.gettrillion/account']?.account_id;
    return response.ok && used && typeof account === 'string' && account ? { id: account, used } : null;
  }, () => null);
  if (!id) return null;
  return withTokenLock(async () => {
    const now = await local.get('tokens');
    if (!sameSignIn(now, id.used)) return null;
    await local.set('tokens', { ...now, account: id.id, account_source: 'mcp-initialize' });
    return id.id;
  });
}

/** The account and sign-in session that may own a multi-request operation. */
export async function signedInContext() {
  const before = await local.get('tokens');
  const account = await signedInAccount();
  if (!before || !account) return null;
  return withTokenLock(async () => {
    let current = await local.get('tokens');
    if (!sameSignIn(before, current) || current?.account !== account) throw new SignInNeeded();
    if (typeof current.session_id !== 'string' || !current.session_id) {
      current = { ...current, session_id: crypto.randomUUID() };
      await local.set('tokens', current);
    }
    return { account, session_id: current.session_id };
  });
}

async function accessToken({ refresh = false, expectedTokens = null } = {}) {
  const tokens = await local.get('tokens');
  if (expectedTokens && !sameSignIn(tokens, expectedTokens)) return null;
  if (!tokens) return null;
  if (!refresh && tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  if (!tokens.refresh_token) { await signOut({ expectedTokens: tokens }); return null; }
  try {
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: (await local.get('client')).client_id }, tokens);
    if (!refreshed) return null;
    return refreshed.access_token;
  } catch {
    await signOut({ expectedTokens: tokens });
    return null;
  }
}

export class SignInNeeded extends Error {
  constructor() { super('Sign in to Trillion to send.'); this.name = 'SignInNeeded'; }
}

/**
 * The account's plan does not include what was asked; `feature` is the plan row it is ({ id, label }) or null. Its
 * message is one short line pointing at the plan cards (words.json plan.refused), never the service's paragraph
 * written for an AI, so every place that shows a refusal (a Sending row, Save this chat, Send) says the same thing.
 */
export class PlanNeeded extends Error {
  constructor(feature = null) { super(words.plan.refused.replace('{needs}', needsPlanTitle(feature?.id ?? null))); this.name = 'PlanNeeded'; this.feature = feature; }
}

// Every open view hears a plan refusal through session storage (`plan_needed`), whichever part of the extension asked;
// the offscreen recording page has no storage and hands its refusal to the background worker instead.
async function planNeeded(feature = null) {
  await chrome.storage?.session?.set({ plan_needed: { feature, at: Date.now() } });
  return new PlanNeeded(feature);
}

// A signed-in request to the account; a token the service refuses is refreshed once and the request sent again.
async function signedFetch(url, init = {}, expectedAccount = null, initiatingTokens = null, requestHooks = null) {
  let authorized = initiatingTokens ?? await local.get('tokens');
  if (!authorized) throw new SignInNeeded();
  for (const refresh of [false, true]) {
    if (!sameSignIn(await local.get('tokens'), authorized)) throw new SignInNeeded();
    const token = await accessToken({ refresh, expectedTokens: authorized });
    if (!token) throw new SignInNeeded();
    // The captured bearer token belongs to one sign-in even if storage changes immediately afterward.
    // Check the account after refresh and before sending so an in-flight page run cannot follow a new sign-in.
    if (expectedAccount) {
      const current = await local.get('tokens');
      if (current?.account !== expectedAccount || current?.access_token !== token) throw new Error('The signed-in account changed.');
    }
    authorized = await local.get('tokens');
    if (!authorized || authorized.access_token !== token) throw new SignInNeeded();
    requestHooks?.onRequest?.();
    const response = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    requestHooks?.onResponse?.(response);
    requestTokens.set(response, authorized);
    if (response.status !== 401) return response;
    const afterRefusal = await local.get('tokens');
    if (!sameSignIn(afterRefusal, authorized)) throw new SignInNeeded();
    authorized = afterRefusal;
  }
  await signOut({ expectedTokens: authorized });
  throw new SignInNeeded();
}

function isTransportFailure(error) {
  if (!(error instanceof TypeError) && error?.name !== 'AbortError' && error?.name !== 'TimeoutError') return false;
  const code = error?.cause?.code;
  if (['ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_MISSING_ARGS', 'ERR_INVALID_PROTOCOL', 'ERR_INVALID_HEADER_VALUE', 'ERR_HTTP_INVALID_HEADER_VALUE'].includes(code)) return false;
  return !/failed to parse url|invalid url|invalid argument|invalid header/i.test(String(error?.message ?? ''));
}

async function verifyRunSession(tokens, expectedAccount, response = null) {
  const current = await local.get('tokens');
  const used = response ? requestTokens.get(response) : tokens;
  if (response ? !used || !sameSignIn(current, used) : !sameSignIn(current, tokens)) throw new SignInNeeded();
  if (expectedAccount && current?.account !== expectedAccount) throw new Error('The signed-in account changed.');
}

/** Runs one tool on the account and returns what it answered; a refusal is thrown in words a person may read (`refusal`). */
export async function tool(name, args = {}, expectedAccount = null, { replayTransportOnce = false, expectedSessionId = null } = {}) {
  const replay = replayTransportOnce === true;
  const fenceSession = replay || expectedSessionId || name === 'do_one_thing_in_my_account';
  const initiatingTokens = fenceSession ? await local.get('tokens') : null;
  if (expectedSessionId && initiatingTokens?.session_id !== expectedSessionId) throw new SignInNeeded();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let response;
  let raw;
  for (let attempt = 0; ; attempt += 1) {
    const requestState = { started: false, sawUnauthorized: false };
    try {
      response = await signedFetch(`${ORIGIN}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body,
      }, expectedAccount, initiatingTokens, {
        onRequest: () => { requestState.started = true; },
        onResponse: answer => { if (answer.status === 401) requestState.sawUnauthorized = true; },
      });
    } catch (error) {
      if (initiatingTokens) await verifyRunSession(initiatingTokens, expectedAccount);
      if (replay && requestState.started && !requestState.sawUnauthorized && attempt === 0 && isTransportFailure(error)) {
        continue;
      }
      // The network is down or the account did not answer: a send can be kept and sent again (src/outbox.mjs).
      if (error instanceof TypeError) throw new Unreachable(words.unreachable);
      throw error;
    }
    if (initiatingTokens) await verifyRunSession(initiatingTokens, expectedAccount, response);
    if (retryableStatus(response.status)) throw new Unreachable(words.unreachable);
    try { raw = (await response.text()).trim(); }
    catch (error) {
      if (initiatingTokens) await verifyRunSession(initiatingTokens, expectedAccount, response);
      if (replay && !requestState.sawUnauthorized && attempt === 0 && isTransportFailure(error)) {
        continue;
      }
      throw error;
    }
    if (initiatingTokens) await verifyRunSession(initiatingTokens, expectedAccount, response);
    break;
  }
  const message = decodeMcpResponse(raw, response.headers.get('content-type'));
  if (message?.error) throw refusal(message.error.message);
  const result = message?.result;
  const said = result?.content?.find(part => part.type === 'text')?.text;
  if (result?.isError && result._meta?.upgrade_needed) throw await planNeeded(result._meta.feature ?? null);
  if (result?.isError) throw refusal(said);
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(said); } catch { return said ?? null; }
}

/** Runs one addressed native resource operation, replaying only the exact keyed call in its initiating sign-in. */
export function runResourceOperation(address, method, input, { requestKey, expectedAccount = null, expectedSessionId = null, replayTransportOnce = false } = {}) {
  if (typeof address !== 'string' || !address || typeof method !== 'string' || !method
      || !input || typeof input !== 'object' || Array.isArray(input)
      || typeof requestKey !== 'string' || !requestKey) {
    throw new TypeError('A resource address, operation, object input and request key are required.');
  }
  return tool('do_one_thing_in_my_account', {
    address, method, request_key: requestKey, input,
  }, expectedAccount, { replayTransportOnce: replayTransportOnce === true, expectedSessionId }).then(answer => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.error || answer.isError) {
      throw refusal(typeof answer?.error === 'string' ? answer.error : 'Trillion did not return a complete resource operation.');
    }
    return answer;
  });
}

/** Runs a Marketplace tool through the addressed native Workshop operation. */
export function runWorkshopTool(toolId, input, { requestKey, expectedAccount = null } = {}) {
  if (typeof toolId !== 'string' || !toolId || !input || typeof input !== 'object' || Array.isArray(input)
      || typeof requestKey !== 'string' || !requestKey) {
    throw new TypeError('A Marketplace tool, object input and request key are required.');
  }
  return tool('do_one_thing_in_my_account', {
    address: '@tools', method: 'tools:run', request_key: requestKey, input: { tool: toolId, input },
  }, expectedAccount, { replayTransportOnce: true }).then(answer => {
    const failure = typeof answer?.error === 'string' ? answer.error
      : typeof answer?.result?.said === 'string' && answer.exit_code !== 0 ? answer.result.said
        : typeof answer?.result?.error === 'string' ? answer.result.error : null;
    if (failure || answer?.isError) throw refusal(failure ?? words.refused);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)
        || answer.exit_code !== 0 || typeof answer.replayed !== 'boolean' || answer.tool !== toolId
        || !answer.result || typeof answer.result !== 'object' || Array.isArray(answer.result)) {
      throw refusal('Trillion did not return a complete Marketplace tool run.');
    }
    return answer.result;
  });
}

/**
 * One of the account's own routes (`/mcp/api<path>`, the device contract's /tell/... routes): read with no body,
 * sent as JSON with one. Answers the route's JSON; a refusal is thrown in words a person may read (`refusal`).
 */
export async function account(path, body, expectedAccount = null) {
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||/[\\\s#]/.test(path))throw new TypeError('Choose an ordinary account route.');
  const response = await signedFetch(`${ORIGIN}/mcp/api${path}`, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, expectedAccount);
  const answer = await response.json().catch(() => ({}));
  // A decoded old reply cannot follow sign-out, an account switch, or a new
  // sign-in to the same account. Refresh within its original session may continue.
  const current=await local.get('tokens'),used=requestTokens.get(response);
  if(!sameSignIn(current,used)||expectedAccount&&current.account!==expectedAccount)throw new SignInNeeded();
  if (!response.ok) throw refusal(answer.error);
  return answer;
}

/** The Authorization header value for this person's account; used wherever the extension talks to the account. */
export async function bearer(expectedAccount = null, expectedSessionId = null) {
  const token = await accessToken();
  if (!token) throw new SignInNeeded();
  if (expectedAccount) {
    const current = await local.get('tokens');
    if (current?.account !== expectedAccount || current?.access_token !== token) throw new SignInNeeded();
  }
  if (expectedSessionId && (await local.get('tokens'))?.session_id !== expectedSessionId) throw new SignInNeeded();
  return `Bearer ${token}`;
}

/** Where a file sent from the browser is kept: the sent-files folder, when it was made, and what it shows. */
export const sentFileName = (title, extension, at = new Date()) =>
  `${settings.sent_files_folder}/${at.toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')} ${String(title ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'page'}.${extension}`;

/** A keeper of files in the person's Namespace through bounded, account-fenced resource operations. */
export function fileKeeper({ operation = null, context = null } = {}) {
  const run = operation ?? ((method, input, { requestKey, context: owner }) => runResourceOperation('@namespace', method, input, {
    requestKey, expectedAccount: owner?.account ?? null, expectedSessionId: owner?.session_id ?? null, replayTransportOnce: true,
  }));
  const ownerFor = async candidate => {
    const owner = candidate ?? context ?? await signedInContext();
    if (!owner?.account || !owner?.session_id) throw new SignInNeeded();
    return owner;
  };
  const keep = async upload => uploadFile({ ...upload, context: await ownerFor(upload.context), operation: run });
  keep.cancel = async upload => cancelFileUpload({ ...upload, context: await ownerFor(upload.context), operation: run });
  return keep;
}

/** Keeps bytes (or a Blob) as a file named `name` in the person's files; returns its content identity. */
/** Keeps a file only while the popup is still acting for the account that initiated the send. */
export async function keepFile(file) {
  const context = await signedInContext();
  if (!context || (file.expectedAccount && context.account !== file.expectedAccount)) throw new SignInNeeded();
  const { expectedAccount: _expectedAccount, ...upload } = file;
  return fileKeeper({ context })(upload);
}

/** The plans a person compares (src/plan-cards.mjs over the service's own offers), free first. */
export async function readPlans() {
  const response = await fetch(`${ORIGIN}/billing/offers`, { credentials: 'omit', headers: { accept: 'application/json' } });
  if (!response.ok) throw refusal('');
  return planCards((await response.json()).offers);
}

/** Where the paid card sends the person: the offer's Buy on Trillion, saying it came from here and the page to return to. */
export const buyAddress = (offerId, page = null) =>
  `${ORIGIN}/buy/${encodeURIComponent(offerId)}?from=${encodeURIComponent(settings.bought_from)}${page ? `&return=${encodeURIComponent(page)}` : ''}`;

/**
 * Whether this browser is signed in on Trillion itself (its own sign-in, not this extension's): Buy pays for the
 * account signed in there, and for a new account when nobody is.
 */
export async function signedInOnTrillion() {
  const response = await fetch(`${ORIGIN}/work/api/viewer`, { credentials: 'include', redirect: 'manual', headers: { accept: 'application/json' } }).catch(() => null);
  return Boolean(response?.ok && (response.headers.get('content-type') ?? '').includes('json'));
}
