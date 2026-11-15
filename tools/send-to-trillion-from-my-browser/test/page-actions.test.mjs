// test/page-actions.test.mjs
//
// Acting on a page from the person's own browser (extension/src/page-actions.mjs, run by extension/src/browser-runs.mjs actOnPage as
// tool:act-in-my-browser: F-0560). The engine runs in a REAL Chromium page on a fixture; the run goes through the same functions the
// extension uses, with the browser's window and message calls standing in only for the extension APIs.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchChromium } from 'trillion-workshop/tools/headless-browser/test/workshop-browser-for-tests.mjs';
import { actOnPage as runActions } from '../src/browser-runs.mjs';
import settings from '../browser-runs.json' with { type: 'json' };

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/page-actions.mjs', import.meta.url))], bundle: true, format: 'iife', globalName: 'PageActions', write: false, platform: 'browser', loader: { '.json': 'json' } })).outputFiles[0].text;

const FIXTURE = `<!doctype html><html><body>
  <h1>Order form</h1>
  <label>Name <input id="name" placeholder="Your name"></label>
  <input type="password" aria-label="Password" value="fixture-secret">
  <input type="password" value="unlabelled-secret">
  <select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
  <button id="a">Confirm Order</button>
  <button id="b">Cancel</button>
  <button type="button" value="Button value"></button>
  <a href="#x">Details</a><a href="#y">Details</a>
  <div id="editor" contenteditable="true" aria-label="Notes"></div>
  <button style="display:none">Hidden Confirm</button>
  <p id="status">waiting</p>
  <script>
    document.getElementById('a').addEventListener('click', () => { document.getElementById('status').textContent = 'confirmed ' + document.getElementById('name').value; });
    document.getElementById('name').addEventListener('input', event => { window.lastInput = event.target.value; });
    document.querySelector('select').addEventListener('change', event => { window.picked = event.target.value; });
    document.addEventListener('keydown', event => { window.lastKey = event.key; });
    window.__html = document.body.innerHTML;
  </script></body></html>`;

let browser;
let page;
const run = (message) => page.evaluate(m => window.PageActions.actOnPage(m, { document, window }), message);

test('setup', async () => {
  browser = await launchChromium({ headless: true });
  page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.addScriptTag({ content: bundle });
});

test('a step finds its target by what the page shows, writes through the control, and the page\'s own handlers see a real change', async () => {
  const done = await run({ steps: [
    { do: 'type', target: { match: { label: 'Your name' } }, text: 'Ada' },
    { do: 'select', target: 'Size', text: 'Large' },
    { do: 'click', target: { match: { text: { equals: 'Confirm Order' } } } },
    { do: 'press', key: 'Escape' },
  ] });
  assert.deepEqual(done.results.map(row => row.ok), [true, true, true, true]);
  assert.equal(await page.textContent('#status'), 'confirmed Ada');
  assert.deepEqual(await page.evaluate(() => [window.lastInput, window.picked, window.lastKey]), ['Ada', 'l', 'Escape']);
  assert.equal(done.said, '4 steps done.');
});

test('text is written as text, never markup; editable areas and appending work', async () => {
  await run({ steps: [{ do: 'type', target: 'Notes', text: '<b>bold</b>' }, { do: 'append', target: 'Notes', text: ' and more' }] });
  assert.equal(await page.evaluate(() => document.getElementById('editor').textContent), '<b>bold</b> and more');
  assert.equal(await page.evaluate(() => document.getElementById('editor').children.length), 0);
});

