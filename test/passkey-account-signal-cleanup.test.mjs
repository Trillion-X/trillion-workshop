import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { browserWithPasskeyDevice, closeBrowserOnSignals, safeErrorLine, ProofBrowserCleanupError, registerMadeAccount, deleteMadeAccount } from '../test-helpers/passkey-account.mjs';

test('a process signal awaits wrapped browser cleanup once, re-raises the signal, and disconnect removes listeners', async () => {
  const browser = new EventEmitter();
  browser.isConnected = () => true;
  const processEvents = new EventEmitter();
  processEvents.pid = 17;
  processEvents.stderr = { write() {} };
  const raised = [];
  processEvents.kill = (pid, signal) => raised.push([pid, signal]);
  let releaseClose;
  let closes = 0;
  closeBrowserOnSignals(browser, () => {
    closes += 1;
    return new Promise(resolve => { releaseClose = resolve; });
  }, processEvents);

  processEvents.emit('SIGTERM');
  await new Promise(resolve => setImmediate(resolve));
  processEvents.emit('SIGINT');
  assert.equal(closes, 1, 'overlapping signals share one close operation');
  assert.deepEqual(raised, [], 'the signal is not re-raised before cleanup completes');

  browser.emit('disconnected');
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => processEvents.listenerCount(signal)), [0, 0, 0]);
  releaseClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(raised, [[17, 'SIGTERM']], 'the first signal is re-raised after cleanup');
});

function fixture({ reply = { status: 200, body: { said: 'Your account is deleted.' } }, closeError = null, onAccountCleanup = null } = {}) {
  const calls = { close: 0, post: 0 };
  const browser = new EventEmitter();
  browser.isConnected = () => true;
  browser.newPage = async () => page;
  browser.close = async () => {
    calls.close += 1;
    if (closeError) throw closeError;
  };
  const page = {
    isClosed: () => false,
    context: () => context,
  };
  const context = {
    browser: () => browser,
    newCDPSession: async () => ({ send: async () => {} }),
    request: { get: async () => ({ status: () => 200, json: async () => ({ user_id: 'account-id' }) }), post: async () => {
      calls.post += 1;
      return { status: () => reply.status, json: async () => reply.body };
    } },
  };
  return { browser, page, calls, onAccountCleanup };
}

const makeDevice = async options => {
  const state = fixture(options);
  const device = await browserWithPasskeyDevice({ launchBrowser: async () => state.browser, handleSignals: false, onAccountCleanup: options?.onAccountCleanup });
  const made = registerMadeAccount(state.page, 'https://proof.example.test', { proofName: 'proof-account', });
  made.userId = 'account-id';
  return { ...state, ...device };
};

test('browser close still closes after the cleanup report callback fails', async () => {
  const reportError = new Error('cleanup report store unavailable');
  const state = await makeDevice({ onAccountCleanup: async () => { throw reportError; } });

  await assert.rejects(state.browser.close(), error => {
    assert.ok(error instanceof ProofBrowserCleanupError);
    assert.deepEqual(error.accountFailures, []);
    assert.deepEqual(error.otherErrors, [reportError]);
    assert.equal(error.browserClosed, true);
    return true;
  });
  assert.equal(state.calls.close, 1);
  assert.equal(state.calls.post, 1);
});

test('browser close retains account and shutdown failures separately', async () => {
  const closeError = new Error('browser shutdown failed');
  const state = await makeDevice({ reply: { status: 503, body: { error: 'Still clearing.' } }, closeError });

  await assert.rejects(state.browser.close(), error => {
    assert.ok(error instanceof ProofBrowserCleanupError);
    assert.deepEqual(error.accountFailures, [{
      proofName: 'proof-account', userId: 'account-id', origin: 'https://proof.example.test', deleted: false,
      error: 'not deleted: HTTP 503, Still clearing.',
    }]);
    assert.deepEqual(error.otherErrors, [closeError]);
    assert.equal(error.browserClosed, false);
    return true;
  });
  assert.equal(state.calls.close, 1, 'the original browser close is attempted despite account cleanup failure');
  assert.equal(state.calls.post, 1);
});

test('cleanup diagnostics redact response credentials and bearer links before callbacks or evidence', () => {
  const message = safeErrorLine(new Error('Cleanup https://example.test/account?code=private-value Bearer private-access nm_0123456789abcdef0123456789abcdef token=private-token'));
  assert.doesNotMatch(message, /private-value|private-access|nm_0123|private-token/);
  assert.match(message, /Cleanup/);
});

test('cleanup never mutates an unidentified signup or a different browser account', async () => {
  let reads = 0, writes = 0, signins = 0;
  const page = { isClosed: () => false, context: () => ({ request: {
    get: async () => { reads++; return { status: () => 200, json: async () => ({ user_id: 'different' }) }; },
    post: async () => { writes++; throw new Error('must not delete'); },
  } }) };
  assert.match(await deleteMadeAccount({ page, origin: 'https://proof.example.test', signInAgain: () => { signins++; } }), /identity was not recorded/);
  assert.equal(reads, 0);
  assert.match(await deleteMadeAccount({ page, origin: 'https://proof.example.test', userId: 'expected', signInAgain: () => { signins++; } }), /different account/);
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(signins, 0);
});
