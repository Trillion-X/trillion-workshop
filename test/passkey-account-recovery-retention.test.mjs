import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccount } from '../test-helpers/passkey-account.mjs';
import { EventEmitter } from 'node:events';

const USER = '12345678-1234-4abc-8def-1234567890ab';
const KEY = 'one-time-recovery-key';

function fakePage({ identity = USER, mintFailure = false, probeFailure = false } = {}) {
  const calls = [];
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ browser: () => ({}) }),
    goto: async () => {},
    locator: () => ({ count: async () => 0, first() { return this; }, click: async () => calls.push('signup') }),
    waitForURL: async () => {},
    evaluate: async (fn, argument) => {
      const text = String(fn);
      if (text.includes("fetch('/work/api/viewer')")) return identity;
      if (text.includes("fetch('/work/api/account/keys/new'")) {
        calls.push('mint');
        if (mintFailure) throw new Error('mint interrupted');
        return KEY;
      }
      if (text.includes("fetch('/mcp/api/account'")) {
        calls.push('identity-probe');
        if (probeFailure) throw new Error('probe interrupted');
        assert.equal(argument, KEY);
        return identity;
      }
      throw new Error('unexpected browser evaluation');
    },
  });
  return { page, calls };
}

const callbacks = (calls, events, { throwRegistered = false, throwIdentity = false, throwCreated = false } = {}) => ({
  onRegistered: ({ proofName }) => { calls.push('registered'); events.push({ type: 'proof_account_signup_requested', proof_name: proofName }); if (throwRegistered) throw new Error('registered callback interrupted'); },
  onIdentity: ({ proofName, userId }) => { calls.push('identity'); events.push({ type: 'isolated_account_created', proof_name: proofName, user_id: userId }); if (throwIdentity) throw new Error('identity callback interrupted'); },
  onCreated: ({ userId, key }) => { calls.push('created'); events.push({ type: 'key-retained', user_id: userId, key }); if (throwCreated) throw new Error('created callback interrupted'); },
});

test('signup intent is recorded before the one signup action; identity before a failing key mint remains attributed', async () => {
  const { page, calls } = fakePage({ mintFailure: true }), events = [];
  await assert.rejects(createAccount(page, 'https://app.example.test', { ...callbacks(calls, events) }), /mint interrupted/);
  assert.deepEqual(calls, ['registered', 'signup', 'identity', 'mint']);
  assert.equal(events[0].type, 'proof_account_signup_requested');
  assert.equal(events[1].type, 'isolated_account_created');
  assert.equal(events[1].user_id, USER);
});

test('a late identity-probe interruption happens after the key was retained', async () => {
  const { page, calls } = fakePage({ probeFailure: true }), events = [];
  await assert.rejects(createAccount(page, 'https://app.example.test', { ...callbacks(calls, events), keep: true }), /probe interrupted/);
  assert.deepEqual(calls, ['registered', 'signup', 'identity', 'mint', 'created', 'identity-probe']);
  assert.equal(events.find(row => row.type === 'key-retained').key, KEY);
});

test('a callback interruption never repeats signup or key mint', async () => {
  const { page, calls } = fakePage(), events = [];
  await assert.rejects(createAccount(page, 'https://app.example.test', { ...callbacks(calls, events, { throwCreated: true }), keep: true }), /created callback interrupted/);
  assert.equal(calls.filter(value => value === 'signup').length, 1);
  assert.equal(calls.filter(value => value === 'mint').length, 1);
  assert.equal(calls.includes('identity-probe'), false);
});

test('no-key signup still records the browser-verified account identity', async () => {
  const { page, calls } = fakePage(), events = [];
  const result = await createAccount(page, 'https://app.example.test', { ...callbacks(calls, events), makeKey: false });
  assert.equal(result, null);
  assert.deepEqual(calls, ['registered', 'signup', 'identity']);
  assert.equal(events.at(-1).user_id, USER);
});

