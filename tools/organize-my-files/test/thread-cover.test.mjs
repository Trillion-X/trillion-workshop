// test/thread-cover.test.mjs
//
// The opening cover (parts/ui/show/thread-cover) is in a page's first bytes and stands alone there:
//   - a workspace page opens under it, before its script file, and a page without `opening_cover` carries none;
//   - its inline script reads nothing from outside itself (it runs with nothing else on the page);
//   - a host app that draws the cover itself gets no second cover, and the page's lift tells the host;
//   - the files made for the iPhone app are the cover's own bytes (scripts/make-opening-cover.mjs; the app's copy is checked with the app's source).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageShellHtml } from '../parts/ui/show/server-rendered-page/page-sections-html.mjs';
import { coverNeedleSvg, threadCoverHtml, threadCoverPage } from '../parts/ui/show/thread-cover/thread-cover.mjs';
import setup from '../parts/ui/show/thread-cover/thread-cover.json' with { type: 'json' };
import { coverLook, openingCoverFiles } from '../../draw-trillions-app-icon-in-every-size-from/scripts/make-opening-cover.mjs';

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

test('the files for the iPhone app are made from the cover itself, byte for byte', () => {
  // The app's own copy of these files lives with the app's source (the iOS project is not in this repository), where
  // the same generator is run and compared; here the generator is held to what the cover owner produces.
  const files = Object.fromEntries(Object.entries(openingCoverFiles()).map(([path, bytes]) => [path.slice(path.indexOf('ios/')), bytes]));
  assert.deepEqual(Object.keys(files).sort(), [
    'ios/App/Assets.xcassets/CoverNeedle.imageset/Contents.json',
    'ios/App/Assets.xcassets/CoverNeedle.imageset/cover-needle.svg',
    'ios/App/Assets.xcassets/CoverPaper.colorset/Contents.json',
    'ios/App/thread-cover.html',
  ]);
  assert.equal(files['ios/App/Assets.xcassets/CoverNeedle.imageset/cover-needle.svg'], coverNeedleSvg());
  assert.equal(files['ios/App/thread-cover.html'], threadCoverPage(undefined, coverLook()));
  const paper = JSON.parse(files['ios/App/Assets.xcassets/CoverPaper.colorset/Contents.json']).colors[0].color.components;
  const hex = setup.look.paper.slice(1).toUpperCase();
  assert.deepEqual([paper.red, paper.green, paper.blue], [0, 2, 4].map(at => `0x${hex.slice(at, at + 2)}`));
});
