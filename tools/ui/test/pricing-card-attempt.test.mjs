// The price card in a real browser: pressing Checkout posts its form with an attempt id and a start time that are new for every
// press (the page that receives the post asks for both). The receiving page is a stub on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../../../test-helpers/chromium.mjs';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const ROOT = new URL('../../../', import.meta.url).pathname;

test('every press of Checkout posts a new attempt id and the time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'price-attempt-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    "import { createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { PricingCard } from ${JSON.stringify(`${ROOT}tools/ui/show/pricing/PricingCard.tsx`)};`,
    "const host = document.createElement('div');",
    'document.body.append(host);',
    "createRoot(host).render(createElement(PricingCard, { id: 'o1', name: 'Plan', price: '$99', cta: { label: 'Checkout' }, action: '/buy', hiddenFields: { offerId: 'offer-1' }, attempt: { id_field: 'checkoutAttemptId', started_field: 'checkoutStartedAt', origin_field: 'returnUrlBase' } }));",
  ].join('\n'));
  const script = (await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', absWorkingDir: ROOT, nodePaths: [`${ROOT}node_modules`] })).outputFiles[0].text;
  const posts = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'POST') posts.push(Object.fromEntries(new URLSearchParams(body)));
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('');
  }).listen(0);
  const browser = await launchChromium();
  try {
    for (let press = 0; press < 2; press += 1) {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.addScriptTag({ content: script });
      await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Checkout' }).first().click()]);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  assert.equal(posts.length, 2);
  for (const post of posts) {
    assert.match(post.checkoutAttemptId, /^[a-zA-Z0-9_-]{12,96}$/);
    assert.ok(Number.isFinite(Date.parse(post.checkoutStartedAt)));
    assert.equal(post.offerId, 'offer-1');
    assert.match(post.returnUrlBase, /^http:\/\/127\.0\.0\.1:\d+$/);
  }
  assert.notEqual(posts[0].checkoutAttemptId, posts[1].checkoutAttemptId);
});
