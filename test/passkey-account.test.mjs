// test/passkey-account.test.mjs
// test-helpers/passkey-account.mjs with a stubbed launcher, no network: the browser it starts gets a virtual passkey
// device, an account made in it is deleted (and only after its identity is read back) when the browser closes, and a
// deletion that fails is reported after the browser is closed anyway.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserWithPasskeyDevice, newPasskeyPage, registerMadeAccount, ProofBrowserCleanupError, safeErrorLine } from '../test-helpers/passkey-account.mjs';

function fakeBrowser({ viewer = 'u1', deleteSays = { said: 'Your account is deleted.' } } = {}) {
  const sent = [], requests = [];
  const browser = { closed: false, listeners: {} };
  const request = {
    get: async url => { requests.push(['GET', url]); return { status: () => 200, json: async () => ({ user_id: viewer }) }; },
    post: async (url, options) => { requests.push(['POST', url, options.headers]); return { status: () => 200, json: async () => deleteSays }; },
  };
  const context = { request, browser: () => browser, newCDPSession: async () => ({ send: async (method, params) => { sent.push([method, params]); } }) };
  const page = { context: () => context, isClosed: () => false };
  context.newPage = async () => page;
  Object.assign(browser, {
    newPage: async () => page,
    newContext: async () => context,
    close: async () => { browser.closed = true; },
    on() {}, off() {}, once() {}, isConnected: () => true,
  });
  return { browser, page, sent, requests };
}

test('the stubbed launcher is used, given the options, and its page gets a virtual passkey device', async () => {
  const fake = fakeBrowser();
  let given = null;
  const { browser, page } = await browserWithPasskeyDevice({ handleSignals: false, args: ['--x'], launchBrowser: async options => { given = options; return fake.browser; } });
  assert.equal(browser, fake.browser);
  assert.equal(page, fake.page);
  assert.deepEqual(given.args, ['--x']);
  assert.equal(given.handleSIGINT, false);
  assert.deepEqual(fake.sent.map(([method]) => method), ['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator']);
  assert.deepEqual(fake.sent[1][1].options, { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true });
  await browser.close();
  assert.equal(fake.browser.closed, true);
});

test('closing deletes the account made in it, after reading back that the session is that account', async () => {
  const fake = fakeBrowser();
  const { browser, page } = await browserWithPasskeyDevice({ handleSignals: false, launchBrowser: async () => fake.browser });
  const made = registerMadeAccount(page, 'https://computer.test/a/addr', { proofName: 'trillion-proof+1@example.test' });
  made.userId = 'u1';
  await browser.close();
  assert.deepEqual(fake.requests.map(([method, url]) => `${method} ${url}`), ['GET https://computer.test/a/addr/work/api/viewer', 'POST https://computer.test/a/addr/work/api/account/delete']);
  assert.deepEqual(fake.requests[1][2], { origin: 'https://computer.test/a/addr' });
  assert.equal(fake.browser.closed, true);
});

test('an account it cannot delete, or whose session is another account, is reported after the browser closes', async () => {
  const refused = fakeBrowser({ deleteSays: { error: 'not found' } });
  const one = await browserWithPasskeyDevice({ handleSignals: false, launchBrowser: async () => refused.browser });
  registerMadeAccount(one.page, 'https://computer.test', { proofName: 'p' }).userId = 'u1';
  await assert.rejects(one.browser.close(), error => error instanceof ProofBrowserCleanupError && error.browserClosed && /not deleted: HTTP 200, not found/.test(error.message));
  assert.equal(refused.browser.closed, true);

  const other = fakeBrowser({ viewer: 'someone-else' });
  const two = await browserWithPasskeyDevice({ handleSignals: false, launchBrowser: async () => other.browser });
  registerMadeAccount(two.page, 'https://computer.test', { proofName: 'p' }).userId = 'u1';
  await assert.rejects(two.browser.close(), /signed in to a different account/);
  assert.deepEqual(other.requests.map(([method]) => method), ['GET'], 'no delete is sent for another account');
});

test('newPasskeyPage gives a second context its own virtual device; safeErrorLine keeps no address or credential', async () => {
  const fake = fakeBrowser();
  const { page } = await newPasskeyPage(fake.browser);
  assert.equal(page, fake.page);
  assert.deepEqual(fake.sent.map(([method]) => method), ['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator']);
  assert.equal(safeErrorLine(new Error('failed at https://x.test/a?k=1 token=abc\nCall log: secret')), 'failed at [URL REDACTED] [CREDENTIAL REDACTED]');
  assert.equal(safeErrorLine(new Error('Cookie: a=b')), 'Browser operation failed.');
});
