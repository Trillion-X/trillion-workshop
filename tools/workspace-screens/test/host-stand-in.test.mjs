// tools/workspace-screens/test/host-stand-in.test.mjs
//
// Inside a host (the Mac menu bar panel) the page's reach (alone-page.json host_reach) stands from the page's first line, so the panel never takes
// a page still opening for one that never started; what the host calls meanwhile reaches the page once it is ready, in
// order; a page with no host gets nothing; a page that fails to open takes the stand-in away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../web/src/workspace/host-channel.ts', import.meta.url), 'utf8');
const settings = JSON.parse(await readFile(new URL('../web/src/alone-page.json', import.meta.url), 'utf8'));
const { code } = await transform(source.replace(/^import settings from .*$/m, `const settings = ${JSON.stringify(settings)};`), { loader: 'ts', format: 'esm' });
const load = () => import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${Math.random()}`).toString('base64')}`);
const inHost = () => { globalThis.window = { webkit: { messageHandlers: { [settings.host_channel]: { postMessage() {} } } } }; };

test('inside a host the page answers at once, and calls made before it is ready reach it in order', async () => {
  inHost();
  const { standForHost, answerHost } = await load();
  standForHost();
  assert.equal(Boolean(window[settings.host_reach]), true, 'what the panel probes is there from the first line');
  window[settings.host_reach].panelSettings({ rows: [1] });
  window[settings.host_reach].host({ kind: 'notice_tapped', id: 'n1' });
  const heard = [];
  answerHost({ panelSettings: answer => heard.push(['panelSettings', answer]), host: message => heard.push(['host', message]), back: () => true });
  assert.deepEqual(heard, [['panelSettings', { rows: [1] }], ['host', { kind: 'notice_tapped', id: 'n1' }]]);
  assert.equal(window[settings.host_reach].back(), true, 'then the page itself answers');
  assert.equal(heard.length, 2, 'nothing is handed over twice');
});

test('a page with no host has no reach on window (open-in-mac-app.ts reads its presence as being inside the Mac app)', async () => {
  globalThis.window = {};
  const { standForHost } = await load();
  standForHost();
  assert.equal(settings.host_reach in window, false);
});

test('a page that fails to open takes the stand-in away, so the host loads it again; the page\'s own reach is never replaced', async () => {
  inHost();
  const { standForHost, leaveHost, answerHost } = await load();
  standForHost();
  window[settings.host_reach].back();
  leaveHost();
  assert.equal(settings.host_reach in window, false);
  const own = { back: () => 'own' };
  answerHost(own);
  standForHost();
  assert.equal(window[settings.host_reach], own, 'a second stand call keeps the ready page');
});
