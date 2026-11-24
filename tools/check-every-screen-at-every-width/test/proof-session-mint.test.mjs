// test/proof-session-mint.test.mjs
// proof-session-mint.mjs mints the proof sessions again in three runs. These tests use a fake site (send, sign-in and
// get-session answers), a fake mailbox reader and a fake vault door, and check: a code is asked only for proof-accounts.json's
// addresses; the codes and the sessions go to the vault, never into an answer; a session is kept only when the site says it is
// the proof account's; the code value is marked spent; and a put names only the existing values with the accounts' hosts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENTMAIL } from '../email-code.mjs';
import { accountsOf, askForSignInCodes, hostsOf, keepSignInCodes, PROOF, signInWithKeptCodes } from '../proof-session-mint.mjs';

const ACCOUNTS = [
  { origin: 'https://a.example', email: 'proofs+a@agentmail.to' },
  { origin: 'https://b.example', email: 'proofs+b@agentmail.to' },
];
const CODE = '123456';
const SESSION = 'session-value-not-real';

const answer = (status, body = {}, cookies = []) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null, getSetCookie: () => cookies },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function vault() {
  const puts = [];
  return { puts, door: { secrets: async (method, input) => { puts.push({ method, ...input }); return { accepted: true }; } } };
}

// A fake site: sends codes, takes CODE for a session, and answers get-session for that session as `owner`.
function site({ owner = email => email, sendStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    calls.push(`${origin}${pathname}`);
    if (pathname.endsWith('/send-verification-otp')) return answer(sendStatus);
    if (pathname.endsWith('/sign-in/email-otp')) {
      const { email, otp } = JSON.parse(init.body);
      return otp === CODE ? answer(200, {}, [`__Host-s=${SESSION}.${email}; Path=/; Max-Age=604800; HttpOnly; Secure`, 'cache=c; Max-Age=300']) : answer(401);
    }
    if (pathname.endsWith('/get-session')) {
      const email = /__Host-s=[^.;]+\.([^;]+)/.exec(init.headers.cookie)?.[1];
      return answer(200, email ? { user: { email: owner(email) } } : null);
    }
    return answer(404);
  };
  return { fetchImpl, calls };
}

test('the accounts are proof-accounts.json\'s, every put names their hosts, and an origin it does not name is refused', () => {
  assert.ok(PROOF.accounts.length >= 1 && PROOF.accounts.every(account => account.email.endsWith('@agentmail.to')));
  assert.deepEqual(hostsOf(ACCOUNTS), ['a.example', 'b.example']);
  assert.throws(() => accountsOf(['https://elsewhere.example'], ACCOUNTS), /no proof account/);
  assert.deepEqual(accountsOf(['https://b.example'], ACCOUNTS), [ACCOUNTS[1]]);
});

test('step 1 asks each site for its proof account\'s code and answers statuses only', async () => {
  const { fetchImpl, calls } = site();
  const asked = await askForSignInCodes({}, undefined, { fetchImpl, now: () => 1000, accounts: ACCOUNTS });
  assert.equal(asked.asked_at, 1000);
  assert.deepEqual(asked.origins, [{ origin: 'https://a.example', sent: true, status: 200 }, { origin: 'https://b.example', sent: true, status: 200 }]);
  assert.deepEqual(calls, ['https://a.example/api/auth/email-otp/send-verification-otp', 'https://b.example/api/auth/email-otp/send-verification-otp']);
  await assert.rejects(askForSignInCodes({}, undefined, { fetchImpl: site({ sendStatus: 429 }).fetchImpl, accounts: ACCOUNTS }), error => error.code === 'code_not_sent');
});

test('the ask time precedes both send requests and reaches the code reader unchanged', async () => {
  let clock = 1000;
  const { door } = vault();
  const sends = [];
  const asked = await askForSignInCodes({}, undefined, {
    accounts: ACCOUNTS, now: () => clock, fetchImpl: async () => { sends.push(clock); clock += 10000; return answer(200); },
  });
  assert.equal(asked.asked_at, 1000);
  assert.deepEqual(sends, [1000, 11000]);
  const reads = [];
  await keepSignInCodes({ asked_at: asked.asked_at }, undefined, {
    accounts: ACCOUNTS, door, readKey: async () => 'synthetic-key', latest: async ({ sentAt }) => { reads.push(sentAt); return CODE; },
  });
  assert.deepEqual(reads, [1000, 1000]);
});

