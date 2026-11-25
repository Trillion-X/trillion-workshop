// The whole site over a loopback engine door: rows and answers are read with tools:run as the right caller, pages are drawn
// on the server with their screens and parts, the browser's files answer by identity, members pages need a member's pass,
// and a door that fails leaves a page of words, never a half-drawn page.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { runTool } from '../do-work/door.ts';
import type { ToolRun } from '../do-work/door.ts';
import { pageStyles } from '../do-work/page-styles.ts';
import { PageBundles } from '../do-work/render.ts';
import { ScreenFiles } from '../do-work/screen-files.ts';
import { handlerOf, serverTiming, settingsOf, Site } from '../do-work/serve.ts';
import type { Settings } from '../do-work/serve.ts';

const tools = join(import.meta.dirname, '..', '..');
const TEXT = 'ui/show/text/Text.tsx';

const PAGES = [
  { path: '/', title: 'Home', access: 'public', tool: null, input: {}, collection: null, updated_at: '2026-11-20 10:00:00+00', layout: { part: TEXT, export: 'Text', props: { as: 'main' }, children: [{ text: 'Welcome' }, { tool: 'tool:read-a-greeting', input: { who: 'everyone' } }] } },
  { path: '/notes/:slug', title: 'A note', access: 'public', tool: 'tool:read-a-greeting', input: { who: ':slug' }, collection: 'notes', updated_at: '2026-11-21 10:00:00+00', layout: null },
  { path: '/members', title: 'Members', access: 'members', tool: 'tool:read-a-greeting', input: { who: 'member' }, collection: null, updated_at: null, layout: null },
  { path: '/', title: 'App home', access: 'public', tool: 'tool:read-a-greeting', input: { who: 'the app' }, collection: null, updated_at: null, layout: null, host: 'app.site.example.test' },
  { path: '/sign-in', title: 'Sign in', access: 'public', tool: 'tool:read-a-greeting', input: { who: 'a visitor, please sign in' }, collection: null, updated_at: null, layout: null },
  { path: '/moved', title: 'Members area', access: 'public', tool: null, input: null, collection: null, updated_at: null, layout: { go_to: 'https://app.site.example.test/' } },
  { path: '/broken', title: 'Broken', access: 'public', tool: 'tool:fails', input: {}, collection: null, updated_at: null, layout: null },
];

// An engine door on loopback: tools:run of run-sql answers the rows, read-a-greeting answers a Text screen's props, and every
// call's pass and tool are written down.
async function door() {
  const calls: { pass: string; run: ToolRun }[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const run = JSON.parse(body).params.arguments.input as ToolRun & { input: { sql?: string; who?: string; use?: unknown } };
      const pass = String(request.headers.authorization).replace(/^Bearer /, '');
      calls.push({ pass, run });
      let result: unknown;
      if (run.tool === 'tool:run-sql-in-my-database') {
        assert.deepEqual(run.input.use, { purpose: 'serve the site', surface: 'site pages' }, 'every read runs under the declared use');
        const sql = run.input.sql!;
        result = { rows: sql.includes('FROM pages') ? PAGES : sql.includes('FROM site_look') ? [{ name: 'brand-ink', value: '#123456' }] : [{ slug: 'first' }, { slug: 'second one' }] };
      } else if (run.tool === 'tool:read-a-greeting') {
        result = { as: 'p', children: `Hello, ${run.input.who}` };
      } else {
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 1, result: null } } }));
      }
      response.setHeader('content-type', 'text/event-stream');
      response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 0, result } } })}\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, calls, address: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const settings = (address: string, more: Record<string, unknown> = {}): Settings => settingsOf({
  listen: '127.0.0.1:0', hosts: ['app.site.example.test'], origin: 'https://site.example.test', lang: 'en',
  door: { address, pass_credential: 'site-door-pass' },
  pages: { database: 'a_site_for_who_uses_it', use: { purpose: 'serve the site', surface: 'site pages' }, refresh_seconds: 60, answer_seconds: 60 },
  sign_in: { address: 'http://127.0.0.1:1', page: '/sign-in', issuer: 'https://sign-in.example.test', audience: 'https://site.example.test', team_claim: 'team_ids', members_team: 'team-members' },
  ...more,
});

// One kept set of screen files, as one program keeps: the looks' fonts are kept once when the styles are read.
const files = new ScreenFiles();
let styles: Awaited<ReturnType<typeof pageStyles>>;
test.before(async () => { styles = await pageStyles(tools, files); });

