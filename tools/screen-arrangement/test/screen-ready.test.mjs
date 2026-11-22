// tools/screen-arrangement/test/screen-ready.test.mjs
//
// The pane's one ready mark: `data-screen-ready` and `data-pane-state` are set on a pane that draws content, words or
// a failure, and never while it only loads or when only its tab bar has words. Runs the real screen-ready.ts in Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const source = await readFile(new URL('../show/screen-ready.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const bundle = `window.__ready = (() => { ${code.replace(/^export /gm, '')}; return { paneReadyState, watchScreenReady }; })();`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<!doctype html><body></body>');
await page.addScriptTag({ content: bundle });

const stateOf = html => page.evaluate(markup => {
  const pane = document.createElement('div');
  pane.setAttribute('data-container-id', 'p');
  pane.innerHTML = markup;
  document.body.replaceChildren(pane);
  return window.__ready.paneReadyState(pane);
}, html);

const PANEL = '<div data-screen-arrangement-tab-panel="" data-active="true">';

test('a panel with its own words is content', async () => {
  assert.equal(await stateOf(`${PANEL}<p>Calendar for today</p></div>`), 'content');
});

test('a words-state (empty or unavailable) is words', async () => {
  assert.equal(await stateOf(`${PANEL}<div data-screen-state="empty">Nothing is here yet.</div></div>`), 'words');
  assert.equal(await stateOf(`${PANEL}<div data-screen-state="unavailable">Not available.</div></div>`), 'words');
});

test('a failed state anywhere in the pane is a failure, whichever screen it came from', async () => {
  assert.equal(await stateOf(`<div data-screen-state="failed">Could not open.</div>${PANEL}<p>x</p></div>`), 'failure');
});

test('a pane that only loads, or whose tab bar alone has words, is not ready', async () => {
  assert.equal(await stateOf(`${PANEL}<div data-screen-state="loading"><span>Opening</span></div></div>`), null);
  assert.equal(await stateOf(`<div>Home Record Files</div>${PANEL}</div>`), null);
});

test('the marks follow what is drawn, and go when the content goes', async () => {
  const seen = await page.evaluate(async () => {
    const pane = document.createElement('div');
    pane.setAttribute('data-container-id', 'p');
    pane.innerHTML = '<div data-screen-arrangement-tab-panel="" data-active="true"><div data-screen-state="loading">Opening</div></div>';
    document.body.replaceChildren(pane);
    const stop = window.__ready.watchScreenReady(pane);
    const frame = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    await frame();
    const loading = [pane.getAttribute('data-screen-ready'), pane.getAttribute('data-pane-state')];
    pane.querySelector('[data-screen-state]').replaceWith(Object.assign(document.createElement('p'), { textContent: 'Your list' }));
    await frame();
    const drawn = [pane.getAttribute('data-screen-ready'), pane.getAttribute('data-pane-state')];
    pane.querySelector('p').textContent = '';
    await frame();
    const cleared = [pane.getAttribute('data-screen-ready'), pane.getAttribute('data-pane-state')];
    stop();
    return { loading, drawn, cleared };
  });
  assert.deepEqual(seen.loading, [null, null]);
  assert.deepEqual(seen.drawn, ['', 'content']);
  assert.deepEqual(seen.cleared, [null, null]);
});

test('text inside a hidden slot is not content', async () => {
  assert.equal(await stateOf(`${PANEL}<div hidden><p>Shown in another slot</p></div></div>`), null);
});

test('text with no drawn size is not content', async () => {
  assert.equal(await stateOf(`${PANEL}<p style="font-size:0">Zero size</p></div>`), null);
});

test('a named control drawn with a size is content, even with no words', async () => {
  assert.equal(await stateOf(`${PANEL}<button aria-label="Open the funnel" style="width:40px;height:40px"></button></div>`), 'content');
});

test('an unnamed control is not content', async () => {
  assert.equal(await stateOf(`${PANEL}<button style="width:40px;height:40px"></button></div>`), null);
});

test('a loaded image is content; an image still loading is not', async () => {
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const decoded = await page.evaluate(async src => {
    const pane = document.createElement('div');
    pane.setAttribute('data-container-id', 'p');
    pane.innerHTML = `<div data-screen-arrangement-tab-panel="" data-active="true"><img alt="" style="width:40px;height:40px" src="${src}"></div>`;
    document.body.replaceChildren(pane);
    const img = pane.querySelector('img');
    await img.decode();
    return window.__ready.paneReadyState(pane);
  }, gif);
  assert.equal(decoded, 'content');
  const pending = await page.evaluate(() => {
    const pane = document.createElement('div');
    pane.setAttribute('data-container-id', 'p');
    pane.innerHTML = '<div data-screen-arrangement-tab-panel="" data-active="true"><img alt="" style="width:40px;height:40px" src="data:image/gif;base64,"></div>';
    document.body.replaceChildren(pane);
    return window.__ready.paneReadyState(pane);
  });
  assert.equal(pending, null);
});

test('a failure or words marker that is hidden does not count', async () => {
  assert.equal(await stateOf(`<div data-screen-state="failed" hidden>Could not open.</div>${PANEL}<p>Your list</p></div>`), 'content');
  assert.equal(await stateOf(`<div data-screen-state="empty" hidden>Nothing here.</div>${PANEL}</div>`), null);
});

test.after(() => browser.close());