test('a rehearsal locates every target and acts on none; a missing or ambiguous target stops the run before anything is done', async () => {
  await page.evaluate(() => { document.getElementById('status').textContent = 'waiting'; });
  const dry = await run({ dry_run: true, steps: [{ do: 'click', target: 'Cancel' }] });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.said, 'Rehearsal: 1 steps located, none done.');
  const missing = await run({ steps: [{ do: 'click', target: 'Cancel' }, { do: 'click', target: 'Does not exist' }] });
  assert.equal(missing.results.at(-1).ok, false);
  assert.match(missing.said, /Nothing on the page matched/);
  const ambiguous = await run({ steps: [{ do: 'click', target: 'Details' }] });
  assert.match(ambiguous.said, /2 elements matched "Details"; say which with nth \(0 to 1\)/);
  const picked = await run({ steps: [{ do: 'click', target: 'Details', nth: 1 }] });
  assert.equal(picked.results[0].ok, true);
  assert.match((await run({ steps: [{ do: 'click', target: 'Details', nth: 7 }] })).said, /nth must be a whole number from 0 to 1/);
  assert.equal(await page.textContent('#status'), 'waiting', 'nothing but the nth click ran');
  assert.match((await run({ steps: [{ do: 'click', target: 'Hidden Confirm' }] })).said, /Nothing on the page matched/, 'a hidden element is not a target');
  assert.match((await run({ steps: [{ do: 'fly', target: 'x' }] })).said, /no action named fly/);
  assert.match((await run({ steps: [{ do: 'type', target: 'Notes' }] })).said, /needs text/);
});

test('snapshots withhold configured sensitive input values but retain their visible labels and allowed button values', async () => {
  const snapshot = await run({ steps: [{ do: 'snapshot' }] });
  const elements = snapshot.results[0].elements;
  const labelledPassword = elements.find(row => row.label === 'Password');
  assert.ok(labelledPassword, 'the visible password control label remains available');
  assert.ok(elements.some(row => row.label === 'Button value'), 'an allowed button value remains available');
  assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('unlabelled-secret'), false);
  const matched = await run({ steps: [{ do: 'focus', target: 'Password' }] });
  assert.equal(matched.results[0].matched, 'Password');
});

test('nothing is refused by default, and a refused input type is a flippable row', async () => {
  const open = await run({ steps: [{ do: 'type', target: 'Password', text: 'x' }] });
  assert.equal(open.results[0].ok, true);
  // The same engine built with the row switched on: the row, not code, decides.
  const strict = JSON.parse(readFileSync(new URL('../page-actions.json', import.meta.url), 'utf8'));
  strict.refuse_types = ['password'];
  const closedBundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/page-actions.mjs', import.meta.url))], bundle: true, format: 'iife', globalName: 'StrictActions', write: false, platform: 'browser',
    plugins: [{ name: 'strict', setup(b) { b.onLoad({ filter: /page-actions\.json$/ }, () => ({ contents: JSON.stringify(strict), loader: 'json' })); } }] })).outputFiles[0].text;
  await page.addScriptTag({ content: closedBundle });
  const closed = await page.evaluate(() => window.StrictActions.actOnPage({ steps: [{ do: 'type', target: 'Password', text: 'x' }] }, { document, window }));
  assert.equal(closed.results[0].ok, false);
  assert.match(closed.said, /Writing into a password field is turned off/);
});

test('the extension\'s own run opens the page in a window, validates, acts, reads the page again and closes the window', async () => {
  const sent = [];
  const removed = [];
  const fake = {
    windows: { create: async options => { assert.equal(options.focused, false); return { id: 9, tabs: [{ id: 90 }] }; }, remove: async id => { removed.push(id); } },
    tabs: { get: async () => ({ status: 'complete' }), sendMessage: async (tabId, message) => {
      sent.push(Object.keys(message)[0]);
      if (message.act_on_page) return run(message.act_on_page);
      return { url: 'https://example.test/', title: 'T', text: await page.innerText('body'), links: [] };
    } },
  };
  await page.evaluate(() => { document.getElementById('status').textContent = 'waiting'; });
  const answer = await runActions({ url: 'https://example.test/', steps: [{ do: 'type', target: { match: { label: 'Your name' } }, text: 'Grace' }, { do: 'click', target: 'Confirm Order' }] },
    { browser: fake, read: { ...settings.read_page, settle_ms: 0 }, act: { ...settings.act, settle_ms: 0 } });
  assert.deepEqual(sent, ['act_on_page', 'read_page']);
  assert.match(answer.after.text, /confirmed Grace/);
  assert.deepEqual(removed, [9]);
  await assert.rejects(runActions({ url: 'https://example.test/', steps: [] }, { browser: fake }), /Send the steps to do/);
  await assert.rejects(runActions({ url: 'file:///etc/hosts', steps: [{ do: 'click', target: 'x' }] }, { browser: fake }), /Send the page's address/);
  assert.equal(settings.tools['tool:act-in-my-browser'], 'actOnPage');
});

test('teardown', async () => { await browser?.close(); });
