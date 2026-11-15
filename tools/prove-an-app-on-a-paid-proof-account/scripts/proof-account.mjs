// Current Rust account browser fixture, for an explicitly isolated Computer owned by the caller.
// Source contracts: trillion-rust src/native_entry/computer/signup.rs; src/account/sign_in/routes.rs
// way_setup; ways.rs Proof::Key; keys.rs; account/account_routes.rs principal_answer.
// This does not provide a paid plan, a seller, customer setup admission or the original native/browser proofs.
// The Computer fixture supplies its fresh page, an independent read of the account it created, and whole-fixture
// teardown. It must own a temporary Computer and browser; it must never supply a person's existing account.
import { randomUUID } from 'node:crypto';

const hex = /^[0-9a-f]{64}$/;
const keyShape = /^nm_([0-9a-f]{64})_[0-9a-f]{64}$/;

function fixtureOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The proof account needs its isolated Computer loopback origin.');
  }
  return url.origin;
}

async function admittedPrincipal(origin, key, request, timeoutMs) {
  const response = await request(`${origin}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'run_resource_operation', arguments: {
        address: '@sign-in', method: 'sign-in:principal', request_key: `proof-principal-${randomUUID()}`, input: {},
      },
    } }),
  });
  if (!response.ok) throw new Error('The created key was not admitted by its Computer.');
  const answer = await response.json();
  if (answer.error || answer.result?.isError) throw new Error('The created key identity read was refused.');
  return answer.result?.structuredContent;
}

/**
 * Make one account with the current browser signup and key form; run its consumer; always tear down the whole
 * isolated Computer fixture. readCreatedAccount(address) independently returns {address, ownerId} from that
 * temporary Computer's state, before a personal key is issued. A signup or key-creation write is never retried.
 * accountOrigin is account-qualified; accountId is the internal owner id, not the public address or a UUID.
 */
export async function withProofAccount(fixture, consume, { request = fixture?.request ?? fetch, timeoutMs = 30_000 } = {}) {
  if (fixture?.isolated !== true || typeof fixture.close !== 'function'
    || typeof fixture.readCreatedAccount !== 'function' || typeof consume !== 'function') {
    throw new Error('The proof account requires an owned isolated Computer fixture and its teardown.');
  }
  let stage = 'fixture admission';
  let result;
  let failure;
  try {
    const origin = fixtureOrigin(fixture.origin);
    const page = fixture.page;
    const context = page.context();
    if ((await context.cookies(origin)).length) throw new Error('The fixture browser must start without account cookies.');
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    } });
    stage = 'browser sign-up';
    const opened = await page.goto(`${origin}/sign-up`, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    if (!opened?.ok()) throw new Error('The Computer did not offer sign-up.');
    const proofName = `trillion-proof+${randomUUID()}@example.test`;
    await page.locator('#page-field-passkey-name').fill(proofName, { timeout: timeoutMs });
    const finished = page.waitForResponse(response => {
      if (response.url() !== `${origin}/sign-up/finish` || response.request().method() !== 'POST') return false;
      try { return response.request().postDataJSON()?.name === proofName; } catch { return false; }
    }, { timeout: timeoutMs });
    // Observe the original write before pressing its button; neither navigation failure nor a refusal repeats it.
    const [signup] = await Promise.all([finished, page.locator('[data-purpose="sign-up"]').click({ timeout: timeoutMs })]);
    if (!signup.ok()) throw new Error('The Computer refused sign-up.');
    const address = (await signup.json()).address;
    if (!hex.test(address ?? '')) throw new Error('Sign-up did not name one account.');
    stage = 'created account binding';
    const created = await fixture.readCreatedAccount(address);
    if (created?.address !== address || !hex.test(created.ownerId ?? '') || created.ownerId === address) {
      throw new Error('The isolated Computer did not independently bind the created account.');
    }
    const accountOrigin = `${origin}/a/${address}`;
    stage = 'browser key creation';
    const keyPage = await page.goto(`${accountOrigin}/sign-in/security/way?way=personal-key`, {
      timeout: timeoutMs, waitUntil: 'domcontentloaded',
    });
    if (!keyPage?.ok() || page.url() !== `${accountOrigin}/sign-in/security/way?way=personal-key`) {
      throw new Error('The new browser session cannot create its own key.');
    }
    await page.locator('input[name="key_name"]').fill(proofName, { timeout: timeoutMs });
    const keyReply = page.waitForResponse(response => {
      if (response.url() !== `${accountOrigin}/sign-in/security/way` || response.request().method() !== 'POST') return false;
      const form = new URLSearchParams(response.request().postData() ?? '');
      return form.get('way') === 'personal-key' && form.get('step') === 'add' && form.get('key_name') === proofName;
    }, { timeout: timeoutMs });
    const [shown] = await Promise.all([keyReply,
      page.locator(`form[action="/a/${address}/sign-in/security/way"] button[type="submit"]`).click({ timeout: timeoutMs }),
    ]);
    if (!shown.ok()) throw new Error('The new browser session refused key creation.');
    const keys = [...(await shown.text()).matchAll(/class="page-item-heading">(nm_[0-9a-f]{64}_[0-9a-f]{64})</g)].map(match => match[1]);
    if (keys.length !== 1 || keyShape.exec(keys[0])?.[1] !== address) {
      throw new Error('The shown key does not name exactly the created account.');
    }
    const key = keys[0];
    stage = 'key identity readback';
    const principal = await admittedPrincipal(accountOrigin, key, request, timeoutMs);
    if (principal?.account_id !== created.ownerId || !/^key:[0-9a-f]{64}$/.test(principal.sign_in ?? '')
      || principal.client_id !== proofName) throw new Error('The key readback did not match the created account and key name.');
    stage = 'consumer';
    result = await consume({ page, key, address, accountId: created.ownerId, accountOrigin });
  } catch {
    // Playwright errors can contain request details and a one-time key. Keep only this fixed stage in reports.
    failure = new Error(`The isolated account proof failed at ${stage}.`);
  }
  try { await fixture.close(); }
  catch { failure = new Error(`The isolated account proof teardown failed${failure ? ` after ${stage}` : ''}.`); }
  if (failure) throw failure;
  return result;
}
