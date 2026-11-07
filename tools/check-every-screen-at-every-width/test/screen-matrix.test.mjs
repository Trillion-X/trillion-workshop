// Ported from old trillion test/screen-matrix.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The probes are this tool's check-screens.mjs (old parts/screen-matrix/check-screens.mjs),
// the browser tools/headless-browser/launch.mjs and the fixture font tools/screen-look/show/fonts; the fixture pages and
// every assertion of the eleven probe tests are the old ones.
// Not here: "the app screens file opens every screen that has an address, and the deploy runs the check before it
// uploads" and "the deploy reads only the marked main screens, inside a budget". Their screens file and screen list are
// trillion-apps web/scripts/screen-matrix-screens.json and web/src/workspace/screens.mjs, so the first belongs to that
// repository's lane; the deploy halves read scripts/deploy-worker.mjs and scripts/check-app-screens.mjs
// (screenMatrixCheck, screenMatrixScope), which no repository holds any more (searched the three repos for both names).
// The decided-red fixture's "Get started" is the strong button the comment below names, so it is a link control (as
// a page's Get started is), not a bare span the shared repeated_supporting_text rule rightly reads as a caption.
// test/screen-matrix.test.mjs
// parts/screen-matrix/check-screens.mjs refuses a deploy whose screens cannot be read. This plants one defect per
// probe in a fixture page served from a tiny local server (low contrast, a font that never loads, text clipped
// without an ellipsis, an element wider than a phone, a card whose text disappears when Dark Reader dresses it) and
// asserts each probe fails on its defect and only there, and that a clean page passes in every mode and width.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test, { after, before } from 'node:test';
import { launchChromium } from '../../headless-browser/launch.mjs';
import { readViews, runMatrix } from '../check-screens.mjs';

const fontFile = readFileSync(new URL('../../screen-look/show/fonts/SF-Pro-Text-Regular.woff2', import.meta.url));