test('a navigation timeout keeps its original error and records only an original-response/session matched identity', async () => {
  for (const matches of [true, false]) {
    const { page, calls } = fakePage(), events = [];
    const original = new Error('original navigation timeout');
    let proofName, basis, reads = 0;
    page.waitForURL = async () => { throw original; };
    page.context = () => ({ browser: () => ({}), request: { get: async () => {
      reads++;
      return { ok: () => true, headers: () => ({ 'content-type': 'application/json' }),
        json: async () => ({ user_id: matches ? USER : 'another-account' }) };
    } } });
    const response = (path, input, body) => ({ url: () => `https://app.example.test${path}`,
      ok: () => true, request: () => ({ method: () => 'POST', postDataJSON: () => input }), json: async () => body });
    page.locator = () => ({ count: async () => 0, first() { return this; }, click: async () => {
      calls.push('signup');
      page.emit('response', response('/passkey/options', { mode: 'create', name: proofName }, { challenge_id: 'memory-only' }));
      page.emit('response', response('/passkey/finish', { mode: 'create', name: proofName, challenge_id: 'memory-only' },
        { keep_passkeys: { user_id: Buffer.from(USER).toString('base64url') } }));
    } });
    const cb = callbacks(calls, events);
    await assert.rejects(createAccount(page, 'https://app.example.test', { ...cb, navigate: false,
      onRegistered: value => { proofName = value.proofName; cb.onRegistered(value); },
      onIdentity: value => { basis = value.identity_basis; cb.onIdentity(value); },
    }), error => error === original);
    assert.equal(reads, 1);
    assert.deepEqual(calls, matches ? ['registered', 'signup', 'identity'] : ['registered', 'signup']);
    assert.equal(events.some(e => e.type === 'isolated_account_created'), matches);
    assert.equal(basis, matches ? 'original-signup-response-and-session-read-after-navigation-failure' : undefined);
    assert.equal(page.listenerCount('response'), 0);
  }
});

test('identity callback failure after signup does not issue a key or repeat signup', async () => {
  const { page, calls } = fakePage(), events = [];
  await assert.rejects(createAccount(page, 'https://app.example.test', { ...callbacks(calls, events, { throwIdentity: true }), keep: true }), /identity callback interrupted/);
  assert.equal(calls.filter(value => value === 'signup').length, 1);
  assert.equal(calls.includes('mint'), false);
});

test('the authenticated key identity must equal the browser-verified identity', async () => {
  const { page, calls } = fakePage();
  const originalEvaluate = page.evaluate;
  page.evaluate = async (fn, argument) => {
    if (String(fn).includes("fetch('/mcp/api/account'")) { calls.push('identity-probe'); return '87654321-4321-4abc-8def-1234567890ab'; }
    return originalEvaluate(fn, argument);
  };
  await assert.rejects(createAccount(page, 'https://app.example.test', { keep: true }), /did not match browser account/);
  assert.deepEqual(calls, ['signup', 'mint', 'identity-probe']);
});


test('a verified original signup may continue on main without repeating signup or identity callbacks', async () => {
  for (const swapped of [false, true]) {
    const { page, calls } = fakePage({ identity: swapped ? '87654321-4321-4abc-8def-1234567890ab' : USER });
    const events = [], original = new Error('original URL commit timeout');
    let proofName, rootOpens = 0;
    page.goto = async url => { if (url.endsWith('/')) { rootOpens++; calls.push('open-root'); } };
    page.waitForURL = async () => { throw original; };
    page.context = () => ({ browser: () => ({}), request: { get: async () => ({
      ok: () => true, headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ user_id: USER }) }) } });
    const response = (path, input, body) => ({ url: () => `https://app.example.test${path}`, ok: () => true,
      request: () => ({ method: () => 'POST', postDataJSON: () => input }), json: async () => body });
    page.locator = () => ({ count: async () => 0, first() { return this; }, click: async () => {
      calls.push('signup');
      page.emit('response', response('/passkey/options', { mode: 'create', name: proofName }, { challenge_id: 'memory-only' }));
      page.emit('response', response('/passkey/finish', { mode: 'create', name: proofName, challenge_id: 'memory-only' },
        { keep_passkeys: { user_id: Buffer.from(USER).toString('base64url') } }));
    } });
    const cb = callbacks(calls, events);
    const run = () => createAccount(page, 'https://app.example.test', { ...cb,
      onRegistered: value => { proofName = value.proofName; cb.onRegistered(value); },
      onNavigationFailure: value => { calls.push('original-failure'); assert.equal(value.error, original.message); assert.equal(value.continuation_planned, true); },
      onNavigationRecovered: value => { calls.push('navigation-recovered'); assert.equal(value.userId, USER); },
    });
    if (swapped) await assert.rejects(run(), error => error === original);
    else assert.equal(await run(), KEY);
    assert.equal(rootOpens, 1);
    assert.equal(calls.filter(x => x === 'signup').length, 1);
    assert.equal(calls.filter(x => x === 'identity').length, 1);
    assert.equal(calls.filter(x => x === 'mint').length, swapped ? 0 : 1);
    assert.equal(calls.filter(x => x === 'navigation-recovered').length, swapped ? 0 : 1);
    assert.equal(calls.indexOf('original-failure') < calls.indexOf('open-root'), true);
  }
});

test('an ambient viewer without the original successful signup cannot continue or mint', async () => {
  const { page, calls } = fakePage(), original = new Error('original incomplete signup timeout');
  let rootOpens = 0;
  page.waitForURL = async () => { throw original; };
  page.goto = async url => { if (url.endsWith('/')) rootOpens++; };
  await assert.rejects(createAccount(page, 'https://app.example.test'), error => error === original);
  assert.equal(rootOpens, 0);
  assert.equal(calls.includes('mint'), false);
});
