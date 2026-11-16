// Adapter contract checks with page and transport doubles. These do not run Rust, WebAuthn or any live proof.
// Fixtures follow current Rust signup.rs, way_pages.rs shown_once/setup, ways.rs Proof::Key, keys.rs and
// account_routes.rs principal_answer. The actual isolated Computer/browser producer remains separate work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withProofAccount } from '../scripts/proof-account.mjs';

const address = 'a'.repeat(64);
const ownerId = 'b'.repeat(64);
const keyId = 'c'.repeat(64);
const key = `nm_${address}_${'d'.repeat(64)}`;
const origin = 'https://127.0.0.1:18443';
const accountOrigin = `${origin}/a/${address}`;

function standIn(options = {}) {
  const events = [], fields = new Map();
  let waiter, currentUrl;
  let closed = 0, calls = 0;
  const response = ({ url, input, json, html, ok = true, form = false }) => ({
    url: () => url, ok: () => ok,
    request: () => ({ method: () => 'POST', postDataJSON: () => input,
      postData: () => form ? new URLSearchParams(input).toString() : JSON.stringify(input) }),
    json: async () => json, text: async () => html,
  });
  const send = reply => {
    if (waiter.predicate(reply)) waiter.resolve(reply);
    else waiter.reject(new Error('The observed response did not match the original request.'));
  };
  const page = {
    context: () => ({ cookies: async () => options.cookies ?? [], newCDPSession: async () => ({
      send: async method => { events.push(method); },
    }) }),
    url: () => currentUrl,
    goto: async url => {
      events.push(`GET ${url}`);
      currentUrl = options.redirectKeyPage && url.includes('/security/way?') ? `${accountOrigin}/sign-in` : url;
      return { ok: () => true };
    },
    locator: selector => ({
      fill: async value => { fields.set(selector, value); },
      click: async () => {
        if (selector === '[data-purpose="sign-up"]') {
          events.push('signup-write');
          if (options.uncertainSignup) throw new Error(`navigation interrupted ${key}`);
          send(response({ url: `${origin}/sign-up/finish`,
            input: { name: options.wrongSignupName ? 'another registration' : fields.get('#page-field-passkey-name') },
            ok: !options.signupRefused, json: { address: options.address ?? address } }));
        } else {
          assert.equal(selector, `form[action="/a/${address}/sign-in/security/way"] button[type="submit"]`);
          events.push('key-write');
          send(response({ url: `${accountOrigin}/sign-in/security/way`, form: true,
            input: { way: 'personal-key', step: 'add', key_name: fields.get('input[name="key_name"]') },
            html: `<h2 class="page-item-heading">${options.key ?? key}</h2>`, ok: !options.keyRefused }));
        }
      },
    }),
    waitForResponse: predicate => new Promise((resolve, reject) => { waiter = { predicate, resolve, reject }; }),
  };
  const fixture = {
    isolated: true, origin: options.origin ?? origin, page,
    readCreatedAccount: async received => {
      events.push('independent-account-read');
      assert.equal(received, address);
      return options.created ?? { address, ownerId };
    },
    close: async () => { closed += 1; if (options.closeFails) throw new Error(`teardown ${key}`); },
  };
  const request = async (url, init) => {
    events.push('key-principal-read');
    calls += 1;
    assert.equal(url, `${accountOrigin}/mcp`, 'the Computer receives the address-qualified request');
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    assert.equal(init.headers.accept, 'application/json, text/event-stream');
    assert.equal(init.headers.origin, undefined, 'MCP is a Node bearer request, not a cookie/browser request');
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body);
    assert.equal(body.params.name, 'run_resource_operation');
    assert.deepEqual({ ...body.params.arguments, request_key: 'redacted' }, {
      address: '@sign-in', method: 'sign-in:principal', request_key: 'redacted', input: {},
    });
    return { ok: true, json: async () => ({ result: { structuredContent: options.principal ?? {
      account_id: ownerId, sign_in: `key:${keyId}`, client_id: fields.get('input[name="key_name"]'),
    } } }) };
  };
  return { fixture, request, events, closed: () => closed, calls: () => calls };
}

test('current browser forms bind address, owner id and key separately, then tear down the owned fixture', async () => {
  const state = standIn();
  const result = await withProofAccount(state.fixture, async account => {
    assert.deepEqual(account, { page: state.fixture.page, address, accountId: ownerId, accountOrigin, key });
    return 'consumer completed';
  }, { request: state.request });
  assert.equal(result, 'consumer completed');
  assert.equal(state.closed(), 1);
  assert.deepEqual(state.events.filter(event => !event.startsWith('GET ') && !event.startsWith('WebAuthn.')),
    ['signup-write', 'independent-account-read', 'key-write', 'key-principal-read']);
});

test('an uncertain original signup is not replayed and closes the whole fixture without printing its key', async () => {
  const state = standIn({ uncertainSignup: true });
  await assert.rejects(withProofAccount(state.fixture, () => assert.fail('consumer must not start'), { request: state.request }),
    error => error.message === 'The isolated account proof failed at browser sign-up.' && !String(error.stack).includes(key));
  assert.equal(state.events.filter(event => event === 'signup-write').length, 1);
  assert.equal(state.closed(), 1);
  assert.equal(state.calls(), 0);
});

for (const [label, options, stage, mustNotIssueKey] of [
  ['existing browser account', { cookies: [{ name: 'trillion_session', value: 'synthetic' }] }, 'fixture admission', true],
  ['foreign origin', { origin: 'https://app.example.com' }, 'fixture admission', true],
  ['refused signup', { signupRefused: true }, 'browser sign-up', true],
  ['another original registration', { wrongSignupName: true }, 'browser sign-up', true],
  ['unknown created account', { created: { address: 'f'.repeat(64), ownerId } }, 'created account binding', true],
  ['address mistaken for owner id', { created: { address, ownerId: address } }, 'created account binding', true],
  ['expired browser session', { redirectKeyPage: true }, 'browser key creation', true],
  ['refused key creation', { keyRefused: true }, 'browser key creation', false],
  ['key from another account', { key: `nm_${'e'.repeat(64)}_${'d'.repeat(64)}` }, 'browser key creation', false],
  ['principal from another owner', { principal: { account_id: 'e'.repeat(64), sign_in: `key:${keyId}`, client_id: 'other' } }, 'key identity readback', false],
]) {
  test(`${label} cannot reach the consumer and still tears down the fixture`, async () => {
    const state = standIn(options);
    await assert.rejects(withProofAccount(state.fixture, () => assert.fail('consumer must not start'), { request: state.request }),
      { message: `The isolated account proof failed at ${stage}.` });
    assert.equal(state.closed(), 1);
    if (mustNotIssueKey) assert.ok(!state.events.includes('key-write'));
  });
}

test('consumer failure still closes the Computer and does not expose the one-time key', async () => {
  const state = standIn();
  await assert.rejects(withProofAccount(state.fixture, () => { throw new Error(key); }, { request: state.request }),
    error => error.message === 'The isolated account proof failed at consumer.' && !String(error.stack).includes(key));
  assert.equal(state.closed(), 1);
});

test('a teardown failure cannot be reported as success', async () => {
  const state = standIn({ closeFails: true });
  await assert.rejects(withProofAccount(state.fixture, () => 'done', { request: state.request }),
    { message: 'The isolated account proof teardown failed.' });
  assert.equal(state.closed(), 1);
});
