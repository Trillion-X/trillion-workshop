// test/browser-session.test.mjs
//
// F-0640: a browser session an AI drives across calls (extension/src/browser-session.mjs, DATA extension/browser-session.json) over
// the page engine (extension/src/page-actions.mjs). Each tab is a REAL Chromium page; only the extension's windows/tabs APIs are
// stood in for. Covers tabs, navigation, click by ref from a snapshot, drag, fill, press, scroll, the person's lock, host limits and
// the data-class rule, and that a run reaches the session through the browser-runs tool table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchChromium } from 'trillion-workshop/tools/headless-browser/test/workshop-browser-for-tests.mjs';
import { makeBrowserSessions } from '../src/browser-session.mjs';
import settings from '../browser-session.json' with { type: 'json' };
import runs from '../browser-runs.json' with { type: 'json' };

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/page-actions.mjs', import.meta.url))], bundle: true, format: 'iife', globalName: 'PageActions', write: false, platform: 'browser', loader: { '.json': 'json' } })).outputFiles[0].text;
const page = (name) => `<!doctype html><title>${name}</title><body>
  <input aria-label="Name"><button id="go">Go</button><button id="stop">Stop</button>
  <div id="src" draggable="true" aria-label="Card">card</div><div id="dst" aria-label="Lane">lane</div>
  <p id="out">idle</p><div style="height:3000px"></div>
  <script>
    go.onclick = () => out.textContent = 'went ' + document.querySelector('input').value;
    dst.addEventListener('dragover', e => e.preventDefault());
    dst.addEventListener('drop', () => out.textContent = 'dropped');
    document.addEventListener('keydown', e => { window.key = e.key; });
  </script></body>`;

let chromium;
let ready = false;
const pages = new Map();
let nextId = 100;
const opened = [];
const removedWindows = [];
const browser = {
  windows: { create: async options => { assert.equal(options.focused, false); const tab = await makeTab(options.url); return { id: 7, tabs: [{ id: tab }] }; }, remove: async id => { removedWindows.push(id); } },
  tabs: {
    create: async options => ({ id: await makeTab(options.url) }),
    get: async id => ({ id, status: 'complete', url: pages.get(id).url(), title: await pages.get(id).title() }),
    update: async (id, options) => { await pages.get(id).goto(options.url); await attach(pages.get(id)); },
    remove: async id => { await pages.get(id).close(); pages.delete(id); },
    goBack: async id => { await pages.get(id).goBack(); await attach(pages.get(id)); },
    goForward: async id => { await pages.get(id).goForward(); await attach(pages.get(id)); },
    sendMessage: async (id, message) => {
      const p = pages.get(id);
      if (message.act_on_page) return p.evaluate(m => window.PageActions.actOnPage(m, { document, window }), message.act_on_page);
      return { url: p.url(), title: await p.title(), text: await p.innerText('body'), links: [] };
    },
  },
};
async function attach(p) { await p.addScriptTag({ content: bundle }); }
async function makeTab(url) {
  const p = await chromium.newPage();
  await p.route('**/*', route => route.fulfill({ contentType: 'text/html', body: page(new URL(route.request().url()).pathname) }));
  await p.goto(url);
  await attach(p);
  const id = nextId++;
  pages.set(id, p);
  opened.push(url);
  return id;
}
const sessions = (config = settings) => makeBrowserSessions({ browser, config, pause: async () => {} });

test('setup', async () => { chromium = await launchChromium({ headless: true }); ready = true; });

test('a session opens a window, lists only its tabs, navigates, goes back, and closes a tab', async () => {
  const s = sessions();
  const first = await s.call({ do: 'open', url: 'https://example.test/one' });
  assert.deepEqual([first.session, first.tab], ['s1', 't1']);
  const second = await s.call({ session: 's1', do: 'open', url: 'https://example.test/two' });
  assert.equal(second.tab, 't2');
  assert.deepEqual((await s.call({ session: 's1', do: 'tabs' })).tabs.map(row => row.title), ['/one', '/two']);
  await s.call({ session: 's1', do: 'navigate', tab: 't1', url: 'https://example.test/three' });
  assert.equal((await s.call({ session: 's1', do: 'tabs' })).tabs[0].title, '/three');
  await s.call({ session: 's1', do: 'back', tab: 't1' });
  assert.equal((await s.call({ session: 's1', do: 'tabs' })).tabs[0].title, '/one');
  assert.equal((await s.call({ session: 's1', do: 'close', tab: 't2' })).tabs.length, 1);
  await assert.rejects(s.call({ session: 's1', do: 'close', tab: 't9' }), /no tab t9/);
  await assert.rejects(s.call({ session: 's1', do: 'open', url: 'file:///etc/hosts' }), /Only pages at/);
  await assert.rejects(s.call({ session: 's9', do: 'tabs' }), /no session s9/);
  assert.equal((await s.call({ session: 's1', do: 'end' })).ended, true);
  assert.deepEqual(removedWindows.at(-1), 7);
});

