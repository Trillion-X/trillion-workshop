// tools/check-every-screen-at-every-width/email-code.mjs
//
// PURPOSE
//   Signs a test person in to a site that sends a one-time code by email (better-auth's emailOTP, the same on Ethos and on the
//   gateway): asks the site to send the code, reads the newest code for that address from the test inbox (AgentMail, through its
//   MCP server), and exchanges the code for the session cookies. The cookies are returned to the caller of this module and to
//   nothing else: they are never printed, logged, put in an answer or written to a file.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The AgentMail key is read only from the descriptor the row mounts (fd 4, the vault's agentmail-api-key by name, as
//      invoke.credential_mounts names it). It is never in argv, the environment, a file, a log or an answer.
//   2. The code is a secret of the run: it is never in a refusal's words, an answer, a log or a file. A refusal names only
//      its status and the step that failed.
//   3. Only a code sent to this address is accepted: a thread counts when its subject is the site's sign-in code and it is
//      addressed to the email signed in; the newest with a recorded timestamp no earlier than five seconds before the ask
//      marker is the code. This retained allowance does not prove strict after-request freshness: provider timestamp
//      precision and clock alignment are unverified.
//   4. Bounded: the code is waited for up to `wait_ms` (30 s) and polled every `poll_ms` (5 s), then the run refuses.
//
// SHAPE
//   emailCodeSession({ origin, email }, deps) -> [cookie] (the session cookies, as Playwright's addCookies takes them)
//   readAgentMailKey(deps) -> the key text, read from the mounted descriptor
//   latestSignInCode({ apiKey, email, sentAt }, deps) -> the six digits
//   signInWithEmailCode({ origin, email, code }, deps) -> [cookie]
import { createReadStream } from 'node:fs';

export const AGENTMAIL = Object.freeze({
  inbox: 'trillion@agentmail.to',
  mcp: 'https://mcp.agentmail.to/mcp',
  descriptor: 4,
  wait_ms: 30000,
  poll_ms: 5000,
  pages_per_poll: 20,
});

const CODE_SUBJECT = /sign-in code: (\d{6})(?!\d)/;
const KEY_LIMIT = 4096;
const sleep = ms => new Promise(done => setTimeout(done, ms));

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkScanTime(deadline, now, signal) {
  if (now() >= deadline || signal?.aborted) throw refuse('agentmail_scan_incomplete', 'The AgentMail scan ran out of time.');
}

// The key the row mounts on its descriptor: read whole (the mount is written once and closed by the engine), trimmed.
export async function readAgentMailKey({ fd = AGENTMAIL.descriptor } = {}) {
  let text = '';
  try {
    for await (const bytes of createReadStream(null, { fd, autoClose: false })) {
      text += bytes;
      if (text.length > KEY_LIMIT) throw new Error('too long');
    }
  } catch {
    throw refuse('no_agentmail_key', `The AgentMail key is not mounted on descriptor ${fd} (the row names agentmail-api-key).`);
  }
  const key = text.trim();
  if (!key) throw refuse('no_agentmail_key', 'The AgentMail key mounted on the descriptor is empty.');
  return key;
}

// One tools/call on AgentMail's MCP server, under the session the server opened for this run.
async function mcpCall({ apiKey, session, method, params, id, signal }, fetchImpl) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, ...(session ? { 'mcp-session-id': session } : {}) };
  let response, text;
  try {
    response = await fetchImpl(AGENTMAIL.mcp, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal });
    if (response.ok) text = (await response.text()).trim();
  } catch {
    if (signal.aborted) throw refuse('agentmail_scan_incomplete', 'The AgentMail scan ran out of time.');
    throw refuse('agentmail_unavailable', `Could not read AgentMail's reply to ${method}.`);
  }
  if (!response.ok) throw refuse('agentmail_refused', `AgentMail answered ${response.status} to ${method}.`);
  if (id === undefined && !text) return;
  let replies;
  try {
    const data = text.startsWith('{') ? [text] : text.replace(/\r\n?/g, '\n').split('\n\n').flatMap(event => {
      const fields = event.split('\n').filter(line => line === 'data' || line.startsWith('data:'))
        .map(line => line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
      return fields.length ? [fields.join('\n')] : [];
    });
    replies = data.map(part => JSON.parse(part));
  } catch { throw refuse('agentmail_bad_reply', `AgentMail returned unreadable JSON to ${method}.`); }
  const matching = id === undefined ? replies : replies.filter(reply => reply?.id === id);
  if (id !== undefined && matching.length !== 1) throw refuse('agentmail_bad_reply', `AgentMail returned no unique matching reply to ${method}.`);
  const body = matching.at(-1);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse('agentmail_bad_reply', `AgentMail returned no matching reply to ${method}.`);
  if (body.error) throw refuse('agentmail_refused', `AgentMail refused ${method}.`);
  if (id !== undefined && (!body.result || typeof body.result !== 'object')) throw refuse('agentmail_bad_reply', `AgentMail returned no result to ${method}.`);
  return { session: response.headers.get('mcp-session-id') ?? session, result: body.result };
}

// The inbox an address reaches: the address without its +tag (trillion-proofs+gateway-live-check@agentmail.to is delivered to
// trillion-proofs@agentmail.to).
export const inboxOf = email => String(email).replace(/\+[^@]*@/, '@').toLowerCase();

