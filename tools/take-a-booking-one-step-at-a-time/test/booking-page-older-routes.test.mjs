// The booking page in a real browser against step routes that answer only { attemptId, next } (the program behind a site is an
// older one: no `form` in the answer). The page must not stop at the email: it takes each answer one at a time, draws the question
// the reply names, and reaches the step that offers the times. Every email is invented; the routes are a stub on loopback.
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
const question = (position, id, prompt) => ({ key: `question:${position}`, kind: 'question', position, prompt, required: true, question: { questionId: id, questionTypeId: 'short-text' } });
const START = { attemptId: 'attempt-1', next: question(0, 'age', "Player's Age") };
const SECOND = { next: question(1, 'goal', 'What is your goal?') };
const SLOT = { next: { key: 'slot', kind: 'slot' } };
const SLOTS = { slots: [{ startIso: '2026-12-01T16:00:00.000Z', endIso: '2026-12-01T16:30:00.000Z' }] };

async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'booking-older-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    "import { createElement } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    `import { View } from ${JSON.stringify(`${ROOT}tools/take-a-booking-one-step-at-a-time/show/BookingPage.tsx`)};`,
    "const host = document.createElement('div');",
    'document.body.append(host);',
    "createRoot(host).render(createElement(View, { page: 'call', title: 'A call', timezone: 'America/Chicago', duration_minutes: 30, questions: [{ position: 0, prompt: \"Player's Age\", required: true }, { position: 1, prompt: 'What is your goal?', required: true }], api_base: '/api' }));",
  ].join('\n'));
  const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', absWorkingDir: ROOT, nodePaths: [`${ROOT}node_modules`] });
  return built.outputFiles[0].text;
}

test('answers with no form: the email, every question and the times are reached, one answer at a time', async () => {
  const script = await bundle();
  const seen = [];
  let answers = 0;
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'POST') seen.push([request.url, body === '' ? {} : JSON.parse(body)]);
    const reply = request.url === '/api/book.start' ? START : request.url === '/api/book.answer' ? (answers++ === 0 ? SECOND : SLOT) : request.url === '/api/book.slots' ? SLOTS : request.method === 'POST' ? {} : null;
    response.writeHead(reply ? 200 : 200, { 'Content-Type': reply ? 'application/json' : 'text/html' });
    response.end(reply ? JSON.stringify(reply) : '');
  }).listen(0);
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: script });
    await page.locator('input[name=email]').fill('invented.booker@example.test');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: "Player's Age" }).waitFor({ timeout: 10000 });
    await page.locator('[id^=book-answer-]').first().fill('12');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { name: 'What is your goal?' }).waitFor({ timeout: 10000 });
    await page.locator('[id^=book-answer-]').first().fill('Win my league.');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('heading', { name: 'Pick a time' }).waitFor({ timeout: 10000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen.map(([url]) => url), ['/api/book.start', '/api/book.answer', '/api/book.answer', '/api/book.slots']);
    assert.deepEqual(seen[1][1], { attemptId: 'attempt-1', value: '12' });
  } finally {
    await browser.close();
    server.close();
  }
});
