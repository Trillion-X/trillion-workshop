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
import { handlerOf, MOST_ACTION_BYTES, passOnFor, serverTiming, settingsOf, Site } from '../do-work/serve.ts';
import type { Settings } from '../do-work/serve.ts';

const tools = join(import.meta.dirname, '..', '..');
const TEXT = 'ui/show/text/Text.tsx';

const PAGES = [
  { path: '/', title: 'Home', access: 'public', tool: null, input: {}, collection: null, updated_at: '2026-11-20 10:00:00+00', layout: { part: TEXT, export: 'Text', props: { as: 'main' }, children: [{ text: 'Welcome' }, { tool: 'tool:read-a-greeting', input: { who: 'everyone' } }] } },
  { path: '/notes/:slug', title: 'A note', access: 'public', tool: 'tool:read-a-greeting', input: { who: ':slug' }, collection: 'notes', updated_at: '2026-11-21 10:00:00+00', layout: null },
  { path: '/members', title: 'Members', access: 'members', tool: 'tool:read-a-greeting', input: { who: 'member' }, collection: null, updated_at: null, layout: null },
  { path: '/', title: 'App home', access: 'public', tool: 'tool:read-a-greeting', input: { who: 'the app' }, collection: null, updated_at: null, layout: null, host: 'app.site.example.test' },
  { path: '/sign-in', title: 'Sign in', access: 'public', tool: 'tool:read-a-greeting', input: { who: 'a visitor, please sign in' }, collection: null, updated_at: null, layout: null },
  { path: '/old/:slug', title: 'Moved', access: 'public', tool: null, input: null, collection: null, updated_at: null, layout: { go_to: '/notes/:slug' } },
  { path: '/moved', title: 'Members area', access: 'public', tool: null, input: null, collection: null, updated_at: null, layout: { go_to: 'https://app.site.example.test/' } },
  { path: '/broken', title: 'Broken', access: 'public', tool: 'tool:fails', input: {}, collection: null, updated_at: null, layout: null },
];