test('step 2 puts the codes in the vault under the code value and answers origins only', async () => {
  const { puts, door } = vault();
  const latest = async ({ email }) => { if (email.includes('+b')) throw Object.assign(new Error('none'), { code: 'code_not_found' }); return CODE; };
  const kept = await keepSignInCodes({ asked_at: 1000 }, undefined, { readKey: async () => 'key', door, accounts: ACCOUNTS, latest });
  assert.deepEqual(kept, { kept: ['https://a.example'], missing: [{ origin: 'https://b.example', reason: 'code_not_found' }] });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].name, PROOF.code_value);
  assert.deepEqual(puts[0].hosts, ['a.example', 'b.example']);
  assert.deepEqual(JSON.parse(puts[0].value), { 'https://a.example': { email: 'proofs+a@agentmail.to', code: CODE } });
  assert.ok(!JSON.stringify(kept).includes(CODE));
  await assert.rejects(keepSignInCodes({}, undefined, { door, accounts: ACCOUNTS }), /asked_at/);
});

test('step 2 distinguishes an empty completed scan from a refusal and keeps no value when all lookups fail', async () => {
  const { puts, door } = vault();
  const deps = { readKey: async () => 'key', door, accounts: ACCOUNTS };
  const issue = (code) => Object.assign(new Error('synthetic private reply 123456'), { code });
  const latest = async ({ email }) => { throw issue(email === ACCOUNTS[0].email ? 'agentmail_refused' : 'code_not_found'); };
  for (const [origins, expected] of [[[ACCOUNTS[0].origin], 'agentmail_refused'], [[ACCOUNTS[1].origin], 'code_not_found'], [undefined, 'agentmail_lookup_failed']]) {
    await assert.rejects(keepSignInCodes({ asked_at: 1000, origins }, undefined, { ...deps, latest }), error => {
      assert.equal(error.code, expected);
      assert.ok(!error.message.includes(CODE) && !error.message.includes('private reply'));
      assert.match(error.message, /agentmail_refused|code_not_found/);
      return true;
    });
  }
  await assert.rejects(keepSignInCodes({ asked_at: 1000 }, undefined, {
    ...deps, latest: async () => { throw issue('untrusted-private-code'); },
  }), error => error.code === 'agentmail_lookup_failed' && !error.message.includes('untrusted-private-code'));
  assert.deepEqual(puts, []);
});

test('step 2 keeps no value when every real-reader lookup fails', async () => {
  const askedAt = Date.parse('2026-11-21T12:00:00Z');
  for (const [issue, expected] of [['wrong-id', 'agentmail_bad_reply'], ['duplicate-id', 'agentmail_bad_reply'], ['refused-with-unrelated', 'agentmail_refused'], ['outside-window', 'code_not_found'], ['long-code', 'code_not_found'], ['late', 'agentmail_scan_incomplete']]) {
    let clock = askedAt;
    const { puts, door } = vault();
    const fetchImpl = async (url, init) => {
      assert.equal(url, AGENTMAIL.mcp);
      const message = JSON.parse(init.body);
      if (message.method === 'initialize') return answer(200, { jsonrpc: '2.0', id: message.id, result: {} });
      if (message.method === 'notifications/initialized') return { ...answer(202), text: async () => '' };
      if (issue === 'late') clock += AGENTMAIL.wait_ms;
      const threads = ACCOUNTS.map(({ email }) => ({
        recipients: [email], subject: `Your sign-in code: ${CODE}${issue === 'long-code' ? '7' : ''}`,
        timestamp: new Date(askedAt + (issue === 'outside-window' ? -5001 : 1)).toISOString(),
      }));
      const reply = { jsonrpc: '2.0', id: message.id + (issue === 'wrong-id' ? 1 : 0), result: { structuredContent: { threads } } };
      if (issue === 'duplicate-id' || issue === 'refused-with-unrelated') {
        const replies = issue === 'duplicate-id' ? [reply, reply] : [
          { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'synthetic private reply 123456' } },
          { jsonrpc: '2.0', id: message.id + 1, result: { structuredContent: { threads: [] } } },
        ];
        return { ...answer(200), text: async () => replies.map(one => `data: ${JSON.stringify(one)}\n\n`).join('') };
      }
      return answer(200, reply);
    };
    await assert.rejects(keepSignInCodes({ asked_at: askedAt }, undefined, {
      accounts: ACCOUNTS, door, readKey: async () => 'synthetic-key', fetchImpl, now: () => clock, wait: async ms => { clock += ms; },
    }), error => error.code === expected && !error.message.includes(CODE));
    assert.deepEqual(puts, []);
  }
});

