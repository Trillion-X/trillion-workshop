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
import { AGENTMAIL, cookieOfSetCookie, emailCodeSession, inboxOf, latestSignInCode, readAgentMailKey, signInWithEmailCode } from '../email-code.mjs';

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

// A fake mailbox: a queue of thread lists or replies, one per list_threads call (the last one repeats).
function mailbox(listings, { keyOk = () => true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url !== AGENTMAIL.mcp) return answer(404, 'not the mailbox');
    if (init.headers['x-api-key'] !== KEY || !keyOk(init)) return answer(401, 'no');
    const message = JSON.parse(init.body);
    if (message.method === 'initialize') return answer(200, { jsonrpc: '2.0', id: 1, result: {} }, { 'mcp-session-id': 'session-1' });
    assert.equal(init.headers['mcp-session-id'], 'session-1');
    if (message.method === 'notifications/initialized') return answer(202, '');
    calls.push(message.params.arguments);
    const listing = listings[Math.min(calls.length - 1, listings.length - 1)];
    if (typeof listing === 'function') return listing(message);
    const payload = Array.isArray(listing) ? { threads: listing } : listing;
    return answer(200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
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

test('the retained five-second timestamp allowance accepts pre-request codes and does not prove strict freshness', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  for (const offset of [-5001, -5000, -4000, -1, 0, 1]) {
    let clock = sentAt;
    const { fetchImpl } = mailbox([[threadWith('123456', { at: new Date(sentAt + offset).toISOString() })]]);
    const pending = latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, {
      fetchImpl, now: () => clock, waitMs: 10000, pollMs: 10000, wait: async ms => { clock += ms; },
    });
    if (offset < -5000) await assert.rejects(pending, { code: 'code_not_found' });
    else assert.equal(await pending, '123456');
  }
});

test('a subject must contain exactly six consecutive code digits, not a prefix of a longer run', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  for (const digits of ['12345', '1234567', '01234567', '123456789', '123456', '123456.']) {
    let clock = sentAt;
    const { fetchImpl } = mailbox([[threadWith(digits, { subject: `Fixture sign-in code: ${digits}` })]]);
    const pending = latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, {
      fetchImpl, now: () => clock, waitMs: 10000, pollMs: 10000, wait: async ms => { clock += ms; },
    });
    if (digits === '123456' || digits === '123456.') assert.equal(await pending, '123456');
    else await assert.rejects(pending, { code: 'code_not_found' });
  }
});

test('MCP replies must match the request id, including its type, without exposing unrelated replies', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const receipt = 'private-reply-123456';
  for (const method of ['initialize', 'tools/call']) {
    for (const responseId of [() => undefined, () => null, message => message.id + 1, message => message.id + 100, message => String(message.id)]) {
      let clock = sentAt;
      const mail = mailbox([[threadWith('123456')]]);
      const fetchImpl = async (url, init) => {
        const message = JSON.parse(init.body);
        if (message.method !== method) return mail.fetchImpl(url, init);
        assert.equal(message.id, method === 'initialize' ? 1 : 2);
        return answer(200, { jsonrpc: '2.0', id: responseId(message), result: { structuredContent: { threads: [] } }, private: receipt }, { 'mcp-session-id': 'session-1' });
      };
      await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, {
        fetchImpl, now: () => clock, waitMs: 10000, pollMs: 10000, wait: async ms => { clock += ms; },
      }), error => error.code === 'agentmail_bad_reply' && !error.message.includes(receipt) && !error.message.includes('123456'));
    }
  }
});

test('SSE joins data fields within an event and finds the matching reply among notifications and other ids', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  for (const newline of ['\n', '\r\n', '\r']) {
    const single = mailbox([message => {
      assert.equal(message.id, 2);
      return answer(200, [
        'data: {"jsonrpc":"2.0","id":2,',
        `data: "result":${JSON.stringify({ structuredContent: { threads: [threadWith('123456')] } })}}`, '', '',
      ].join(newline));
    }]);
    assert.equal(await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl: single.fetchImpl, now: () => sentAt }), '123456');
    const { fetchImpl } = mailbox([message => answer(200, [
      ': keep-alive',
      'event: message',
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { text: 'synthetic notice' } })}`,
      '',
      'id: transport-event',
      'event: message',
      `data: {"jsonrpc":"2.0","id":${message.id},`,
      `data: "result": ${JSON.stringify({ structuredContent: { threads: [threadWith('123456')] } })}}`,
      '',
      `data:${JSON.stringify({ jsonrpc: '2.0', id: message.id + 100, result: { structuredContent: { threads: [threadWith('654321')] } } })}`,
      '',
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}`,
      '',
      '',
    ].join(newline))]);
    assert.equal(await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => sentAt }), '123456');
  }
});

