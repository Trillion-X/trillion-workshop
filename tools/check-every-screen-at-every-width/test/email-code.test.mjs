// test/email-code.test.mjs
// tools/check-every-screen-at-every-width/email-code.mjs signs a test person in with the site's emailed code. These tests use a
// fake mailbox (AgentMail's MCP server, answering list_threads) and a fake site (its send and sign-in answers), and check: the key
// comes from the mounted descriptor only; the newest code to this address is taken and no other; the wait is bounded; the whole
// sign-in sends the key to the mailbox alone; and no refusal carries the code.
import assert from 'node:assert/strict';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { AGENTMAIL, cookieOfSetCookie, emailCodeSession, latestSignInCode, readAgentMailKey, signInWithEmailCode } from '../email-code.mjs';

const EMAIL = 'trillion+ethos-live-check@agentmail.to';
const ORIGIN = 'https://app.ethosschooloftennis.com';
const KEY = 'am_test_key_not_real';

// A response shaped as fetch's: ok, status, text(), headers.get() and getSetCookie().
const answer = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null, getSetCookie: () => headers['set-cookie'] ?? [] },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// A fake mailbox: a queue of thread lists, one per list_threads call (the last one repeats). It checks the key on every call.
function mailbox(listings, { keyOk = () => true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url !== AGENTMAIL.mcp) return answer(404, 'not the mailbox');
    if (init.headers['x-api-key'] !== KEY || !keyOk(init)) return answer(401, 'no');
    const message = JSON.parse(init.body);
    calls.push(message.method);
    if (message.method === 'initialize') return answer(200, { jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'session-1' });
    if (message.method === 'notifications/initialized') return answer(202, '');
    const listing = listings[Math.min(calls.filter(method => method === 'tools/call').length - 1, listings.length - 1)];
    return answer(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ count: listing.length, threads: listing }) }] } });
  };
  return { fetchImpl, calls };
}

// A thread as the server lists it: recipients, timestamp and updatedAt, as the real list shows them.
const threadWith = (code, { to = EMAIL, at = '2026-11-21T12:00:05Z', subject = `Your Ethös School of Tennis sign-in code: ${code}` } = {}) => ({ threadId: `t-${code}`, subject, recipients: [to], timestamp: at, updatedAt: at });

test('the key is read from the mounted descriptor, trimmed; no descriptor or an empty one refuses without the key', async () => {
  const folder = tempFolder(join(tmpdir(), 'live-email-key-'));
  try {
    const file = join(folder, 'key');
    writeFileSync(file, `${KEY}\n`);
    const fd = openSync(file, 'r');
    try { assert.equal(await readAgentMailKey({ fd }), KEY); } finally { closeSync(fd); }
    writeFileSync(file, '\n');
    const empty = openSync(file, 'r');
    try { await assert.rejects(readAgentMailKey({ fd: empty }), error => error.code === 'no_agentmail_key' && !error.message.includes(KEY)); } finally { closeSync(empty); }
    await assert.rejects(readAgentMailKey({ fd: 987654 }), error => error.code === 'no_agentmail_key' && error.message.includes('descriptor 987654'));
  } finally { await import('node:fs/promises').then(fs => fs.rm(folder, { recursive: true, force: true })); }
});

test('the newest code sent to this address is taken; another address\'s code and an older one are not', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const { fetchImpl } = mailbox([[
    threadWith('111111', { to: 'someone-else@agentmail.to', at: '2026-11-21T12:00:20Z' }),
    threadWith('222222', { at: '2026-11-20T09:00:00Z' }),
    threadWith('333333', { at: '2026-11-21T12:00:08Z' }),
    threadWith('444444', { at: '2026-11-21T12:00:12Z' }),
    { threadId: 'other', subject: 'Welcome', recipients: [EMAIL], timestamp: '2026-11-21T12:00:30Z', updatedAt: '2026-11-21T12:00:30Z' },
  ]]);
  const code = await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, wait: async () => {}, now: () => sentAt });
  assert.equal(code, '444444');
});

test('a code that is not there yet is polled for, and taken when it comes', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = sentAt;
  const waits = [];
  const { fetchImpl } = mailbox([[], [], [threadWith('555555', { at: '2026-11-21T12:00:10Z' })]]);
  const code = await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, {
    fetchImpl, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.equal(code, '555555');
  assert.deepEqual(waits, [AGENTMAIL.poll_ms, AGENTMAIL.poll_ms]);
});

