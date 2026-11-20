// With no records source mounted, a read fails in the engine's plain words (records-source.ts, invariant 1) and sends nothing
// anywhere: the engine assumes no store, so a page whose entry forgot its source cannot quietly talk to a retired one. The
// page is built from a fixture entry that imports only the engine and is served from a local server; any request that
// leaves the page is recorded and refused.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { buildPage } from '../web/examples/standalone-workspace/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webm': 'video/webm', '.woff2': 'font/woff2' };

test('with no source mounted, a records read fails in plain words and nothing leaves the page', async () => {
  const out = tempFolder(join(tmpdir(), 'records-default-'));
  await buildPage({ entry: resolve(here, 'fixtures/records-default-entry.ts'), out });
  const server = createServer((request, response) => {
    const file = join(out, request.url === '/' ? 'index.html' : decodeURIComponent(request.url.split('?')[0]));
    if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const shell = readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-1243')).sort().at(-1);
  const folder = readdirSync(join(cache, shell)).find(name => name.startsWith('chrome-headless-shell-'));
  const browser = await chromium.launch({ headless: true, executablePath: join(cache, shell, folder, 'chrome-headless-shell') });
  const page = await browser.newPage();
  const outside = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error.message)));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) && !url.includes('/work/')) return route.continue();
    outside.push(url);
    return route.abort();
  });
  try {
    await page.goto(`${origin}/index.html`);
    const answer = await page.evaluate(() => window.readSettled);
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.match(answer.error, /This page has no records source/);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(outside, []);
  } finally {
    await browser.close();
    server.close();
  }
});