// One page shell: a font that does load (the fixture's own family), the colours of a readable page, and `body`.
const page = (body, style = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>fixture</title>
<style>
@font-face { font-family: 'Fixture Text'; src: url(/fixture.woff2) format('woff2'); font-display: block; }
:root { --fixture-font: 'Fixture Text'; --fixture-missing: 'Fixture Never Loaded'; color-scheme: light dark; }
body { margin: 0; padding: 16px; font-family: var(--fixture-font); font-size: 16px; line-height: 1.4; background: Canvas; color: CanvasText; }
.card { padding: 12px; margin: 12px 0; border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
${style}
</style></head><body><main>${body}</main></body></html>`;

const clean = page(`<h1>Clean fixture</h1><p>Every line of this page can be read in every mode.</p>
<label for="search-control">Search</label><input id="search-control"><button aria-label="Open menu"><svg aria-hidden="true" width="24" height="24"></svg></button>
<label for="date-control">Choose a date</label><input id="date-control" type="date"><label for="color-control">Choose a color</label><input id="color-control" type="color"><div id="editable-control" contenteditable="true" aria-label="Notes"></div>
<span id="hidden-control-name" hidden>Archive draft</span><button role="button" aria-labelledby="hidden-control-name"><svg aria-hidden="true" width="24" height="24"></svg></button>
<div class="card"><p>A card with text on its own surface.</p></div>
<p class="ellipsis">A long line that is shortened with an ellipsis instead of being cut off without a trace</p>`,
`h1 { font-size: 28px; margin: 0 0 8px; } .ellipsis { width: 160px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }`);

const whiteSquare = "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='#fff'/></svg>";

const pages = {
  '/clean': clean,
  '/fading': page('<h1>Fading in</h1><p class="enter">This sentence is dark on white once it has faded in, and starts out invisible.</p><p class="spin">A spinner runs beside this line for ever.</p>',
    'body { background: #fff; color: #111; } .enter { animation: enter 1500ms ease-out both; } .spin { animation: pulse 1s ease-in-out infinite alternate; } @keyframes enter { from { opacity: 0; } to { opacity: 1; } } @keyframes pulse { from { opacity: 1; } to { opacity: 0.95; } }'),
  '/low-contrast': page('<h1>Low contrast</h1><p class="faint">This sentence is almost the colour of the page behind it.</p>',
    'body { background: #fff; color: #111; } .faint { color: #cfcfcf; }'),
  '/font': page('<h1>Fallback font</h1><p class="missing">This sentence asks for a family that is never loaded.</p>',
    '.missing { font-family: var(--fixture-missing), serif; }'),
  '/clipped': page('<h1>Clipped</h1><div class="box">A long sentence that does not fit its box and is cut off without an ellipsis.</div>',
    '.box { width: 120px; height: 24px; overflow: hidden; white-space: nowrap; }'),
  '/wide': page('<h1>Wide</h1><div class="wide">An element wider than a phone.</div>',
    '.wide { width: 600px; background: Canvas; color: CanvasText; border: 1px solid CanvasText; }'),
  // A light picture from another site (so Dark Reader may not read it) behind dark text. Dark Reader re-colours the text for
  // a dark page (light text) and the picture stays light, so the words disappear into it.
  '/card-vanishes': picture => page('<h1>Card</h1><div class="photo">Text over a picture the dark mode cannot read.</div>',
    `body { background: #fff; color: #111; } .photo { padding: 24px; color: #111; background: #fff url(${picture}/white.svg) repeat; }`),
};
pages['/unnamed-controls'] = page('<h1>Unnamed controls</h1><button class="empty-button"></button><input class="empty-input" type="text">');

// The person decided their strong button is the thread red #ff1d1d with white semibold words (views.json decided_colours):
// on it the words are judged at the 3:1 bold bar and anything still under is reported, never refused. Another red is not decided.
pages['/decided-red'] = page('<h1>Decided red</h1><p><a class="strong" href="#start">Get started</a></p><p class="plain">White body words on the decided red.</p>',
  'body { background: #fff; color: #111; } .strong, .plain { display: inline-block; padding: 8px 14px; background: #ff1d1d; color: #fff; } .strong { font-weight: 600; } .plain { font-weight: 400; }');
pages['/other-red'] = page('<h1>Another red</h1><p class="other">White words on a red nobody decided.</p>',
  'body { background: #fff; color: #111; } .other { display: inline-block; padding: 8px 14px; background: #e8483f; color: #fff; font-weight: 600; }');

// White words over a dark graphic drawn under them (a sibling SVG, as the doodle button's brush is), far below the fold:
// read before scrolling, the page behind the graphic is all the early read can see, so only the scrolled read judges it.
pages['/under-graphic'] = page('<h1>Under a graphic</h1><div style="height:2400px"></div><a class="blob"><svg viewBox="0 0 10 4" preserveAspectRatio="none"><rect width="10" height="4" fill="#1d3bff"/></svg><span>Words on the drawn blob</span></a>',
  'body { background: #fff; color: #111; } .blob { position: relative; display: inline-block; padding: 10px 18px; color: #fff; font-weight: 600; } .blob svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; } .blob span { position: relative; }');
// A look the person decided (an allowlist row with decided): its failure is reported, never refused.
pages['/decided-look'] = page('<h1>Decided look</h1><p class="dim">A waiting step, dimmed by design.</p>',
  'body { background: #fff; color: #111; } .dim { opacity: .35; }');

const screens = {
  defaults: { fonts: ['Fixture Text'] },
  screens: Object.keys(pages).map(route => ({ id: route.slice(1), route })),
};

let server;
let pictureServer;
let origin;
let pictureOrigin;
let browser;
let ran;
let matrixViews;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/fixture.woff2') { response.writeHead(200, { 'content-type': 'font/woff2' }); response.end(fontFile); return; }
    const found = pages[request.url];
    const body = typeof found === 'function' ? found(pictureOrigin) : found;
    if (!body) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  pictureServer = createServer((request, response) => { response.writeHead(200, { 'content-type': 'image/svg+xml' }); response.end(whiteSquare); });
  await new Promise(done => pictureServer.listen(0, '127.0.0.1', done));
  pictureOrigin = `http://127.0.0.1:${pictureServer.address().port}`;
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchChromium({ headless: true });
  const target = { origin, newContext: options => browser.newContext(options) };
  matrixViews = readViews();
  const focusedAx = process.env.FOCUSED_AX === '1';
  const only = focusedAx ? { screens: ['clean', 'unnamed-controls'], widths: ['phone'], modes: ['light'], pool: 1 } : {};
  if (focusedAx) {
    matrixViews.widths = matrixViews.widths.filter(row => row.id === 'phone');
    matrixViews.modes = matrixViews.modes.filter(row => row.id === 'light');
  }
  ran = await runMatrix({ target, screens, views: matrixViews, allowlist: [{ screen: 'decided-look', probe: 'contrast', decided: 'planted: a dimmed waiting step' }], only });
  if (process.env.SHOW_SCREEN_MATRIX) for (const failure of ran.failures) process.stdout.write(`${failure.screen}/${failure.width}/${failure.mode} ${failure.probe} ${failure.selector}: ${failure.detail}\n`);
});

after(async () => { await browser?.close(); await new Promise(done => server?.close(done)); await new Promise(done => pictureServer?.close(done)); });

const failing = (screen, probe) => ran.failures.filter(failure => failure.screen === screen && (!probe || failure.probe === probe));
const where = rows => [...new Set(rows.map(row => `${row.width}/${row.mode}`))].sort();