async function siteOn(address: string, more: Record<string, unknown> = {}) {
  const site = new Site({
    settings: settings(address, more), tools,
    run: (pass, call) => runTool({ address }, pass, call),
    sitePass: 'the-site-pass',
    passes: { memberOfCookie: async cookie => cookie === 'session=member' ? { pass: 'the-member-pass', subject: 'user-1', teams: ['team-members'] } : null },
    storeKey: null,
    bundles: new PageBundles(tools, styles, files),
    files,
    screens: new Map([['tool:read-a-greeting', { file: TEXT, export: 'Text' }], ['tool:fails', { file: TEXT, export: 'Text' }]]),
    log: () => {},
  });
  await site.read();
  return site;
}

test('a public page is drawn on the server from its layout, its tool answer and the look rows, and its files answer by identity', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const page = await site.answer('GET', '/', undefined);
    assert.equal(page.status, 200);
    const html = String(page.body);
    assert.match(html, /^<!doctype html><html lang="en">/);
    assert.match(html, /<title>Home<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/site.example.test\/"\/>/);
    assert.match(html, /<style>:root\{--brand-ink:#123456;\}<\/style>/);
    assert.match(html, /<main[^>]*>Welcome<p[^>]*>Hello, everyone<\/p><\/main>/, 'the part holds its words and the tool screen drawn with its answer');
    assert.match(page.headers['server-timing'], /^run0;dur=\d+;desc="tool:read-a-greeting"$/);
    const script = html.match(/<script type="module" src="([^"]+)"/)![1];
    const sheet = html.match(/<link rel="stylesheet" href="([^"]+)"/)![1];
    const js = await site.answer('GET', script, undefined);
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(js.body), /createRoot|hydrate|render/);
    const css = await site.answer('GET', sheet, undefined);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    const fonts = [...String(css.body).matchAll(/url\('(\/screen-files\/[^']+\.woff2)'\)/g)].map(m => m[1]);
    assert.ok(fonts.length > 0, 'the looks name their fonts by identity');
    for (const font of fonts) assert.equal((await site.answer('GET', font, undefined)).headers['content-type'], 'font/woff2', font);
    assert.doesNotMatch(String(css.body), /url\('fonts\//, 'no look names a font by a relative address');
    assert.equal((await site.answer('GET', '/screen-files/1f:00.js', undefined)).status, 404);
    assert.ok(d.calls.every(call => call.pass === 'the-site-pass'), 'a public page is read with the site\'s own pass');
  } finally { d.server.close(); }
});

test('a template page takes its slug, keeps its public answer, and the sitemap lists every public address', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const note = await site.answer('GET', '/notes/first', undefined);
    assert.match(String(note.body), /Hello, first/);
    const before = d.calls.length;
    await site.answer('GET', '/notes/first', undefined);
    assert.equal(d.calls.length, before, 'the answer is kept answer_seconds, so the door is not asked again');
    const map = String((await site.answer('GET', '/sitemap.xml', undefined)).body);
    assert.match(map, /<loc>https:\/\/site.example.test\/<\/loc><lastmod>2026-11-20<\/lastmod>/);
    assert.match(map, /<loc>https:\/\/site.example.test\/notes\/first<\/loc>/);
    assert.match(map, /<loc>https:\/\/site.example.test\/notes\/second%20one<\/loc>/);
    assert.doesNotMatch(map, /members/, 'a members page is never listed');
  } finally { d.server.close(); }
});

test('a members page sends a visitor to sign in, and draws for a member with the member\'s own pass, never kept', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const away = await site.answer('GET', '/members?tab=1', undefined);
    assert.equal(away.status, 302);
    assert.equal(away.headers.location, '/sign-in?next=%2Fmembers%3Ftab%3D1');
    assert.equal(away.headers['cache-control'], 'private, no-store');
    const page = await site.answer('GET', '/members', 'session=member');
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'private, no-store');
    assert.match(String(page.body), /Hello, member/);
    const greeted = d.calls.filter(call => call.run.tool === 'tool:read-a-greeting' && (call.run.input as { who: string }).who === 'member');
    assert.deepEqual(greeted.map(call => call.pass), ['the-member-pass']);
    await site.answer('GET', '/members', 'session=member');
    assert.equal(d.calls.filter(call => (call.run.input as { who?: string }).who === 'member').length, 2, 'a member\'s answer is asked for again each time');
  } finally { d.server.close(); }
});