test('SSE refusals, malformed events and duplicate matching replies keep sanitized failure categories', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const receipt = 'private-provider-123456';
  const failure = id => ({ jsonrpc: '2.0', id, error: { code: -32602, message: receipt } });
  const success = id => ({ jsonrpc: '2.0', id, result: { structuredContent: { threads: [threadWith('123456')] } } });
  const events = replies => replies.map(reply => `data: ${JSON.stringify(reply)}\n\n`).join('');
  for (const [reply, expected] of [
    [() => `data: {"private":"${receipt}",\r\ndata: invalid JSON}\r\n\r\n`, 'agentmail_bad_reply'],
    [message => events([failure(message.id)]), 'agentmail_refused'],
    [message => events([failure(message.id + 1)]), 'agentmail_bad_reply'],
    [message => events([failure(message.id), { jsonrpc: '2.0', id: message.id + 1, result: { structuredContent: { threads: [] } } }]), 'agentmail_refused'],
    [message => events([success(message.id), success(message.id)]), 'agentmail_bad_reply'],
    [message => events([success(message.id), failure(message.id)]), 'agentmail_bad_reply'],
    [message => events([failure(message.id), success(message.id)]), 'agentmail_bad_reply'],
  ]) {
    let clock = sentAt;
    const { fetchImpl } = mailbox([message => { assert.equal(message.id, 2); return answer(200, reply(message)); }]);
    await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, {
      fetchImpl, now: () => clock, waitMs: 10000, pollMs: 10000, wait: async ms => { clock += ms; },
    }), error => error.code === expected && !error.message.includes(receipt) && !error.message.includes('123456'));
  }
});

test('a poll follows a continuation in the same inbox and stops on a fresh matching code', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const { fetchImpl, calls } = mailbox([
    { threads: [threadWith('111111', { at: 'invalid' }), threadWith('222222', { to: 'other@example.test' })], nextPageToken: 'next' },
    { threads: [threadWith('333333', { at: '2026-11-21T11:59:54Z' }), threadWith('444444')], nextPageToken: 'not-needed' },
  ]);
  assert.equal(await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => sentAt }), '444444');
  assert.deepEqual(calls, [{ inboxId: inboxOf(EMAIL) }, { inboxId: inboxOf(EMAIL), pageToken: 'next' }]);
});

test('end of pages completes a poll, so the next poll starts again at page one', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = sentAt;
  const { fetchImpl, calls } = mailbox([{ threads: [], nextPageToken: 'next' }, [], [threadWith('555555')]]);
  assert.equal(await latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, wait: async ms => { clock += ms; } }), '555555');
  assert.deepEqual(calls.map(one => one.pageToken), [undefined, 'next', undefined]);
  assert.equal(clock - sentAt, AGENTMAIL.poll_ms);
});

test('provider refusals and malformed thread replies are not empty inboxes and do not expose provider text', async () => {
  const receipt = 'provider-secret-123456';
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  for (const [reply, expected] of [
    [() => answer(403, receipt), 'agentmail_refused'],
    [{ error: { code: -32602, message: receipt } }, 'agentmail_refused'],
    [{ result: { isError: true, content: [{ type: 'text', text: receipt }] } }, 'agentmail_refused'],
    [{ result: { content: [{ type: 'text', text: receipt }] } }, 'agentmail_bad_reply'],
    [{ result: { structuredContent: { threads: null } } }, 'agentmail_bad_reply'],
  ]) {
    const listing = typeof reply === 'function' ? reply : message => answer(200, { jsonrpc: '2.0', id: message.id, ...reply });
    const { fetchImpl, calls } = mailbox([{ threads: [], nextPageToken: 'next' }, listing]);
    await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => sentAt }), error => error.code === expected && !error.message.includes(receipt));
    assert.equal(calls.length, 2);
  }
});

test('a repeated continuation and a page limit refuse an incomplete search without leaking the token', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const loop = mailbox([{ threads: [], nextPageToken: 'fixture-secret-repeated' }]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl: loop.fetchImpl, now: () => sentAt }), error => error.code === 'agentmail_bad_reply' && !error.message.includes('fixture-secret-repeated'));
  assert.equal(loop.calls.length, 2);
  const more = mailbox(Array.from({ length: AGENTMAIL.pages_per_poll }, (_, i) => ({ threads: [], nextPageToken: `next-${i}` })));
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl: more.fetchImpl, now: () => sentAt }), { code: 'agentmail_scan_incomplete' });
  assert.equal(more.calls.length, AGENTMAIL.pages_per_poll);
});

test('the polling deadline stops before the next page and reports an incomplete scan', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = sentAt;
  const { fetchImpl, calls } = mailbox([message => {
    clock += 100;
    return answer(200, { id: message.id, result: { structuredContent: { threads: [], nextPageToken: 'late' } } });
  }]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, waitMs: 100 }), { code: 'agentmail_scan_incomplete' });
  assert.equal(calls.length, 1);
});

