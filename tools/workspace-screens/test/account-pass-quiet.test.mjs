// tools/workspace-screens/test/account-pass-quiet.test.mjs
//
// The page gets its pass with no redirect when the authorize address ends at its own callback with the state it sent: the
// code is exchanged in place and the page never leaves. When it ends anywhere else (the sign-in page, a confirm page, a
// callback with another state), the page goes to sign in as before, keeping its verifier and state for the callback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/account-pass.ts', import.meta.url), 'utf8');
const flow = JSON.parse(await readFile(new URL('../web/src/workspace/account-pass.json', import.meta.url), 'utf8'));
const { code } = await transform(source.replace(/^import flow from .*$/m, `const flow = ${JSON.stringify(flow)};`), { loader: 'ts', format: 'esm' });
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString('base64')}`);

const ORIGIN = 'https://door.example.test';
function page({ landAt }) {
  const kept = new Map(), assigned = [], asked = [];
  globalThis.location = { origin: ORIGIN, pathname: '/workspace', search: '', assign: url => assigned.push(url) };
  globalThis.sessionStorage = { setItem: (k, v) => kept.set(k, v), getItem: k => kept.get(k) ?? null, removeItem: k => kept.delete(k) };
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), init });
    if (String(url).startsWith(`${ORIGIN}${flow.authorize}`)) {
      const state = new URL(url).searchParams.get('state');
      return { ok: true, url: landAt(state), headers: new Headers(), body: { cancel: async () => {} } };
    }
    return { ok: true, json: async () => ({ access_token: 'pass-1', refresh_token: 'renew-1', expires_in: 3600 }) };
  };
  return { kept, assigned, asked };
}

test('a person signed in at the sign-in tool gets the pass with no redirect', async () => {
  const seen = page({ landAt: state => `${ORIGIN}${flow.callback}?code=c-1&state=${state}` });
  const { pass } = await load();
  const late = new Promise((_, refuse) => setTimeout(() => refuse(new Error('no pass: the page went to sign in')), 2000).unref());
  assert.equal(await Promise.race([pass(), late]), 'pass-1');
  assert.deepEqual(seen.assigned, [], 'the page never left');
  const exchanged = seen.asked.find(a => a.url === flow.token);
  assert.match(String(exchanged.init.body), /grant_type=authorization_code/);
  assert.match(String(exchanged.init.body), /code=c-1/);
  assert.equal(seen.kept.size, 0, 'nothing waits in sessionStorage');
});

for (const [why, landAt] of [
  ['the sign-in page', () => `${ORIGIN}/sign-in?next=x`],
  ['a confirm page', () => `${ORIGIN}/consent?x=1`],
  ['a callback with another state', () => `${ORIGIN}${flow.callback}?code=c-2&state=not-this-one`],
]) {
  test(`authorize ending at ${why} sends the page to sign in, keeping its verifier and state`, async () => {
    const seen = page({ landAt });
    const { pass } = await load();
    const pending = pass();
    await new Promise(done => setTimeout(done, 20));
    assert.equal(seen.assigned.length, 1);
    assert.ok(seen.assigned[0].startsWith(`${ORIGIN}${flow.authorize}?`));
    const kept = JSON.parse(seen.kept.get(flow.kept));
    assert.equal(kept.state, new URL(seen.assigned[0]).searchParams.get('state'));
    assert.equal(kept.back, '/workspace');
    assert.ok(!seen.asked.some(a => a.url === flow.token), 'no code is exchanged');
    void pending;
  });
}