const ACTIONS = [
  { path: '/checkout', host: null, access: 'public', tool: 'tool:start-a-checkout', failed: 'Checkout could not start.', answer: { redirect_from: 'redirectUrl' }, input: {
    offerId: { $: 'body', key: 'offerId' }, amount: { $: 'number', of: { $: 'body', key: 'amount' } }, email: { $: 'member', claim: 'email' },
    visitor: { $: 'cookie', name: 'visitor', when: { cookie: 'consent', is: 'granted' } }, offers: { $: 'rows', database: 'a_site_for_who_runs_it', sql: 'SELECT * FROM offers WHERE id = $1', params: [{ $: 'body', key: 'offerId' }] },
    success_url: { $: 'origin', then: '/welcome' }, attempt: { $: 'new_id' }, at: { $: 'now' },
  } },
  { path: '/book/:offer', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'Booking could not start.', input: { offer: { $: 'path', name: 'offer' }, email: { $: 'body', key: 'email' } },
    answer: { redirect_to: { $: 'url', base: 'https://book.example.test/call', query: { email: { $: 'body', key: 'email' }, name: { $: 'body', key: 'name' }, kept: { $: 'answer', key: 'kept' } } } } },
  { path: '/members-only', host: null, access: 'members', tool: 'tool:keep-a-lead', failed: 'No.', input: {}, answer: { json: ['kept'] } },
  { path: '/fails', host: null, access: 'public', tool: 'tool:fails', failed: 'That did not work.', input: {}, answer: { json: ['x'] } },
  { path: '/bad', host: null, access: 'public', tool: 'tool:x', failed: 'x', input: { a: { $: 'shell', run: 'rm' } }, answer: { json: ['x'] } },
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
        result = { rows: sql.includes('FROM "site_actions"') ? ACTIONS : sql.includes('FROM offers') ? [{ id: 'offer:one', params: run.input.params }] : sql.includes('FROM pages') ? PAGES : sql.includes('FROM site_look') ? [{ name: 'theme', value: 'paper' }, { name: 'font-face.body-400', value: 'Body Sans|400|normal|/assets/fonts/body.woff2' }, { name: 'brand-ink', value: '#123456' }] : [{ slug: 'first' }, { slug: 'second one' }] };
      } else if (run.tool === 'tool:start-a-checkout') {
        result = { redirectUrl: 'https://pay.example.test/session/1', sessionId: 's1' };
      } else if (run.tool === 'tool:keep-a-lead') {
        result = { kept: 1 };
      } else if (run.tool === 'tool:read-the-site-head') {
        result = { head: '<script>window.consentFirst=1</script>', body_start: '<noscript>tags off</noscript>' };
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
    passes: { memberOfCookie: async cookie => cookie?.split('; ').includes('session=member') ? { pass: 'the-member-pass', subject: 'user-1', teams: ['team-members'], claims: { sub: 'user-1', email: 'member@example.test' } } : null },
    storeKey: null,
    bundles: new PageBundles(tools, styles, files),
    palette: theme => styles.palette(theme),
    keepFont: async src => files.keep(Buffer.from(`font bytes of ${src}`), 'woff2'),
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
    const look = html.match(/<style>(@font-face[^<]*)<\/style>/)![1];
    const face = look.match(/^@font-face\{font-family:'Body Sans';src:url\('(\/screen-files\/[^']+\.woff2)'\) format\('woff2'\);font-weight:400;font-style:normal;font-display:swap\}/);
    assert.ok(face, 'a font-face row is an @font-face rule first, its file kept on this site');
    assert.equal(String(files.answer(face![1])!.body), 'font bytes of /assets/fonts/body.woff2');
    assert.ok(look.slice(face![0].length).startsWith(styles.palette('paper')), 'the site\'s theme row picks its Screen Look palette next');
    assert.ok(look.endsWith(':root{--brand-ink:#123456;}'), 'the site\'s own look rows follow, so they win');
    assert.notEqual(styles.palette('paper'), styles.palette(null), 'a named theme is not the starting one');
    assert.throws(() => styles.palette('no-such-look'), /does not offer/);
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
  assert.throws(() => settingsOf({ ...good, site_head: { tool: 'read-the-site-head', input: {} } }), /site_head/);
  assert.throws(() => settingsOf({ ...good, site_head: { tool: 'tool:read-the-site-head', input: [] } }), /site_head/);
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

test('a moved template page sends the browser on to its new address with the same slug', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    assert.match(String((await site.answer('GET', '/old/first%20note', undefined)).body), /url=\/notes\/first%20note"/);
  } finally { d.server.close(); }
});

test('the paths another program answers (the sign-in tool\'s) are passed to it whole, cookies and all; every other path is the site\'s', async () => {
  const seen: { method?: string; url?: string; forwardedHost?: string; body: string }[] = [];
  const signIn = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, forwardedHost: String(request.headers['x-forwarded-host']), body });
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => signIn.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const server = http.createServer(handlerOf(await siteOn(d.address), [{ name: 'the sign-in tool', address: `http://127.0.0.1:${(signIn.address() as AddressInfo).port}`, paths: ['/sign-in', '/api/auth'] }]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answer = await fetch(`${at}/api/auth/sign-in/email`, { method: 'POST', body: '{"email":"x"}', headers: { 'x-forwarded-host': 'app.site.example.test' } });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
    assert.deepEqual(seen[0], { method: 'POST', url: '/api/auth/sign-in/email', forwardedHost: 'app.site.example.test', body: '{"email":"x"}' });
    assert.match(await (await fetch(`${at}/`)).text(), /Hello, everyone/, 'the site answers its own paths');
    const on = [{ name: 'sign-in', address: 'http://a', paths: ['/sign-in'] }, { name: 'members', address: 'http://b', exact: ['/'], hosts: ['app.site.example.test'] }];
    assert.equal(passOnFor(on, 'site.example.test', '/sign-in-later'), null, 'a path is the prefix and what is under it, never a longer word');
    assert.equal(passOnFor(on, 'site.example.test', '/sign-in/done')?.name, 'sign-in');
    assert.equal(passOnFor(on, 'app.site.example.test', '/')?.name, 'members', 'exact paths on named hosts only');
    assert.equal(passOnFor(on, 'site.example.test', '/'), null);
    assert.equal(passOnFor(on, 'app.site.example.test', '/x'), null);
  } finally { server.close(); signIn.close(); d.server.close(); }
});

