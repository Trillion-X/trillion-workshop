// tools/workspace-screens/test/account-pass-json.test.mjs
//
// The sign-in server answers a person already signed in with 200 JSON `{ redirect: true, url }`, the url being this page's
// callback with the code. The page takes that code in place when the url is its own callback, carries the state it sent,
// and an issuer (when named) of its own origin; anything else sends the page to sign in, and no code is exchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/account-pass.ts', import.meta.url), 'utf8');
const flow = JSON.parse(await readFile(new URL('../web/src/workspace/account-pass.json', import.meta.url), 'utf8'));
const { code } = await transform(source.replace(/^import flow from .*$/m, `const flow = ${JSON.stringify(flow)};`), { loader: 'ts', format: 'esm' });
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString('base64')}`);

const ORIGIN = 'https://door.example.test';
function page(answerFor) {
  const assigned = [], exchanged = [];
  globalThis.location = { origin: ORIGIN, pathname: '/workspace', search: '', assign: url => assigned.push(url) };
  globalThis.sessionStorage = { setItem() {}, getItem: () => null, removeItem() {} };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(`${ORIGIN}${flow.authorize}`)) {
      const state = new URL(url).searchParams.get('state');
      const answer = answerFor(state);
      return { ok: true, status: 200, url, headers: new Headers({ 'content-type': 'application/json' }), json: async () => answer, body: { cancel: async () => {} } };
    }
    if (String(url) === flow.token) exchanged.push(String(init.body));
    return { ok: true, json: async () => ({ access_token: 'pass-json', expires_in: 3600 }) };
  };
  return { assigned, exchanged };
}
const callback = (state, extra = '') => `${ORIGIN}${flow.callback}?code=c-json&state=${state}&iss=${encodeURIComponent(ORIGIN)}${extra}`;

test('a signed-in person gets the pass from the JSON redirect, with no navigation', async () => {
  const seen = page(state => ({ redirect: true, url: callback(state) }));
  const { pass } = await load();
  assert.equal(await pass(), 'pass-json');
  assert.deepEqual(seen.assigned, [], 'the page never left');
  assert.equal(seen.exchanged.length, 1, 'one token call');
  assert.match(seen.exchanged[0], /code=c-json/);
});

test('a JSON redirect with another state is refused: the page signs in, and no code is exchanged', async () => {
  const seen = page(() => ({ redirect: true, url: callback('not-this-state') }));
  const { pass } = await load();
  void pass();
  await new Promise(done => setTimeout(done, 20));
  assert.equal(seen.assigned.length, 1);
  assert.ok(seen.assigned[0].startsWith(`${ORIGIN}${flow.authorize}?`));
  assert.equal(seen.exchanged.length, 0);
});

test('a JSON redirect to another callback path is refused', async () => {
  const seen = page(state => ({ redirect: true, url: `${ORIGIN}/sign-in/done?code=c-json&state=${state}` }));
  const { pass } = await load();
  void pass();
  await new Promise(done => setTimeout(done, 20));
  assert.equal(seen.assigned.length, 1);
  assert.equal(seen.exchanged.length, 0);
});

test('a JSON redirect whose issuer is another origin is refused', async () => {
  const seen = page(state => ({ redirect: true, url: `${ORIGIN}${flow.callback}?code=c-json&state=${state}&iss=${encodeURIComponent('https://elsewhere.example.test')}` }));
  const { pass } = await load();
  void pass();
  await new Promise(done => setTimeout(done, 20));
  assert.equal(seen.assigned.length, 1);
  assert.equal(seen.exchanged.length, 0);
});

test('a JSON answer that is not a redirect sends the page to sign in', async () => {
  const seen = page(() => ({ redirect: false, url: '/sign-in' }));
  const { pass } = await load();
  void pass();
  await new Promise(done => setTimeout(done, 20));
  assert.equal(seen.assigned.length, 1);
  assert.equal(seen.exchanged.length, 0);
});