test('an unknown address is 404, a failed tool is a 502 page of words, and only GET and HEAD are answered', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const missing = await site.answer('GET', '/no/such/page', undefined);
    assert.equal(missing.status, 404);
    assert.match(String(missing.body), /There is no page at this address/);
    const broken = await site.answer('GET', '/broken', undefined);
    assert.equal(broken.status, 502);
    assert.match(String(broken.body), /Something this page reads did not answer/);
    assert.doesNotMatch(String(broken.body), /the-site-pass/);
    assert.equal((await site.answer('POST', '/', undefined)).status, 405);
  } finally { d.server.close(); }
});

test('the program answers over node:http, HEAD with no body', async () => {
  const d = await door();
  const server = http.createServer(handlerOf(await siteOn(d.address)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await fetch(`${at}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await page.text(), /Hello, everyone/);
    const head = await fetch(`${at}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { server.close(); d.server.close(); }
});

test('settings that are not a site are refused with what they should be', () => {
  const good = settings('http://127.0.0.1:1');
  assert.throws(() => settingsOf({ ...good, listen: 'anywhere' }), /listen/);
  assert.throws(() => settingsOf({ ...good, origin: 'https://site.example.test/' }), /origin/);
  assert.throws(() => settingsOf({ ...good, pages: { ...good.pages, use: { purpose: 'x' } } }), /pages is/);
  assert.throws(() => settingsOf({ ...good, sign_in: { ...good.sign_in, page: 'sign-in' } }), /sign_in/);
  assert.equal(serverTiming([{ tool: 'tool:a"b', ms: 5 }]), 'run0;dur=5;desc="tool:ab"');
});

test('one unit answers each of its hosts by X-Forwarded-Host, else Host; a host\'s own row wins, an unknown host is origin\'s', async () => {
  const d = await door();
  const site = await siteOn(d.address);
  const server = http.createServer(handlerOf(site));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const app = await (await fetch(at, { headers: { 'x-forwarded-host': 'app.site.example.test' } })).text();
    assert.match(app, /Hello, the app/);
    assert.match(app, /<link rel="canonical" href="https:\/\/app.site.example.test\/"\/>/);
    assert.match(app, /id="root"/, 'the mount is #root');
    const main = await (await fetch(at, { headers: { 'x-forwarded-host': 'site.example.test' } })).text();
    assert.match(main, /Hello, everyone/);
    assert.equal(site.hostOf(undefined, 'APP.site.example.test:443'), 'app.site.example.test');
    assert.equal(site.hostOf(undefined, 'elsewhere.example.test'), 'site.example.test');
    assert.match(String((await site.answer('GET', '/notes/first', undefined, 'app.site.example.test')).body), /Hello, first/, 'a row for every host answers on each');
    assert.match(String((await site.answer('GET', '/sitemap.xml', undefined, 'app.site.example.test')).body), /<loc>https:\/\/app.site.example.test\/<\/loc>/);
  } finally { server.close(); d.server.close(); }
});

test('with signed_out "draw", a members address draws the sign-in page row in place, 200, private, no-store', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address, { sign_in: { ...settings('x').sign_in, signed_out: 'draw' } });
    const page = await site.answer('GET', '/members', undefined);
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'private, no-store');
    assert.match(String(page.body), /Hello, a visitor, please sign in/);
    assert.match(String(page.body), /<link rel="canonical" href="https:\/\/site.example.test\/members"\/>/);
    assert.match(String((await site.answer('GET', '/members', 'session=member')).body), /Hello, member/);
  } finally { d.server.close(); }
});

test('a local run with no listen setting listens on 127.0.0.1:18440', () => {
  const { listen, ...rest } = settings('http://127.0.0.1:1');
  assert.equal(listen, '127.0.0.1:0');
  assert.equal(settingsOf(rest).listen, '127.0.0.1:18440');
  assert.throws(() => settingsOf({ ...rest, hosts: ['Not A Host'] }), /hosts/);
  assert.throws(() => settingsOf({ ...rest, sign_in: { ...rest.sign_in, signed_out: 'maybe' } }), /signed_out/);
});

test('a moved page answers 200 and sends the browser on, kept out of engines', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const page = await site.answer('GET', '/moved', undefined);
    assert.equal(page.status, 200);
    const html = String(page.body);
    assert.match(html, /<meta http-equiv="refresh" content="0; url=https:\/\/app.site.example.test\/"\/>/);
    assert.match(html, /<meta name="robots" content="noindex"\/>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/app.site.example.test\/"\/>/);
  } finally { d.server.close(); }
});