test('a part\'s own CSS module comes with the page: its local class is on the markup and its rule in the page\'s stylesheet', async () => {
  const bundle = await new PageBundles(tools, styles, files).bundleFor(['serve-a-sites-pages-from-its-rows/tests/show/Styled.tsx#View']);
  const html = bundle.html({ lang: 'en', title: 'T', canonical: 'https://site.example.test/', look: '' }, { module: 'serve-a-sites-pages-from-its-rows/tests/show/Styled.tsx#View', props: { words: 'Styled words' } });
  const local = html.match(/class="([^"]*box[^"]*)"[^>]*>Styled words/)![1].split(' ').find(name => name.includes('box'))!;
  const css = String(files.answer(bundle.sheet)!.body);
  assert.ok(css.includes(`.${local} {`) || css.includes(`.${local}{`), `the sheet holds the rule for ${local}`);
  assert.match(css, /color: ?(rgb\(1, ?2, ?3\)|#010203)/, 'the part\'s own rule is in the sheet');
  assert.ok(String(files.answer(bundle.script)!.body).includes(local), 'the browser draws the same local class');
});

test('the site head tool\'s markup opens every page\'s head and body, members pages too; a head that cannot be read stops the start', async () => {
  const d = await door();
  try {
    const head = { tool: 'tool:read-the-site-head', input: { database: 'a_site_for_who_uses_it', site: 'a-site' } };
    const site = await siteOn(d.address, { site_head: head });
    const call = d.calls.find(c => c.run.tool === head.tool)!;
    assert.deepEqual(call.run.input, head.input, 'the head tool is run with its settings input');
    assert.equal(call.pass, 'the-site-pass');
    for (const [path, cookie] of [['/', undefined], ['/members', 'session=member']] as const) {
      const html = String((await site.answer('GET', path, cookie)).body);
      assert.match(html, /^<!doctype html><html lang="en"><head><script>window.consentFirst=1<\/script>/, `${path}: the head markup is first in <head>`);
      assert.match(html, /<body[^>]*><noscript>tags off<\/noscript>/, `${path}: the body-start markup opens <body>`);
    }
    const plain = await siteOn(d.address);
    assert.doesNotMatch(String((await plain.answer('GET', '/', undefined)).body), /consentFirst/, 'a site with no site_head carries none');
    await assert.rejects(siteOn(d.address, { site_head: { tool: 'tool:fails', input: {} } }), /tool:fails/);
  } finally { d.server.close(); }
});

test('a posted form or JSON body runs its action row\'s tool with the input made from the request, and answers as the row says', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address, { actions: 'site_actions' });
    const host = 'site.example.test';
    const form = (fields: Record<string, string>) => ({ contentType: 'application/x-www-form-urlencoded', origin: 'https://site.example.test', bytes: Buffer.from(new URLSearchParams(fields).toString()) });
    const sent = await site.act('/checkout', 'consent=granted; visitor=v-1', host, form({ offerId: 'offer:one', amount: '120' }));
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.location, 'https://pay.example.test/session/1', 'a form post is sent on to the address the tool answered');
    const run = d.calls.find(call => call.run.tool === 'tool:start-a-checkout')!.run.input as Record<string, unknown>;
    assert.equal(run.offerId, 'offer:one');
    assert.equal(run.amount, 120, 'a number source makes the form\'s words a number');
    assert.equal(run.visitor, 'v-1', 'a cookie with its consent given is carried');
    assert.equal(run.success_url, 'https://site.example.test/welcome');
    assert.deepEqual(run.offers, [{ id: 'offer:one', params: ['offer:one'] }], 'a rows source reads a database with its values');
    assert.equal((d.calls.find(call => String((call.run.input as { sql?: string }).sql).includes('FROM offers'))!.run.input as { database: string }).database, 'a_site_for_who_runs_it', 'as the site, on the database it names');
    assert.match(String(run.attempt), /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(String(run.at))));
    assert.ok(!('email' in run), 'a signed-out visitor has no member claim, so the key is left out');
    d.calls.length = 0;
    const asJson = await site.act('/checkout', 'visitor=v-1; session=member', host, { contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ offerId: 'offer:one' })) });
    assert.equal(asJson.status, 200);
    assert.deepEqual(JSON.parse(String(asJson.body)), { redirect: 'https://pay.example.test/session/1' }, 'a JSON post gets the address as JSON');
    const memberRun = d.calls.find(call => call.run.tool === 'tool:start-a-checkout')!;
    assert.equal(memberRun.pass, 'the-member-pass', 'a signed-in member\'s action runs as the member');
    const input = memberRun.run.input as Record<string, unknown>;
    assert.equal(input.email, 'member@example.test');
    assert.ok(!('visitor' in input), 'a cookie whose consent is not given is not carried');
    const booked = await site.act('/book/offer%3Aone', undefined, host, form({ email: 'a@example.test', name: '' }));
    assert.equal(booked.status, 303);
    assert.equal(booked.headers.location, 'https://book.example.test/call?email=a%40example.test&kept=1', 'an empty value is left out of the address; the answer can fill it');
    assert.deepEqual(d.calls.at(-1)!.run.input, { offer: 'offer:one', email: 'a@example.test' });
    assert.equal((await site.act('/members-only', undefined, host, form({}))).status, 403);
    assert.deepEqual(JSON.parse(String((await site.act('/members-only', 'session=member', host, form({}))).body)), { kept: 1 });
    const failed = await site.act('/fails', undefined, host, { contentType: 'application/json', bytes: Buffer.from('{}') });
    assert.equal(failed.status, 502);
    assert.deepEqual(JSON.parse(String(failed.body)), { error: 'That did not work.' });
    assert.equal((await site.act('/fails', undefined, host, form({}))).status, 502, 'a form post that fails gets a page of the row\'s words');
    assert.equal((await site.act('/bad', undefined, host, form({}))).status, 404, 'a row with a source that is not one is set aside');
    assert.equal((await site.act('/nowhere', undefined, host, form({}))).status, 404);
    assert.equal((await site.act('/checkout', undefined, host, { ...form({}), origin: 'https://elsewhere.example.test' })).status, 403, 'another site\'s page cannot post here');
    assert.equal((await site.act('/checkout', undefined, host, { contentType: 'text/plain', bytes: Buffer.from('x') })).status, 400);
    assert.equal((await site.act('/checkout', undefined, host, { contentType: 'application/json', bytes: Buffer.alloc(MOST_ACTION_BYTES + 1, 32) })).status, 413);
    assert.throws(() => settingsOf({ ...settings(d.address), actions: 'site actions' }), /actions/);
  } finally { d.server.close(); }
});

test('over node:http, a POST an action row names is the site\'s even under a passed-on path; other POSTs there are passed on', async () => {
  const seen: string[] = [];
  const other = http.createServer((request, response) => { seen.push(`${request.method} ${request.url}`); response.end('{"other":true}'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const server = http.createServer(handlerOf(await siteOn(d.address, { actions: 'site_actions' }), [{ name: 'the old program', address: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, paths: ['/checkout', '/target'] }]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sent = await fetch(`${at}/checkout`, { method: 'POST', redirect: 'manual', body: 'offerId=offer%3Aone', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-host': 'site.example.test' } });
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('location'), 'https://pay.example.test/session/1');
    assert.equal((await fetch(`${at}/target/other`, { method: 'POST', body: '{}' })).status, 200);
    assert.deepEqual(seen, ['POST /target/other'], 'only the POST no action row names went to the other program');
  } finally { server.close(); other.close(); d.server.close(); }
});
