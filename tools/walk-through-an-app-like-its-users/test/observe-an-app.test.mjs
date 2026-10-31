// The observe job on pages made up here (data: addresses, no server): a control a veil covers is reported as covered,
// a step that cannot complete is reported and the run goes on, and every kind of reading answers what the page holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findBrowser } from '../do-work/browser.mjs';

const script = fileURLToPath(new URL('../do-work/walk-through-an-app.mjs', import.meta.url));
const conventions = JSON.parse(readFileSync(new URL('../do-work/walk-conventions.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
let skip = false;
try { findBrowser(conventions.browser); } catch { skip = 'no Chromium-family browser on this computer'; }

const run = request => new Promise((done, failed) => {
  const child = spawn(process.execPath, [script, 'observe'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', failed);
  child.on('close', code => {
    try { done({ code, answer: JSON.parse(out.trim().split('\n').at(-1)) }); } catch { failed(new Error(`No JSON line (exit ${code}): ${out}`)); }
  });
  child.stdin.end(JSON.stringify(request));
});

const page = body => `data:text/html,${encodeURIComponent(`<!doctype html><title>Bakery</title>${body}`)}`;
const bakery = page(`
  <h1>Today's bread</h1>
  <button id="order">Order</button>
  <button id="pay">Pay</button>
  <div aria-label="veil" style="position:fixed;left:0;top:0;width:100vw;height:100vh;opacity:0.01;z-index:50"></div>
`);
const shop = page(`
  <p id="status">Closed</p>
  <button id="open" style="cursor:pointer" onclick="document.getElementById('status').textContent='Open for orders'; window.shop = { ready: true }">Open</button>
  <select id="loaf"><option value="rye">Rye</option><option value="spelt" selected>Spelt</option></select>
  <ul><li class="item" data-sku="a1">Seeded</li><li class="item" data-sku="b2">Plain</li></ul>
  <script>console.error('the till printer is offline')</script>
`);

test('a control a veil covers is reported as covered, with what a pointer would land on', { skip }, async () => {
  const { code, answer } = await run({ app_url: bakery, steps: [{ id: 'look', observe: { buttons: { read: 'elements', selector: 'button' } } }] });
  assert.equal(code, 0);
  const [order, pay] = answer.result.steps[0].observed.buttons;
  assert.equal(order.label, 'Order');
  assert.equal(order.pointer_is_self, false);
  assert.equal(order.pointer_would_hit, 'div[veil]');
  assert.equal(pay.pointer_is_self, false);
  assert.equal(answer.result.kind, 'app-observation');
});

test('an uncovered control is its own pointer target', { skip }, async () => {
  const { answer } = await run({ app_url: shop, steps: [{ id: 'look', observe: { open: { read: 'elements', selector: '#open' } } }] });
  const [open] = answer.result.steps[0].observed.open;
  assert.equal(open.pointer_is_self, true);
  assert.equal(open.cursor, 'pointer');
  assert.equal(open.disabled, false);
});

test('a step that cannot complete is reported, later steps and their readings still run', { skip }, async () => {
  const { code, answer } = await run({
    app_url: shop,
    steps: [
      { id: 'press missing', do: { action: 'click', target: { role: 'button', name: 'Missing' } }, observe: { count: { read: 'count', selector: 'li.item' } } },
      { id: 'open the till', do: { action: 'click', target: { role: 'button', name: 'Open' } }, observe: { status: { read: 'text', selector: '#status' } } },
    ],
  });
  assert.equal(code, 0);
  const [blocked, opened] = answer.result.steps;
  assert.equal(blocked.completed, false);
  assert.match(blocked.blocked_by, /Missing/);
  assert.equal(blocked.observed.count, 2);
  assert.equal(opened.completed, true);
  assert.equal(opened.observed.status, 'Open for orders');
});

test('each kind of reading answers what the page holds', { skip }, async () => {
  const { answer } = await run({
    app_url: shop,
    steps: [
      { id: 'open', do: { action: 'click', target: { role: 'button', name: 'Open' } } },
      {
        id: 'read',
        observe: {
          loaf: { read: 'attributes', selector: '#loaf', names: ['id'] },
          items: { read: 'attributes', selector: 'li.item', names: ['data-sku'] },
          ready: { read: 'global_path', path: 'shop.ready' },
          missing: { read: 'global_path', path: 'shop.nowhere.deeper' },
          none: { read: 'text', selector: '.nothing' },
          video: { read: 'media_ready', selector: 'video' },
        },
      },
    ],
  });
  const seen = answer.result.steps[1].observed;
  assert.equal(seen.loaf[0].value, 'spelt');
  assert.deepEqual(seen.items.map(item => item['data-sku']), ['a1', 'b2']);
  assert.deepEqual(seen.ready, { found: true, walked: ['shop', 'ready'], type: 'boolean' });
  assert.equal(seen.missing.found, false);
  assert.equal(seen.missing.missing, 'deeper');
  assert.equal(seen.none, null);
  assert.deepEqual(seen.video, { found: false });
});

test('errors the page printed come back on the readback, and a picture is kept when asked', { skip }, async () => {
  const { answer } = await run({ app_url: shop, steps: [{ id: 'look', picture: true }] });
  assert.deepEqual(answer.result.page_errors, ['the till printer is offline']);
  assert.match(answer.result.steps[0].screenshot, /01-look\.png$/);
});

test('a request that names no reading, an unknown reading or a repeated step is refused with what to change', async () => {
  const unknown = await run({ app_url: 'data:text/html,<p>x</p>', steps: [{ id: 'a', observe: { x: { read: 'divine', selector: 'p' } } }] });
  assert.equal(unknown.code, 2);
  assert.match(unknown.answer.error, /"divine", which is not one of: elements, count/);
  const noSelector = await run({ app_url: 'data:text/html,<p>x</p>', steps: [{ id: 'a', observe: { x: { read: 'count' } } }] });
  assert.match(noSelector.answer.error, /needs a selector/);
  const repeated = await run({ app_url: 'data:text/html,<p>x</p>', steps: [{ id: 'a' }, { id: 'a' }] });
  assert.match(repeated.answer.error, /share an id/);
  const none = await run({ app_url: 'data:text/html,<p>x</p>', steps: [] });
  assert.match(none.answer.error, /at least one step/);
});

test('the source offers no way to intercept, stub or route the page', () => {
  const source = readFileSync(new URL('../do-work/observe.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['Fetch.', 'setRequestInterception', 'setBlockedURLs', 'emulateNetworkConditions']) assert.equal(source.includes(forbidden), false, forbidden);
});

test('the observe row runs the observe job with the same files as the walk', () => {
  const row = rows.find(item => item.id === 'tool:read-what-a-running-app-shows');
  assert.ok(row);
  assert.deepEqual(row.invoke.argv.slice(-1), ['observe']);
  assert.equal(row.invoke.files.package_files.paths[0], 'do-work');
});
