// Exercises the real source-first crawl with a deterministic Playwright boundary, without starting another browser.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const script = resolve(import.meta.dirname, '../do-work/list-the-videos-a-site-plays.mjs');
const launcher = pathToFileURL(resolve(import.meta.dirname, '../../headless-browser/launch.mjs')).href;
const fixture = `
import { writeFileSync } from 'node:fs';
const input = JSON.parse(process.env.SITE_MEDIA_FIXTURE);
const trace = { visits: [], wheels: 0, waits: [], pageCloses: 0, browserCloses: 0 };
export async function launchChromium(options) {
  trace.options = options;
  return {
    async newContext(options) {
      if(input.context_error) throw new Error(input.context_error);
      trace.context = options;
      return { async newPage() {
        let current, onRequest;
        return {
          on(name, callback) { if(name === 'request') onRequest = callback; },
          async goto(url, options) {
            current = url; trace.visits.push(url); trace.navigation = options;
            for(const address of (input[url]?.requests ?? [])) onRequest({ url: () => address });
          },
          mouse: { async wheel() { trace.wheels++; } },
          async waitForTimeout(ms) { trace.waits.push(ms); },
          async evaluate() {
            if (input[current]?.error) throw new Error(input[current].error);
            return { v: input[current]?.v ?? [], a: input[current]?.a ?? [] };
          },
          async close() { trace.pageCloses++; },
        };
      }};
    },
    async close() { trace.browserCloses++; writeFileSync(process.env.SITE_MEDIA_TRACE, JSON.stringify(trace)); },
  };
}
`;
function run(url, pages = {}) {
  const dir = tempFolder(join(tmpdir(), 'site-media-test-'));
  try {
    const mock = join(dir, 'launcher.mjs');
    const loader = join(dir, 'loader.mjs');
    const trace = join(dir, 'trace.json');
    writeFileSync(mock, fixture);
    writeFileSync(loader, `export async function resolve(specifier, context, next) {
      const resolved = await next(specifier, context);
      return resolved.url === ${JSON.stringify(launcher)} ? { url: ${JSON.stringify(pathToFileURL(mock).href)}, shortCircuit: true } : resolved;
    }`);
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, script, url], {
      encoding: 'utf8', env: { ...process.env, SITE_MEDIA_FIXTURE: JSON.stringify(pages), SITE_MEDIA_TRACE: trace,
        HTTPS_PROXY: 'http://proxy.example:8787', BROWSER_EXECUTABLE: '/fixture/chromium' }, timeout: 10000,
    });
    let observed;
    try { observed = JSON.parse(readFileSync(trace)); } catch {}
    return { ...result, trace: observed, answer: result.status === 0 ? JSON.parse(result.stdout).result : null };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('source crawl records requests and elements once, scrolls pages, and rejects lookalike/external links', () => {
  const origin = 'https://site.example';
  const result = run(`${origin}/`, {
    [`${origin}/`]: { requests: [`${origin}/first.mp4`, 'https://stream.mux.com/a.m3u8?token=x', `${origin}/image.png`],
      v: [`${origin}/first.mp4`, 'https://player.example/frame'],
      a: [`${origin}/next?tracking=x`, `${origin}/#fragment`, 'https://site.example.evil/other', 'https://elsewhere.example/'] },
    [`${origin}/next`]: { v: [`${origin}/last.webm`], a: [`${origin}/`] },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.answer, { origin, pages: [`${origin}/`, `${origin}/next`],
    videos: [`${origin}/first.mp4`, 'https://stream.mux.com/a.m3u8', 'https://player.example/frame', `${origin}/last.webm`], remaining_pages: [] });
  assert.equal(result.trace.wheels, 20);
  assert.deepEqual(result.trace.waits, Array(20).fill(500));
  assert.equal(result.trace.pageCloses, 2);
  assert.equal(result.trace.browserCloses, 1);
  assert.deepEqual(result.trace.context, { viewport: { width: 1440, height: 900 } });
  assert.deepEqual(result.trace.options, { executablePath: '/fixture/chromium', proxy: { server: 'http://proxy.example:8787', bypass: '<-loopback>' } });
  assert.deepEqual(result.trace.navigation, { waitUntil: 'networkidle', timeout: 90000 });
});

test('25-page source bound reports the remaining page', () => {
  const pages = {};
  for(let i = 0; i < 30; i++) pages[`https://site.example/${i}`] = { a: [`https://site.example/${i + 1}`] };
  const result = run('https://site.example/0', pages);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.answer.pages.length, 25);
  assert.deepEqual(result.answer.remaining_pages, ['https://site.example/25']);
});

test('the browser closes when page evaluation fails', () => {
  const result = run('https://site.example/', { 'https://site.example/': { error: 'fixture page failed' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture page failed/);
  assert.equal(result.trace.browserCloses, 1);
});

test('non-web and credential-bearing addresses fail before launching', () => {
  for(const url of ['file:///private/file', 'https://person:password@example.com/']) {
    const result = run(url);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTP or HTTPS address without credentials/);
    assert.equal(result.trace, undefined);
  }
});


test('the browser closes when context creation fails', () => {
  const result = run('https://site.example/', { context_error: 'fixture context failed' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture context failed/);
  assert.equal(result.trace.browserCloses, 1);
});
