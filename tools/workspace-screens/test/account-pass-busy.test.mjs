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