// A poll walks the server's newest-first pages in one session. Only an absent continuation ends a completed scan.
async function* threadPages({ apiKey, inbox, deadline, now }, fetchImpl) {
  checkScanTime(deadline, now);
  const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
  const opened = await mcpCall({ apiKey, method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-screens', version: '1' } }, signal }, fetchImpl);
  let { session } = opened;
  checkScanTime(deadline, now, signal);
  await mcpCall({ apiKey, session, method: 'notifications/initialized', signal }, fetchImpl);
  const seen = new Set();
  let pageToken;
  for (let page = 0; page < AGENTMAIL.pages_per_poll; page++) {
    checkScanTime(deadline, now, signal);
    const args = pageToken === undefined ? { inboxId: inbox } : { inboxId: inbox, pageToken };
    const answer = await mcpCall({ apiKey, session, method: 'tools/call', id: page + 2, params: { name: 'list_threads', arguments: args }, signal }, fetchImpl);
    session = answer.session;
    const { result } = answer;
    if (result.isError) throw refuse('agentmail_refused', 'AgentMail refused the thread list.');
    let listed;
    try {
      listed = result.structuredContent ?? JSON.parse(result.content?.find(part => part.type === 'text')?.text);
    } catch { throw refuse('agentmail_bad_reply', 'AgentMail returned an unreadable thread list.'); }
    if (!Array.isArray(listed?.threads)) throw refuse('agentmail_bad_reply', 'AgentMail returned no thread list.');
    checkScanTime(deadline, now, signal);
    yield listed.threads;
    pageToken = listed.nextPageToken;
    if (pageToken == null) return;
    if (typeof pageToken !== 'string' || !pageToken || seen.has(pageToken)) throw refuse('agentmail_bad_reply', 'AgentMail returned an invalid thread continuation.');
    seen.add(pageToken);
  }
  throw refuse('agentmail_scan_incomplete', 'The AgentMail scan ended before its last page.');
}

// The sign-in code of this address in the newest qualifying thread on this page, or null.
function codeIn(threads, email, sentAt) {
  const wanted = email.toLowerCase();
  let newest = -Infinity;
  let code = null;
  for (const thread of threads) {
    if (!Array.isArray(thread?.recipients) || !thread.recipients.some(address => typeof address === 'string' && address.toLowerCase() === wanted)) continue;
    const sent = Date.parse(thread.timestamp ?? thread.updatedAt ?? thread.createdAt ?? '');
    if (!Number.isFinite(sent) || sent < sentAt - 5000 || sent <= newest) continue;
    const match = typeof thread.subject === 'string' && thread.subject.match(CODE_SUBJECT);
    if (match) { newest = sent; code = match[1]; }
  }
  return code;
}

// The newest code the site sent to this address, polled until it arrives or the wait is spent. The code is returned, never logged.
export async function latestSignInCode({ apiKey, email, sentAt }, { fetchImpl = fetch, wait = sleep, now = Date.now, waitMs = AGENTMAIL.wait_ms, pollMs = AGENTMAIL.poll_ms } = {}) {
  const deadline = now() + waitMs;
  do {
    for await (const threads of threadPages({ apiKey, inbox: inboxOf(email), deadline, now }, fetchImpl)) {
      const code = codeIn(threads, email, sentAt);
      checkScanTime(deadline, now);
      if (code) return code;
    }
    const left = deadline - now();
    if (left <= 0) break;
    await wait(Math.min(pollMs, left));
  } while (now() < deadline);
  throw refuse('code_not_found', `No matching sign-in code was found within ${Math.round(waitMs / 1000)} seconds.`);
}

// The session cookies of a one-time code: the code is posted with the page's own origin, and each Set-Cookie it answers is kept.
// A refused code names only its status.
export async function signInWithEmailCode({ origin, email, code }, { fetchImpl = fetch, at = Date.now() } = {}) {
  const response = await fetchImpl(`${origin}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, otp: code }),
    redirect: 'manual',
  });
  const hostname = new URL(origin).hostname;
  const cookies = response.headers.getSetCookie().map(line => cookieOfSetCookie(line, hostname, at));
  if (!response.ok || cookies.length === 0) throw refuse('sign_in_refused', `The sign-in code was refused (status ${response.status}).`);
  return cookies;
}

// One Set-Cookie line as Playwright's addCookies takes it; expires is in seconds (Max-Age wins over Expires, as in a browser).
export function cookieOfSetCookie(line, hostname, now = Date.now()) {
  const [pair, ...attributes] = line.split(';').map(part => part.trim());
  const at = pair.indexOf('=');
  const cookie = { name: pair.slice(0, at), value: pair.slice(at + 1), domain: hostname, path: '/' };
  for (const attribute of attributes) {
    const [key, value] = attribute.split('=');
    const word = key.toLowerCase();
    if (word === 'httponly') cookie.httpOnly = true;
    if (word === 'secure') cookie.secure = true;
    if (word === 'path' && value) cookie.path = value;
    if (word === 'max-age' && Number.isFinite(Number(value))) cookie.expires = Math.floor(now / 1000) + Number(value);
    if (word === 'expires' && cookie.expires === undefined && Number.isFinite(Date.parse(attribute.slice(attribute.indexOf('=') + 1)))) {
      cookie.expires = Math.floor(Date.parse(attribute.slice(attribute.indexOf('=') + 1)) / 1000);
    }
  }
  return cookie;
}

// The whole sign-in: ask the site for a code to this address, read it from the inbox, exchange it for the session.
export async function emailCodeSession({ origin, email }, deps = {}) {
  const { fetchImpl = fetch, now = Date.now, readKey = readAgentMailKey } = deps;
  const sentAt = now();
  const sent = await fetchImpl(`${origin}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, type: 'sign-in' }),
  });
  if (!sent.ok) throw refuse('code_not_sent', `The site did not send the sign-in code (status ${sent.status}).`);
  const apiKey = await readKey();
  const code = await latestSignInCode({ apiKey, email, sentAt }, deps);
  return signInWithEmailCode({ origin, email, code }, deps);
}