test('a clean page passes in every mode and width', () => {
  const done = ran.report.results.filter(row => row.screen === 'clean');
  assert.equal(done.length, matrixViews.widths.length * matrixViews.modes.filter(mode => !mode.extension).length, 'every selected width and mode was opened');
  assert.ok(done.every(row => row.texts > 0), 'the clean page was read');
  assert.deepEqual(failing('clean'), []);
});

test('browser-computed names accept native labels, aria-label and hidden aria-labelledby text, and reject empty controls', () => {
  assert.deepEqual(failing('clean', 'control_name'), [], 'named controls pass on the clean page');
  const rows = failing('unnamed-controls', 'control_name');
  assert.ok(rows.some(row => row.selector.includes('empty-button')), 'an empty button is rejected');
  assert.ok(rows.some(row => row.selector.includes('empty-input')), 'an empty text field is rejected');
  assert.ok(rows.every(row => /no accessible name/.test(row.detail)), 'the report identifies missing computed names');
});

test('text that fades in is read once it has faded in, and an animation that never ends does not hold the read', () => {
  const done = ran.report.results.filter(row => row.screen === 'fading');
  assert.ok(done.length > 0 && done.every(row => row.texts > 0), 'the fading page was read');
  assert.deepEqual(failing('fading'), []);
});

test('low-contrast text fails the contrast probe, in every mode that leaves the page as it is', () => {
  const rows = failing('low-contrast', 'contrast');
  assert.ok(rows.length > 0, 'contrast failed');
  assert.ok(rows.every(row => row.selector.includes('p.faint')), `only the faint line fails: ${rows.map(row => row.selector)}`);
  assert.ok(where(rows).includes('phone/light') && where(rows).includes('desktop/light'));
  assert.ok(!where(rows).some(at => at.endsWith('/forced')), 'forced colours repaint the text, so the faint colour is not what is drawn');
  assert.deepEqual(failing('low-contrast').filter(row => row.probe !== 'contrast' && row.probe !== undefined).map(row => row.probe), []);
});

test('a font that never loads fails the font probe, naming the platform font that drew it', () => {
  const rows = failing('font', 'font');
  assert.ok(rows.length > 0, 'font failed');
  assert.ok(rows.every(row => row.selector.includes('p.missing')), `only the missing-font line fails: ${rows.map(row => row.selector)}`);
  assert.match(rows[0].detail, /glyphs from .* drawn by a platform font/);
  assert.equal(where(rows).length, 3 * 4, 'in every width and mode');
});

test('text cut off without an ellipsis fails the overflow probe', () => {
  const rows = failing('clipped', 'overflow');
  assert.ok(rows.length > 0, 'overflow failed');
  assert.ok(rows.every(row => row.selector.includes('div.box')));
  assert.equal(failing('clean', 'overflow').length, 0, 'text with an ellipsis is not cut off');
});

test('an element wider than the phone fails the horizontal-scroll probe at the phone width only', () => {
  const rows = failing('wide', 'horizontal-scroll');
  assert.deepEqual([...new Set(rows.map(row => row.width))], ['phone']);
  assert.equal(rows.length, 4, 'in every mode');
  assert.match(rows[0].detail, /div\.wide reaches/);
});

test('a card whose text disappears under Dark Reader fails the contrast probe in that mode only', () => {
  const rows = failing('card-vanishes', 'contrast');
  assert.ok(rows.length > 0, 'contrast failed');
  assert.deepEqual([...new Set(rows.map(row => row.mode))], ['darkreader']);
  assert.equal(failing('card-vanishes').filter(row => row.mode !== 'darkreader').length, 0, 'readable in the other modes');
});

test('words on a decided colour are judged at its bar and reported, never refused; another colour still refuses', () => {
  assert.deepEqual(failing('decided-red'), []);
  const reported = ran.reported.filter(row => row.screen === 'decided-red' && row.mode === 'light');
  assert.ok(reported.some(row => row.text?.startsWith('White body words')), 'body-weight white on the decided red is reported (3.9 < 4.5)');
  assert.ok(!reported.some(row => row.text === 'Get started'), 'semibold white on the decided red meets the 3:1 bold bar');
  assert.ok(failing('other-red', 'contrast').some(row => row.mode === 'light'), 'white on a red nobody decided is still refused');
});

test('words over a graphic drawn under them are judged from the picture, not from the page behind it', () => {
  assert.deepEqual(failing('under-graphic', 'contrast').filter(row => row.mode === 'light'), []);
});

test('an allowlist row with decided keeps its failure as reported and never refuses', () => {
  assert.deepEqual(failing('decided-look'), []);
  assert.ok(ran.reported.some(row => row.screen === 'decided-look' && row.decided), 'the dimmed step is reported');
});