test('step 3 keeps a session the site says is the proof account\'s, merges it with the others, and marks the code spent', async () => {
  const { puts, door } = vault();
  const { fetchImpl } = site();
  const others = new Map([['https://b.example', [{ name: 'old', value: 'kept' }]], ['https://a.example', [{ name: 'old', value: 'replaced' }]]]);
  const codes = JSON.stringify({ 'https://a.example': { email: 'proofs+a@agentmail.to', code: CODE } });
  const done = await signInWithKeptCodes({}, undefined, { fetchImpl, door, accounts: ACCOUNTS, now: () => Date.UTC(2026, 10, 21), readCodes: async () => codes, readSessions: async () => others });
  assert.deepEqual(done.origins, [{ origin: 'https://a.example', signed_in: true, expires_at: '2026-11-28T00:00:00.000Z',
    cookies: [{ name: '__Host-s', expires_at: '2026-11-28T00:00:00.000Z' }, { name: 'cache', expires_at: '2026-11-21T00:05:00.000Z' }] }]);
  assert.ok(!JSON.stringify(done).includes(SESSION) && !JSON.stringify(done).includes(CODE));
  assert.deepEqual(puts.map(put => put.name), [PROOF.session_value, PROOF.code_value]);
  const sessions = JSON.parse(puts[0].value);
  assert.deepEqual(sessions['https://b.example'], [{ name: 'old', value: 'kept' }]);
  assert.equal(sessions['https://a.example'][0].name, '__Host-s');
  assert.deepEqual(puts[0].hosts, ['a.example', 'b.example']);
  assert.equal(puts[1].value, '{}');
});

test('step 3 keeps no session the site gives another person, still marks the code spent, and refuses', async () => {
  const { puts, door } = vault();
  const { fetchImpl } = site({ owner: () => 'someone@else.example' });
  const codes = JSON.stringify({ 'https://a.example': { email: 'proofs+a@agentmail.to', code: CODE } });
  await assert.rejects(signInWithKeptCodes({}, undefined, { fetchImpl, door, accounts: ACCOUNTS, readCodes: async () => codes, readSessions: async () => new Map() }),
    error => error.code === 'sign_in_failed' && /not_the_proof_account/.test(error.message));
  assert.deepEqual(puts.map(put => [put.name, put.value]), [[PROOF.code_value, '{}']]);
});

test('step 3 refuses spent or missing codes and a code for an address that is not a proof account', async () => {
  const { door, puts } = vault();
  const deps = { fetchImpl: site().fetchImpl, door, accounts: ACCOUNTS, readSessions: async () => new Map() };
  await assert.rejects(signInWithKeptCodes({}, undefined, { ...deps, readCodes: async () => '{}' }), error => error.code === 'no_codes');
  await assert.rejects(signInWithKeptCodes({}, undefined, { ...deps, readCodes: async () => null }), error => error.code === 'no_codes');
  const stranger = JSON.stringify({ 'https://a.example': { email: 'stranger@example.com', code: CODE } });
  await assert.rejects(signInWithKeptCodes({}, undefined, { ...deps, readCodes: async () => stranger }), /not_a_proof_account/);
  assert.ok(puts.every(put => put.name === PROOF.code_value));
});