test('a page arriving at or after the absolute deadline cannot return a code or complete an empty scan', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const waitMs = 10;
  for (const page of [0, 1]) {
    for (const elapsed of [waitMs - 1, waitMs, waitMs + 1]) {
      let clock = sentAt;
      const latePage = message => {
        clock += elapsed;
        return answer(200, { jsonrpc: '2.0', id: message.id, result: { structuredContent: { threads: [threadWith('123456', { at: new Date(sentAt + 1).toISOString() })] } } });
      };
      const { fetchImpl, calls } = mailbox(page ? [{ threads: [], nextPageToken: 'next' }, latePage] : [latePage]);
      const pending = latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, waitMs });
      if (elapsed < waitMs) assert.equal(await pending, '123456');
      else await assert.rejects(pending, error => error.code === 'agentmail_scan_incomplete' && !error.message.includes('123456'));
      assert.equal(calls.length, page + 1);
    }
  }
  let clock = sentAt;
  const { fetchImpl } = mailbox([message => {
    clock += waitMs;
    return answer(200, { jsonrpc: '2.0', id: message.id, result: { structuredContent: { threads: [] } } });
  }]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, waitMs }), { code: 'agentmail_scan_incomplete' });
});

test('a buffered JSON page that crosses the deadline during parsing is rejected before returning its code', async t => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = sentAt;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, reviver) => {
    const body = parse(text, reviver);
    if (body?.id === 2 && body.result?.structuredContent) clock = sentAt + 11;
    return body;
  });
  const { fetchImpl, calls } = mailbox([message => {
    assert.equal(message.id, 2);
    return answer(200, { jsonrpc: '2.0', id: 2, result: { structuredContent: { threads: [threadWith('123456', { at: new Date(sentAt + 1).toISOString() })] } } });
  }]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => clock, waitMs: 10 }),
    error => error.code === 'agentmail_scan_incomplete' && !error.message.includes('123456'));
  assert.equal(calls.length, 1);
});

test('a transport failure is reported without leaking the underlying error', async () => {
  const sentAt = Date.parse('2026-11-21T12:00:00Z');
  const { fetchImpl } = mailbox([() => { throw new Error('private transport details'); }]);
  await assert.rejects(latestSignInCode({ apiKey: KEY, email: EMAIL, sentAt }, { fetchImpl, now: () => sentAt }),
    error => error.code === 'agentmail_unavailable' && !error.message.includes('private transport details'));
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

test('a whole sign-in marks the ask before sending, so delivery during the send request still qualifies', async () => {
  const askedAt = Date.parse('2026-11-21T12:00:00Z');
  let clock = askedAt;
  const mail = mailbox([[threadWith('123456', { at: new Date(askedAt + 1000).toISOString() })]]);
  const fetchImpl = async (url, init) => {
    if (url === AGENTMAIL.mcp) return mail.fetchImpl(url, init);
    if (url.endsWith('/send-verification-otp')) {
      clock += 10000;
      return answer(200, {});
    }
    assert.equal(url, `${ORIGIN}/api/auth/sign-in/email-otp`);
    assert.equal(JSON.parse(init.body).otp, '123456');
    return answer(200, {}, { 'set-cookie': ['sid=synthetic; Path=/; HttpOnly'] });
  };
  const cookies = await emailCodeSession({ origin: ORIGIN, email: EMAIL }, {
    fetchImpl, now: () => clock, wait: async ms => { clock += ms; }, readKey: async () => KEY,
  });
  assert.equal(cookies[0].name, 'sid');
  assert.equal(clock, askedAt + 10000);
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

test('a Set-Cookie line keeps its end in seconds: Max-Age from now, else Expires', () => {
  const now = Date.UTC(2026, 10, 21);
  assert.equal(cookieOfSetCookie('__Host-s=v; Path=/; Max-Age=604800; Expires=Thu, 01 Jan 2026 00:00:00 GMT', 'h', now).expires, now / 1000 + 604800);
  assert.equal(cookieOfSetCookie('a=v; Expires=Sat, 28 Nov 2026 00:00:00 GMT', 'h', now).expires, Date.UTC(2026, 10, 28) / 1000);
  assert.equal(cookieOfSetCookie('a=v; Path=/', 'h', now).expires, undefined);
});

test('an address with a +tag is read from its inbox without the tag', () => {
  assert.equal(inboxOf('trillion-proofs+gateway-live-check@agentmail.to'), 'trillion-proofs@agentmail.to');
  assert.equal(inboxOf('trillion@agentmail.to'), 'trillion@agentmail.to');
});