test('the wait is bounded: no code in the wait refuses with the time, not the code', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = sentAt;
  const { fetchImpl } = mailbox([[threadWith('666666', { to: 'someone-else@agentmail.to' })]]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, wait: async ms => { clock += ms; } }), error => {
    assert.equal(error.code, 'code_not_found');
    assert.match(error.message, /within 30 seconds/);
    assert.ok(!error.message.includes('666666'));
    return true;
  });
});

test('a whole sign-in sends the key to the mailbox alone, asks the site for a code and exchanges the one it read', async () => {
  const sentAt = Date.now();
  const seen = [];
  const mail = mailbox([[threadWith('777777', { at: new Date(sentAt + 5000).toISOString() })]], { keyOk: init => !init.body.includes(KEY) });
  const site = { 'set-cookie': ['__Secure-session=abc.def; Path=/; HttpOnly; Secure', 'theme=dark; Path=/'] };
  const fetchImpl = async (url, init) => {
    if (url === AGENTMAIL.mcp) return mail.fetchImpl(url, init);
    seen.push({ url, init });
    if (url.endsWith('/api/auth/email-otp/send-verification-otp')) return answer(200, { success: true });
    if (url.endsWith('/api/auth/sign-in/email-otp')) {
      assert.deepEqual(JSON.parse(init.body), { email: EMAIL, otp: '777777' });
      return answer(200, { ok: true }, site);
    }
    return answer(404, '');
  };
  const cookies = await emailCodeSession({ origin: ORIGIN, email: EMAIL }, { fetchImpl, now: () => sentAt, wait: async () => {}, readKey: async () => KEY });
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies[0], { name: '__Secure-session', value: 'abc.def', domain: 'app.ethosschooloftennis.com', path: '/', httpOnly: true, secure: true });
  assert.equal(seen[0].url, `${ORIGIN}/api/auth/email-otp/send-verification-otp`);
  assert.deepEqual(JSON.parse(seen[0].init.body), { email: EMAIL, type: 'sign-in' });
  assert.equal(seen[0].init.headers.origin, ORIGIN);
  assert.equal(seen[1].init.headers.origin, ORIGIN);
  assert.ok(!seen.some(call => JSON.stringify(call).includes(KEY)), 'the key never reaches the site');
});

test('a refused code names its status and never the code; a site that will not send names its status', async () => {
  const sentAt = Date.now();
  const mail = mailbox([[threadWith('888888', { at: new Date(sentAt + 1000).toISOString() })]]);
  const refusing = async (url, init) => {
    if (url === AGENTMAIL.mcp) return mail.fetchImpl(url, init);
    if (url.endsWith('/send-verification-otp')) return answer(200, {});
    return answer(400, { code: 'INVALID_OTP' });
  };
  await assert.rejects(emailCodeSession({ origin: ORIGIN, email: EMAIL }, { fetchImpl: refusing, now: () => sentAt, wait: async () => {}, readKey: async () => KEY }), error => {
    assert.equal(error.code, 'sign_in_refused');
    assert.match(error.message, /status 400/);
    assert.ok(!error.message.includes('888888'));
    return true;
  });
  const notSent = async () => answer(429, 'slow down');
  await assert.rejects(emailCodeSession({ origin: ORIGIN, email: EMAIL }, { fetchImpl: notSent, readKey: async () => KEY }), error => error.code === 'code_not_sent' && /status 429/.test(error.message));
});

test('a Set-Cookie line becomes a cookie for the origin host, with its path and flags', () => {
  assert.deepEqual(cookieOfSetCookie('__Secure-session=abc.def; Path=/; HttpOnly; Secure; SameSite=Lax', 'app.ethosschooloftennis.com'),
    { name: '__Secure-session', value: 'abc.def', domain: 'app.ethosschooloftennis.com', path: '/', httpOnly: true, secure: true });
});

test('signInWithEmailCode posts the code with the page origin and refuses with its status only', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, `${ORIGIN}/api/auth/sign-in/email-otp`);
    assert.equal(init.headers.origin, ORIGIN);
    return answer(200, {}, { 'set-cookie': ['sid=one; Path=/; HttpOnly'] });
  };
  assert.equal((await signInWithEmailCode({ origin: ORIGIN, email: EMAIL, code: '123456' }, { fetchImpl })).length, 1);
  await assert.rejects(signInWithEmailCode({ origin: ORIGIN, email: EMAIL, code: '123456' }, { fetchImpl: async () => answer(401, {}) }), error => error.code === 'sign_in_refused' && !error.message.includes('123456'));
});
