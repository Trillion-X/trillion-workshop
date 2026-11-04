// test/thread-cover.test.mjs
//
// The opening cover (parts/ui/show/thread-cover) is in a page's first bytes and stands alone there:
//   - a workspace page opens under it, before its script file, and a page without `opening_cover` carries none;
//   - its inline script reads nothing from outside itself (it runs with nothing else on the page);
//   - a host app that draws the cover itself gets no second cover, and the page's lift tells the host;
//   - the iPhone app's copy of the cover and of its needle are the current ones (scripts/make-opening-cover.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pageShellHtml } from '../parts/ui/show/server-rendered-page/page-sections-html.mjs';
import { threadCoverHtml } from '../parts/ui/show/thread-cover/thread-cover.mjs';
import setup from '../parts/ui/show/thread-cover/thread-cover.json' with { type: 'json' };
import { openingCoverFiles } from '../../draw-trillions-app-icon-in-every-size-from/scripts/make-opening-cover.mjs';

const scriptOf = html => html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

test('a workspace page opens under the cover, ahead of its script file; other pages carry none', () => {
  const island = { bundle_url: '/client.js', mount_element_id: 'root' };
  const covered = pageShellHtml({ title: 'Trillion', island, opening_cover: true });
  const cover = covered.indexOf('<trillion-cover>');
  assert.ok(cover > covered.indexOf('<body>'), 'the cover is in the body');
  assert.ok(cover < covered.indexOf('/client.js'), 'the cover comes before the page script');
  assert.equal(pageShellHtml({ title: 'Trillion', island }).includes('trillion-cover'), false);
});

test('the cover script stands alone and, under a host app, hands the lift to the host', async () => {
  const told = [];
  let removed = false;
  const window = { __trillionCoverHost: true, webkit: { messageHandlers: { trillionCover: { postMessage: words => told.push(words) } } } };
  const document = { querySelector: name => (name === 'trillion-cover' ? { remove: () => { removed = true; } } : null) };
  new Function('window', 'document', scriptOf(threadCoverHtml()))(window, document);
  assert.ok(removed, 'the page draws no cover of its own');
  let settled = false;
  const lifting = window.trillionCover.lift().then(() => { settled = true; });
  assert.deepEqual(told, ['ready']);
  await new Promise(done => setTimeout(done, 20));
  assert.equal(settled, false, 'the lift waits for the host\'s cover to finish dissolving');
  window.trillionCover.lifted();
  await lifting;
});

test('every quote has words and who said them, and the cover\'s colours are colours', () => {
  assert.ok(setup.quotes.length > 1);
  for (const quote of setup.quotes) assert.ok(quote.words.trim() && quote.by.trim());
  for (const name of ['paper', 'ink', 'thread', 'quiet']) assert.match(setup.look[name], /^#[0-9a-f]{6}$/i);
});

test('the iPhone app carries the current cover and needle', () => {
  for (const [path, bytes] of Object.entries(openingCoverFiles())) assert.equal(readFileSync(path, 'utf8'), bytes, `${path} is stale: run node scripts/make-opening-cover.mjs`);
});
