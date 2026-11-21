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
//      addressed to the email signed in; the newest of those, sent after this run asked for one, is the code.
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
});

const CODE_SUBJECT = /sign-in code: (\d{6})/;
const KEY_LIMIT = 4096;
const sleep = ms => new Promise(done => setTimeout(done, ms));

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
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
async function mcpCall({ apiKey, session, method, params, id }, fetchImpl) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-api-key': apiKey, ...(session ? { 'mcp-session-id': session } : {}) };
  const response = await fetchImpl(AGENTMAIL.mcp, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw refuse('agentmail_refused', `AgentMail answered ${response.status} to ${method}.`);
  const text = await response.text();
  const data = text.startsWith('{') ? text : text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5)).pop();
  return { session: response.headers.get('mcp-session-id') ?? session, body: JSON.parse(data ?? '{}') };
}

// The threads of the test inbox: the server's list, which comes back as the JSON text of its one text part (threads: { threadId,
// subject, recipients, timestamp, updatedAt, ... }).
// The inbox an address reaches: the address without its +tag (trillion-proofs+gateway-live-check@agentmail.to is delivered to
// trillion-proofs@agentmail.to).
export const inboxOf = email => String(email).replace(/\+[^@]*@/, '@').toLowerCase();

async function listThreads({ apiKey, inbox = AGENTMAIL.inbox }, fetchImpl) {
  const opened = await mcpCall({ apiKey, session: null, method: 'initialize', id: 1, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-screens', version: '1' } } }, fetchImpl);
  await mcpCall({ apiKey, session: opened.session, method: 'notifications/initialized', id: 2, params: {} }, fetchImpl).catch(() => {});
  const { body } = await mcpCall({ apiKey, session: opened.session, method: 'tools/call', id: 3, params: { name: 'list_threads', arguments: { inboxId: inbox } } }, fetchImpl);
  const result = body.result ?? {};
  if (result.isError) throw refuse('agentmail_refused', 'AgentMail refused the thread list.');
  const listed = result.structuredContent ?? JSON.parse(result.content?.find(part => part.type === 'text')?.text ?? '{}');
  return Array.isArray(listed.threads) ? listed.threads : [];
}

// The sign-in code of this address in the newest thread sent after the run asked for one, or null.
function codeIn(threads, email, sentAt) {
  const wanted = email.toLowerCase();
  const mine = threads.filter(thread => {
    const addressed = (thread.recipients ?? []).some(address => String(address).toLowerCase() === wanted);
    const sent = Date.parse(thread.timestamp ?? thread.updatedAt ?? thread.createdAt ?? '');
    return addressed && CODE_SUBJECT.test(thread.subject ?? '') && (!Number.isFinite(sent) || sent >= sentAt - 5000);
  });
  mine.sort((a, b) => Date.parse(b.timestamp ?? b.updatedAt ?? 0) - Date.parse(a.timestamp ?? a.updatedAt ?? 0));
  return mine[0] ? mine[0].subject.match(CODE_SUBJECT)[1] : null;
}

// The newest code the site sent to this address, polled until it arrives or the wait is spent. The code is returned, never logged.
export async function latestSignInCode({ apiKey, email, sentAt }, { fetchImpl = fetch, wait = sleep, now = Date.now, waitMs = AGENTMAIL.wait_ms, pollMs = AGENTMAIL.poll_ms } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const code = codeIn(await listThreads({ apiKey, inbox: inboxOf(email) }, fetchImpl), email, sentAt);
    if (code) return code;
    if (now() >= deadline) throw refuse('code_not_found', `No sign-in code reached ${email} within ${Math.round(waitMs / 1000)} seconds.`);
    await wait(pollMs);
  }
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
  const sent = await fetchImpl(`${origin}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, type: 'sign-in' }),
  });
  if (!sent.ok) throw refuse('code_not_sent', `The site did not send the sign-in code (status ${sent.status}).`);
  const sentAt = now();
  const apiKey = await readKey();
  const code = await latestSignInCode({ apiKey, email, sentAt }, deps);
  return signInWithEmailCode({ origin, email, code }, deps);
}
