// With no records source mounted, the records engine reads through the Workshop Worker's store, the road every signed-in
// page has always taken: GET /work/api/records?label=... . The page is built from a fixture entry that imports only the
// engine, served from a local server, and every /work/api request is answered here (a fake transport), so no real
// Worker runs and nothing else leaves the page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { buildPage } from '../web/examples/standalone-workspace/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.webm': 'video/webm', '.woff2': 'font/woff2' };

test('with no source mounted, the records engine reads the Worker store at /work/api/records', async () => {
  const out = mkdtempSync(join(tmpdir(), 'records-default-'));
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
  const workRequests = [];
  const outside = [];
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error.message)));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) && !url.includes('/work/api/')) return route.continue();
    if (url.includes('/work/api/')) {
      workRequests.push(url.slice(origin.length));
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"records":{"record-a":{"title":"from the Worker"}}}' });
    }
    outside.push(url);
    return route.abort();
  });
  try {
    await page.goto(`${origin}/index.html`);
    const answer = await page.evaluate(() => window.readSettled);
    assert.deepEqual(answer, { ok: true, records: { 'record-a': { title: 'from the Worker' } } });
    assert.ok(workRequests.some(path => path.startsWith('/work/api/records?label=record-a')), `requests: ${JSON.stringify(workRequests)}`);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(outside, []);
  } finally {
    await browser.close();
    server.close();
  }
});
