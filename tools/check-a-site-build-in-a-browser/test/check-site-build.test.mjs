// tools/check-a-site-build-in-a-browser: every page kind of a built site is opened in Chromium beside the live site and the
// build is refused when a page is blank, throws an error the live page does not, or reads in a serif default where the live
// page does not. The "live" site is a second local server over made-up folders, so no test touches the network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { chromiumExecutable } from '../../../test-helpers/chromium.mjs';
import { checkSiteBuild, defaultSettings } from '../do-work/check-site-build.mjs';
import { pageKinds } from '../do-work/page-kinds.mjs';
import { serveBuild } from '../do-work/serve-build.mjs';

const settings = { ...defaultSettings(), settle_ms: 600, navigation_timeout_ms: 20000 };
const browser = chromiumExecutable();

const page = ({ script = '', body = '' }) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="root">${body}</div><script>${script}</script></body></html>`;
const SANS = 'font-family: Arial, Helvetica, sans-serif';
const TIMES = 'font-family: "Times New Roman", serif';
const tall = (px, font = SANS) => page({ body: `<div style="height:${px}px"><p style="${font}">The reading text of the page.</p></div>` });
const throwsToUpper = page({ body: '<div style="height:63px"></div>', script: 'const course = {}; course.name.toUpperCase();' });
const sitemap = paths => `<?xml version="1.0"?><urlset>${paths.map(path => `<url><loc>https://live.example${path}</loc></url>`).join('')}</urlset>`;

function folder(files) {
  const root = mkdtempSync(join(tmpdir(), 'site-build-test-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const liveFiles = { 'index.html': tall(3490), 'courses/yoga.html': tall(3490), 'about.html': tall(1200) };
async function run(builtFiles, more = {}) {
  const live = await serveBuild({ root: folder(liveFiles), settings });
  try {
    return await checkSiteBuild({ pages: folder(builtFiles), live: live.origin, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser, ...more });
  } finally {
    await live.close();
  }
}
const byKind = (result, kind) => result.pages.find(row => row.kind === kind);

test('page kinds come from the sitemap grouped by path shape plus the top-level pages it leaves out', () => {
  const root = folder({ 'sitemap.xml': sitemap(['/', '/courses/yoga', '/courses/tennis', '/blog/2026/a', '/blog/2026/b', '/pricing']), 'index.html': 'x', 'extra.html': 'x', 'pricing.html': 'x' });
  assert.deepEqual(pageKinds(root, settings), [
    { kind: '/', path: '/' }, { kind: '/courses/*', path: '/courses/yoga' }, { kind: '/blog/2026/*', path: '/blog/2026/a' },
    { kind: '/pricing', path: '/pricing' }, { kind: '/extra', path: '/extra' },
  ]);
});

test('a blank course page that throws TypeError (toUpperCase) against a tall live page is refused for height and for the new error', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/courses/yoga']), 'courses/yoga.html': throwsToUpper });
  const row = byKind(result, '/courses/*');
  assert.equal(row.refused, true);
  assert.ok(row.height_px <= settings.viewport.height, `built height ${row.height_px}: a blank page is only as tall as the window`);
  assert.ok(row.live_height_px > 3000, `live height ${row.live_height_px}`);
  assert.ok(row.height_to_live < 0.5);
  assert.equal(row.new_page_errors.length, 1);
  assert.match(row.new_page_errors[0], /Cannot read properties of undefined \(reading 'toUpperCase'\)/);
  assert.equal(row.why.length, 2);
  assert.equal(result.refused, 1);
});

test('a serif home against a sans live home is refused for its reading font alone', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/']), 'index.html': tall(3490, TIMES) });
  const row = byKind(result, '/');
  assert.equal(row.refused, true);
  assert.equal(row.serif_where_live_is_not, true);
  assert.match(row.reading_font, /Times/);
  assert.match(row.live_reading_font, /Arial/);
  assert.equal(row.why.length, 1);
  assert.deepEqual(row.new_page_errors, []);
});

test('a page that matches the live page passes, and so does a serif page where the live page is serif too', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/', '/courses/yoga']), 'index.html': tall(3490), 'courses/yoga.html': tall(3300) });
  assert.equal(result.refused, 0);
  assert.equal(byKind(result, '/').height_to_live, 1);
  assert.ok(byKind(result, '/courses/*').height_to_live > 0.9);
  assert.ok(result.pages.every(row => row.screenshots.local && readFileSync(row.screenshots.local).length > 100));
  const serifLive = await serveBuild({ root: folder({ 'index.html': tall(3490, TIMES) }), settings });
  try {
    const same = await checkSiteBuild({ pages: folder({ 'sitemap.xml': sitemap(['/']), 'index.html': tall(3490, TIMES) }), live: serifLive.origin, out: mkdtempSync(join(tmpdir(), 'site-build-out-')), settings, browser });
    assert.equal(same.refused, 0, JSON.stringify(same.pages[0].why));
  } finally {
    await serifLive.close();
  }
});

test('a page kind with no live page passes with text and no error, and is refused with an error or no text', async () => {
  const drawn = page({ body: '<p>An event that exists only in the build.</p>' });
  const passes = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': drawn });
  assert.equal(byKind(passes, '/events/*').refused, false);
  assert.equal(byKind(passes, '/events/*').live_height_px, null);
  const errors = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': page({ body: '<p>text</p>', script: 'null.x' }) });
  assert.equal(byKind(errors, '/events/*').refused, true);
  assert.match(byKind(errors, '/events/*').why[0], /no live page exists and the built page threw/);
  const blank = await run({ 'sitemap.xml': sitemap(['/events/summer']), 'events/summer.html': page({}) });
  assert.match(byKind(blank, '/events/*').why[0], /shows no text/);
});

test('a sitemap path with no file in the build is refused, never skipped', async () => {
  const result = await run({ 'sitemap.xml': sitemap(['/courses/yoga']) });
  assert.equal(byKind(result, '/courses/*').refused, true);
  assert.equal(byKind(result, '/courses/*').why[0], settings.words.no_file);
});

test('the command prints one JSON line and exits 1 when a page is refused, 0 when none is', async () => {
  const live = await serveBuild({ root: folder(liveFiles), settings });
  const command = (built, out) => promisify(execFile)(process.execPath, [new URL('../do-work/check-site-build.mjs', import.meta.url).pathname,
    '--pages', built, '--live', live.origin, '--out', out], { env: { ...process.env, BROWSER_EXECUTABLE: browser } }).then(done => ({ code: 0, ...done }), failed => failed);
  try {
    const refused = await command(folder({ 'sitemap.xml': sitemap(['/courses/yoga']), 'courses/yoga.html': throwsToUpper }), mkdtempSync(join(tmpdir(), 'site-build-out-')));
    assert.equal(refused.code, 1);
    const line = JSON.parse(refused.stdout.trim());
    assert.equal(line.result.refused, 1);
    assert.equal(refused.stdout.trim().split('\n').length, 1);
    const passed = await command(folder({ 'sitemap.xml': sitemap(['/about']), 'about.html': tall(1200) }), mkdtempSync(join(tmpdir(), 'site-build-out-')));
    assert.equal(passed.code, 0, passed.stderr);
  } finally {
    await live.close();
  }
});

test('data calls pass to the live site with no query added, Referer and Origin naming the live host; page views carry the check query', async () => {
  const seen = [];
  const http = await import('node:http');
  const stand = http.createServer((req, res) => { seen.push({ url: req.url, referer: req.headers.referer, origin: req.headers.origin }); res.end('ok'); });
  await new Promise(done => stand.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${stand.address().port}`;
  const local = await serveBuild({ root: folder({ 'index.html': 'x' }), live: origin, settings });
  try {
    await fetch(`${local.origin}/target/offers-for-this-page`, { headers: { referer: `${local.origin}/courses/yoga?utm_content=check`, origin: local.origin } });
    await fetch(`${local.origin}/media/clip.mp4`);
    assert.deepEqual(seen[0], { url: '/target/offers-for-this-page', referer: `${origin}/courses/yoga?utm_content=check`, origin });
    assert.equal(seen[1].url, '/media/clip.mp4?utm_content=check');
  } finally {
    await local.close();
    stand.closeAllConnections();
    await new Promise(done => stand.close(done));
  }
});
