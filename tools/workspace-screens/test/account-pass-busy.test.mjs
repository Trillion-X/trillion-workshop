// tools/workspace-screens/test/account-pass-busy.test.mjs
//
// When the sign-in server is busy (429 or 5xx) or the authorize request never arrives, the page's pass says so in its own
// words with the wait the server asks (Retry-After), and never leaves the page for the server's own answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/account-pass.ts', import.meta.url), 'utf8');
const flow = JSON.parse(await readFile(new URL('../web/src/workspace/account-pass.json', import.meta.url), 'utf8'));
const { code } = await transform(source.replace(/^import flow from .*$/m, `const flow = ${JSON.stringify(flow)};`), { loader: 'ts', format: 'esm' });
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString('base64')}`);

const ORIGIN = 'https://door.example.test';
function page(authorize) {
  const assigned = [];
  globalThis.location = { origin: ORIGIN, pathname: '/workspace', search: '', assign: url => assigned.push(url) };
  globalThis.sessionStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  globalThis.fetch = async url => {
    if (String(url).startsWith(`${ORIGIN}${flow.authorize}`)) return authorize();
    return { ok: true, json: async () => ({ access_token: 'pass-1', expires_in: 3600 }) };
  };
  return { assigned };
}

test('a busy sign-in server (429) shows its words with the wait it asks, and the page does not leave', async () => {
  const seen = page(() => ({ ok: false, status: 429, url: '', headers: new Headers({ 'retry-after': '42' }), body: { cancel: async () => {} } }));
  const { pass } = await load();
  await assert.rejects(pass(), error => {
    assert.equal(error.name, 'PassBusy');
    assert.equal(error.busy, flow.busy.replace('{seconds}', '42'));
    assert.equal(error.retry_after_s, 42);
    return true;
  });
  assert.deepEqual(seen.assigned, [], 'the page never left for the server');
});

test('a busy answer with no Retry-After shows the default wait', async () => {
  page(() => ({ ok: false, status: 503, url: '', headers: new Headers(), body: { cancel: async () => {} } }));
  const { pass } = await load();
  await assert.rejects(pass(), error => error.retry_after_s === flow.busy_seconds && error.busy === flow.busy.replace('{seconds}', String(flow.busy_seconds)));
});

test('a request that never arrives is busy too, and the page does not leave', async () => {
  const seen = page(() => { throw new TypeError('network'); });
  const { pass } = await load();
  await assert.rejects(pass(), error => error.name === 'PassBusy');
  assert.deepEqual(seen.assigned, []);
});

// A 429 is asked again after the short wait the server names, so a person whose address many share gets the pass on the
// first load (Nov 21 2026: a live check's first token call answered 429 and every screen drew empty).
function patientPage(authorizeAnswers, tokenAnswers) {
  const calls = { authorize: 0, token: 0 }, assigned = [];
  globalThis.location = { origin: ORIGIN, pathname: '/workspace', search: '', assign: url => assigned.push(url) };
  globalThis.sessionStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  globalThis.setTimeout = (run) => { run(); return 0; };
  globalThis.fetch = async url => {
    if (String(url).startsWith(`${ORIGIN}${flow.authorize}`)) {
      const state = new URL(url).searchParams.get('state');
      return authorizeAnswers[Math.min(calls.authorize++, authorizeAnswers.length - 1)](state);
    }
    return tokenAnswers[Math.min(calls.token++, tokenAnswers.length - 1)]();
  };
  return { calls, assigned };
}
const busy = seconds => () => ({ ok: false, status: 429, url: '', headers: new Headers(seconds ? { 'retry-after': String(seconds) } : {}), body: { cancel: async () => {} } });
const signedIn = state => ({ ok: true, status: 200, url: '', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ redirect: true, url: `${ORIGIN}${flow.callback}?code=c&state=${state}` }), body: { cancel: async () => {} } });
const given = () => ({ ok: true, status: 200, json: async () => ({ access_token: 'pass-after-wait', expires_in: 3600 }) });

test('a 429 on the token call is asked again after its short wait, and the pass comes', async () => {
  const seen = patientPage([signedIn], [busy(1), busy(0), given]);
  const { pass } = await load();
  assert.equal(await pass(), 'pass-after-wait');
  assert.equal(seen.calls.token, 3);
  assert.deepEqual(seen.assigned, []);
});

test('a 429 on the authorize call is asked again too', async () => {
  const seen = patientPage([busy(2), signedIn], [given]);
  const { pass } = await load();
  assert.equal(await pass(), 'pass-after-wait');
  assert.equal(seen.calls.authorize, 2);
});

test('a token call still busy after busy_tries says busy with its wait, never "refused"', async () => {
  const seen = patientPage([signedIn], [busy(3)]);
  const { pass } = await load();
  await assert.rejects(pass(), error => error.name === 'PassBusy' && error.retry_after_s === 3);
  assert.equal(seen.calls.token, flow.busy_tries);
});

test('a wait longer than busy_wait_max_s is not waited out here', async () => {
  const seen = patientPage([busy(flow.busy_wait_max_s + 1)], [given]);
  const { pass } = await load();
  await assert.rejects(pass(), error => error.name === 'PassBusy');
  assert.equal(seen.calls.authorize, 1);
});