test('snapshot hands out refs; a step clicks by ref, fills, presses, scrolls and drags on the real page; a stale ref is refused by name', async () => {
  const s = sessions();
  await s.call({ do: 'open', url: 'https://example.test/form' });
  const snap = await s.call({ session: 's1', do: 'act', tab: 't1', steps: [{ do: 'snapshot' }] });
  const elements = snap.results[0].elements;
  const ref = label => elements.find(row => row.label === label || row.text === label).ref;
  await s.call({ session: 's1', do: 'act', tab: 't1', steps: [
    { do: 'fill', target: { ref: ref('Name') }, text: 'Ada' },
    { do: 'click', target: { ref: ref('Go') } },
    { do: 'press', key: 'Escape' },
    { do: 'scroll', dy: 500 },
  ] });
  const p = pages.get(Math.max(...pages.keys()));
  assert.equal(await p.textContent('#out'), 'went Ada');
  assert.equal(await p.evaluate(() => [window.key, window.scrollY > 0]).then(r => r.join()), 'Escape,true');
  await s.call({ session: 's1', do: 'act', tab: 't1', steps: [{ do: 'drag', target: { ref: ref('Card') }, to: { ref: ref('Lane') } }] });
  assert.equal(await p.textContent('#out'), 'dropped');
  await p.evaluate(() => document.getElementById('go').remove());
  const gone = await s.call({ session: 's1', do: 'act', tab: 't1', steps: [{ do: 'click', target: { ref: ref('Go') } }] });
  assert.match(gone.said, /no longer on the page/);
  const bad = await s.call({ session: 's1', do: 'act', tab: 't1', steps: [{ do: 'click', target: { ref: 'e999' } }] });
  assert.match(bad.said, /No element has the ref e999/);
  await s.call({ session: 's1', do: 'end' });
});

test('the person\'s lock stops every acting verb in the host until release; reads and end still answer', async () => {
  const s = sessions();
  await s.call({ do: 'open', url: 'https://example.test/lock' });
  const id = 's1';
  await s.call({ session: id, do: 'lock' });
  for (const call of [{ do: 'act', tab: 't1', steps: [{ do: 'click', target: 'Go' }] }, { do: 'navigate', tab: 't1', url: 'https://example.test/x' }, { do: 'open', url: 'https://example.test/y' }]) {
    await assert.rejects(s.call({ session: id, ...call }), error => error.status === 423 && /taken over this browser/.test(error.message));
  }
  assert.match((await s.call({ session: id, do: 'read', tab: 't1' })).text, /idle/);
  assert.equal((await s.call({ session: id, do: 'tabs' })).locked, true);
  await s.call({ session: id, do: 'release' });
  assert.equal((await s.call({ session: id, do: 'act', tab: 't1', steps: [{ do: 'click', target: 'Go' }] })).results[0].ok, true);
  await s.call({ session: id, do: 'end' });
});

test('host limits and the data-class rule are DATA: open by default, and a listed class is refused in the host', async () => {
  assert.deepEqual(settings.limits.deny_classes, []);
  const strict = sessions({ ...settings, limits: { ...settings.limits, max_tabs: 1, max_sessions: 1, deny_classes: ['write'] } });
  const made = await strict.call({ do: 'open', url: 'https://example.test/limits' });
  await assert.rejects(strict.call({ session: made.session, do: 'open', url: 'https://example.test/two' }), /already has 1 tabs/);
  await assert.rejects(strict.call({ do: 'open', url: 'https://example.test/other' }), /already has 1 sessions/);
  await assert.rejects(strict.call({ session: made.session, do: 'act', tab: 't1', steps: [{ do: 'click', target: 'Go' }] }), error => error.status === 403 && /refuses write actions/.test(error.message));
  assert.match((await strict.call({ session: made.session, do: 'read', tab: 't1' })).text, /idle/, 'a read is a different class');
  await strict.call({ session: made.session, do: 'end' });
});

test('a run reaches the session through the browser tool table', async () => {
  assert.equal(runs.tools['tool:drive-my-browser'], 'driveMyBrowser');
  const { driveMyBrowser } = await import('../src/browser-session.mjs');
  assert.equal(typeof driveMyBrowser, 'function');
});

test('teardown', async () => { await chromium?.close(); });
