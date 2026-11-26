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
import type { Settings, SiteParts } from '../do-work/serve.ts';
import { StoreFiles } from '../do-work/served-files.ts';

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
  { path: '/signup', host: null, access: 'public', tool: 'tool:say-an-outcome', failed: 'Nothing was kept.', input: { outcome: { $: 'body', key: 'pick' }, email: { $: 'body', key: 'email' } },
    answer: { redirect_to: '/signup/check-inbox' }, next: [{ tool: 'tool:keep-a-lead', input: {} }], then: { tool: 'tool:keep-a-lead', input: {} },
    outcomes: { outcome: { invalid_email: { redraw: 400, words: 'That address does not look right.' }, too_many: { redraw: 429, words: 'Too many sign-ups from here.' } } } },
  { path: '/bad-outcomes', host: null, access: 'public', tool: 'tool:say-an-outcome', failed: 'x', input: {}, answer: { json: ['outcome'] }, outcomes: { outcome: { no: { redraw: 302, words: 'x' } } } },
  { path: '/checkout', host: null, access: 'public', tool: 'tool:start-a-checkout', failed: 'Checkout could not start.', answer: { redirect_from: 'redirectUrl' }, input: {
    offerId: { $: 'body', key: 'offerId' }, amount: { $: 'number', of: { $: 'body', key: 'amount' } }, email: { $: 'member', claim: 'email' },
    visitor: { $: 'cookie', name: 'visitor', when: { cookie: 'consent', is: 'granted' } }, offers: { $: 'rows', database: 'a_site_for_who_runs_it', sql: 'SELECT * FROM offers WHERE id = $1', params: [{ $: 'body', key: 'offerId' }] },
    success_url: { $: 'origin', then: '/welcome' }, attempt: { $: 'first', of: [{ $: 'body', key: 'attempt' }, { $: 'new_id' }] }, at: { $: 'now' },
    consent: { billing: { $: 'boolean', of: { $: 'body', key: 'consent.billing' } }, legal: true }, customer: { email: { $: 'member', claim: 'email' } },
  } },
  { path: '/book/:offer', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'Booking could not start.', input: { offer: { $: 'path', name: 'offer' }, email: { $: 'body', key: 'email' } },
    answer: { redirect_to: { $: 'url', base: 'https://book.example.test/call', query: { email: { $: 'body', key: 'email' }, name: { $: 'body', key: 'name' }, kept: { $: 'answer', key: 'kept' } } } } },
  { path: '/members-only', host: null, access: 'members', tool: 'tool:keep-a-lead', failed: 'No.', input: {}, answer: { json: ['kept'] } },
  { path: '/fails', host: null, access: 'public', tool: 'tool:fails', failed: 'That did not work.', input: {}, answer: { json: ['x'] } },
  { path: '/bad', host: null, access: 'public', tool: 'tool:x', failed: 'x', input: { a: { $: 'shell', run: 'rm' } }, answer: { json: ['x'] } },
  { path: '/target/state', host: null, method: 'GET', access: 'public', tool: 'tool:keep-a-lead', failed: 'No state.', input: { checkout: { $: 'query', key: 'checkout' } }, answer: { json: ['kept'] } },
  { path: '/observe/visit', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'Not kept.', input: {
    visitor: { $: 'when', cookie: 'consent', is: 'granted', then: { $: 'first', of: [{ $: 'cookie', name: 'jv' }, { $: 'new_id' }] } },
    origin: { $: 'address', of: { $: 'body', key: 'href' }, part: 'origin' }, path: { $: 'address', of: { $: 'body', key: 'href' }, part: 'path' },
    query: { $: 'address', of: { $: 'body', key: 'href' }, part: 'query' }, from: { $: 'address', of: { $: 'body', key: 'referrer' }, part: 'host' },
  }, answer: { json: ['kept'], cookie: { name: 'jv', value: { $: 'input', key: 'visitor' }, max_age_days: 395 } } },
  { path: '/observe/listed', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'x', input: { params: [{ $: 'new_id' }] }, answer: { json: ['kept'], cookie: { name: 'n', value: { $: 'input', key: 'params.0' }, max_age_days: 1, http_only: false } } },
  { path: '/chain', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'x', answer: { json: ['kept'] }, input: {
    event: { $: 'tool', tool: 'tool:echo', input: { busy: { $: 'tool', tool: 'tool:echo', input: { n: 1 }, key: 'echo.n' } }, key: 'echo' },
    account: { $: 'rows', sql: 'SELECT id FROM offers', key: '0.id' },
  } },
  { path: '/chain-undo', host: null, access: 'public', tool: 'tool:fails', failed: 'Not booked.', answer: { json: ['x'] },
    input: { event: { $: 'tool', tool: 'tool:echo', input: { id: 'ev-1' }, key: 'echo' } }, undo: { tool: 'tool:echo', input: { cancel: { $: 'input', key: 'event.id' } } } },
  { path: '/bad-undo', host: null, access: 'public', tool: 'tool:x', failed: 'x', input: {}, answer: { json: ['x'] }, undo: { tool: 'not a tool' } },
  { path: '/go/:code', host: null, method: 'GET', access: 'public', tool: 'tool:echo', failed: 'That link is not open.', input: {
    status: { $: 'pick', of: { $: 'path', name: 'code' }, from: { open: 302, gone: 404, busy: 503, odd: 99, wild: 302, evil: 302 }, else: 400 },
    location: { $: 'pick', of: { $: 'path', name: 'code' }, from: { open: 'https://elsewhere.example.test/x', wild: 'javascript:alert(1)' } },
    set_cookie: { $: 'pick', of: { $: 'path', name: 'code' }, from: { open: 'go=1; Path=/', evil: 'go=1\r\nx: 1' } },
    retry_after: { $: 'pick', of: { $: 'path', name: 'code' }, from: { busy: 30 } },
  }, answer: { reply: { status: { $: 'answer', key: 'echo.status' }, headers: { location: { $: 'answer', key: 'echo.location' }, 'set-cookie': { $: 'answer', key: 'echo.set_cookie' }, 'retry-after': { $: 'answer', key: 'echo.retry_after' } } } } },
  { path: '/newsletter', host: null, access: 'public', tool: 'tool:echo', failed: 'The mail could not be sent.', input: { outcome: { $: 'body', key: 'outcome' }, attempt: 'a-1' },
    next: [{ when: { $: 'pick', of: { $: 'answer', key: 'echo.outcome' }, from: { send_confirmation: true }, else: false }, tool: 'tool:fails', input: { mail: { $: 'answer', key: 'echo.attempt' } },
      failed: { tool: 'tool:echo', input: { action: 'send_failed', attempt: { $: 'answer', key: 'echo.attempt' } } } }],
    answer: { reply: { status: { $: 'pick', of: { $: 'answer', key: 'echo.outcome' }, from: { invalid_email: 400, too_many: 429 }, else: 200 }, json: ['echo'] } } },
  { path: '/busy', host: null, access: 'public', tool: 'tool:busy', failed: 'Not now.', input: {}, answer: { json: ['x'] } },
  { path: '/from-where', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: { network: { $: 'network' } }, answer: { json: ['echo'] } },
  { path: '/signed', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: { payload: { $: 'raw_body' }, signature_header: { $: 'header', name: 'stripe-signature' } }, answer: { json: ['echo'] } },
  { path: '/reads-a-cookie-header', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: { c: { $: 'header', name: 'cookie' } }, answer: { json: ['echo'] } },
  { path: '/reads-an-odd-header', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: { c: { $: 'header', name: 'Stripe-Signature' } }, answer: { json: ['echo'] } },
  { path: '/not-yours', host: null, access: 'public', tool: 'tool:not-yours', failed: 'This was not kept for you.', input: {}, answer: { json: ['x'] } },
  { path: '/bad-reply', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: {}, answer: { reply: { status: 200, headers: { 'x-forwarded-for': 'a' } } } },
  { path: '/bad-next', host: null, access: 'public', tool: 'tool:echo', failed: 'x', input: {}, answer: { json: ['echo'] }, next: [{ tool: 'tool:echo', input: {}, also: 1 }] },
  { path: '/refuses-tells', host: null, access: 'public', tool: 'tool:refuses', failed: 'That answer was not kept.', input: {}, answer: { json: ['next'] }, says_why: true },
  { path: '/refuses-quiet', host: null, access: 'public', tool: 'tool:refuses', failed: 'That answer was not kept.', input: {}, answer: { json: ['next'] } },
  { path: '/refuses-nested', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'Not kept.', input: { a: { $: 'tool', tool: 'tool:refuses', input: {} } }, answer: { json: ['kept'] }, says_why: true },
  { path: '/with-then', host: null, access: 'public', tool: 'tool:start-a-checkout', failed: 'x', answer: { json: ['sessionId'] },
    input: {
      code: { $: 'tool', tool: 'tool:echo', input: { code: 'C1' }, key: 'echo.code' }, again: { $: 'tool', tool: 'tool:echo', input: { code: 'C1' }, key: 'echo' },
      touch: { $: 'address', of: { $: 'referer' }, part: 'query', key: 't' },
    },
    then: { tool: 'tool:keep-a-lead', input: { session: { $: 'answer', key: 'sessionId' }, touch: { $: 'input', key: 'touch' } } } },
  { path: '/then-after-fail', host: null, access: 'public', tool: 'tool:fails', failed: 'x', answer: { json: ['x'] }, input: {}, then: { tool: 'tool:keep-a-lead', input: {} } },
  { path: '/then-fails', host: null, access: 'public', tool: 'tool:keep-a-lead', failed: 'x', answer: { json: ['kept'] }, input: {}, then: { tool: 'tool:fails', input: {} } },
  { path: '/bad-key', host: null, access: 'public', tool: 'tool:x', failed: 'x', answer: { json: ['x'] }, input: { a: { $: 'address', of: 'https://a.example.test/', part: 'path', key: 't' } } },
  { path: '/bad-cookie', host: null, access: 'public', tool: 'tool:x', failed: 'x', input: {}, answer: { json: ['x'], cookie: { name: 'a b', value: 'x', max_age_days: 1 } } },
  { path: '/target/state', host: null, method: 'PUT', access: 'public', tool: 'tool:x', failed: 'x', input: {}, answer: { json: ['x'] } },
  // A tool that refuses with a status of its own (tool:refuses-with: the path's code), one that says why and one that does not.
  { path: '/refuses-with/:code', host: null, access: 'public', tool: 'tool:refuses-with', failed: 'Not kept.', input: { code: { $: 'path', name: 'code' } }, answer: { json: ['x'] }, says_why: true },
  { path: '/keep-signed-out/:code', host: null, access: 'public', tool: 'tool:refuses-with', failed: 'Sign in to keep your answers.', input: { code: { $: 'path', name: 'code' } }, answer: { json: ['x'] } },
  { path: '/go-json/:code', host: null, method: 'GET', access: 'public', tool: 'tool:echo', failed: 'That link is not open.', input: {
    status: { $: 'pick', of: { $: 'path', name: 'code' }, from: { gone: 404 }, else: 200 },
  }, answer: { reply: { status: { $: 'answer', key: 'echo.status' }, json: ['echo'] } } },
];

const LOOK = [{ name: 'theme', value: 'paper' }, { name: 'font-face.body-400', value: 'Body Sans|400|normal|/assets/fonts/body.woff2' }, { name: 'brand-ink', value: '#123456' },
  { name: 'words.form-failed', value: 'The site could not take that. Try again soon.' }];

// The site_settings rows the door answers (a test sets them).
let siteSettingsRows: Record<string, unknown>[] = [];

// What tool:read-the-site-head answers (a test changes it: other markup, or no read_from).
const HEAD_ANSWER = { head: '<script>window.consentFirst=1</script>', body_start: '<noscript>tags off</noscript>' };
let headAnswer: Record<string, unknown> = HEAD_ANSWER;

// The clips tool:read-the-listed-files lists (each as its .mp4 and .jpg); a test changes it to withdraw one.
let listedClips: string[] = [];

// An engine door on loopback: tools:run of run-sql answers the rows, read-a-greeting answers a Text screen's props, and every
// call's pass and tool are written down.
// What a database's row_changes answers the front's one ask (CHANGES_SQL): set by a test; null answers the ask with an error,
// as a database whose row_changes the site's login cannot read.
type RowChanges = { newest: string; changed: string[]; told: string[] } | null;

async function door(look = LOOK, pages = PAGES, rowChanges: { now: RowChanges } = { now: null }) {
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
        if (sql.includes('FROM row_changes')) {
          if (!rowChanges.now) return response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 1, error: 'permission denied for table row_changes', result: null } } }));
          result = { rows: [{ newest: rowChanges.now.newest, changed: rowChanges.now.changed, told: rowChanges.now.told, xmin: '700' }] };
          response.setHeader('content-type', 'text/event-stream');
          return response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 0, result } } })}\n\n`);
        }
        result = { rows: sql.includes('FROM site_settings') ? siteSettingsRows.filter(row => row.site === (run.input as { params?: unknown[] }).params?.[0]) : sql.includes('FROM "site_actions"') ? ACTIONS : sql.includes('FROM offers') ? [{ id: 'offer:one', params: run.input.params }] : sql.includes('FROM pages') ? pages : sql.includes('FROM site_look') ? look : [{ slug: 'first' }, { slug: 'second one' }] };
      } else if (run.tool === 'tool:start-a-checkout') {
        result = { redirectUrl: 'https://pay.example.test/session/1', sessionId: 's1' };
      } else if (run.tool === 'tool:refuses') {
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 1, error: 'An answer is written as text.', result: null } } }));
      } else if (run.tool === 'tool:refuses-with') {
        // A tool's refusal as serve-steps.ts leaves it: one JSON line { error, status }, or plain words when it crashed; a
        // door that timed out answers 504 itself.
        const code = String((run.input as { code?: unknown }).code);
        if (code === '504') { response.writeHead(504, { 'content-type': 'text/plain' }); return response.end('Timed out.'); }
        const error = code === 'crash' ? 'TypeError: Cannot read properties of undefined' : JSON.stringify({ error: `Refused with ${code}.`, status: Number(code) });
        return response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: run.tool, exit_code: 1, error, result: null } } }));
      } else if (run.tool === 'tool:not-yours') {
        response.writeHead(403, { 'content-type': 'text/plain' });
        return response.end('This pass may not run that.');
      } else if (run.tool === 'tool:busy') {
        response.writeHead(503, { 'content-type': 'text/plain' });
        return response.end('Not ready.');
      } else if (run.tool === 'tool:echo') {
        result = { echo: run.input };
      } else if (run.tool === 'tool:keep-a-lead') {
        result = { kept: 1 };
      } else if (run.tool === 'tool:read-the-site-head') {
        result = headAnswer;
      } else if (run.tool === 'tool:say-an-outcome') {
        result = { outcome: (run.input as { outcome?: string }).outcome ?? 'check_inbox' };
      } else if (run.tool === 'tool:read-the-listed-files') {
        result = { clips: listedClips.map(name => ({ cut_url: `/published-clips/${name}.mp4`, picture_url: `/published-clips/${name}.jpg` })) };
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

async function siteOn(address: string, more: Record<string, unknown> = {}, parts: Partial<SiteParts> = {}) {
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
    ...parts,
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
    const calls = d.calls.length;
    assert.equal((await site.answer('GET', '/notes/no-such-note', undefined)).status, 404, 'a slug its collection does not hold is not a page');
    assert.equal(d.calls.length, calls, 'and its tool is never asked');
    assert.equal((await site.answer('GET', '/notes/second%20one', undefined)).status, 200, 'a held slug, sent encoded, is a page');
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
  assert.deepEqual(listen, ['127.0.0.1:0']);
  assert.deepEqual(settingsOf(rest).listen, ['127.0.0.1:18440']);
  assert.deepEqual(settingsOf({ ...rest, listen: ['unix:/run/a/http.sock', 'unix:/run/b/http.sock'] }).listen, ['unix:/run/a/http.sock', 'unix:/run/b/http.sock'], 'one socket per host name');
  assert.throws(() => settingsOf({ ...rest, listen: [] }), /listen/);
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
    const pageAt = (_host: string, pathname: string) => (pathname === '/sign-in/kept' ? '/sign-in/kept' : pathname === '/' ? '/' : null);
    assert.equal(passOnFor(on, 'site.example.test', '/sign-in/kept', pageAt), null, 'a page row under a passed-on path answers instead');
    assert.equal(passOnFor(on, 'site.example.test', '/sign-in/done', pageAt)?.name, 'sign-in', 'a path with no page row of its own is still passed on');
    assert.equal(passOnFor(on, 'app.site.example.test', '/', pageAt)?.name, 'members', 'an exact path is always passed on, whatever page row matches');
    assert.equal(passOnFor([{ name: 'all', address: 'http://c', paths: ['/target'] }], 'site.example.test', '/target', () => '/target')?.name, 'all', 'a page row no longer than the passed-on path does not take it');
  } finally { server.close(); signIn.close(); d.server.close(); }
});

test('exact pass_on paths, and the paths of an entry marked first, reach the other program ahead of the site\'s own action and page rows', async () => {
  const seen: { method?: string; url?: string; body: string }[] = [];
  const old = http.createServer((request, response) => {
    let body = '';
    request.on('data', c => { body += c; });
    request.on('end', () => { seen.push({ method: request.method, url: request.url, body }); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"old":true}'); });
  });
  await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const oldAt = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  // Every write path of the fixture's action rows, passed on exactly, and the members pages ahead of their page rows; the
  // address is named once in addresses, as a computer's setup fills it.
  const writes = ['/book/call', '/observe/visit', '/target/state', '/chain', '/with-then', '/before-booking/offer:a-call'];
  const s = settings(d.address, { addresses: { 'old-program': oldAt }, pass_on: [
    { name: 'the old program (writes)', address: 'named:old-program', exact: writes },
    { name: 'the old program (members)', address: 'named:old-program', paths: ['/members'], first: true },
    { name: 'the old program (the rest under /target)', address: 'named:old-program', paths: ['/target'] },
  ] });
  assert.deepEqual(s.pass_on.map(on => on.address), [oldAt, oldAt, oldAt], 'a named address is filled from addresses');
  const site = await siteOn(d.address, { actions: 'site_actions' });
  const server = http.createServer(handlerOf(site, s.pass_on));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ['/book/call', '/observe/visit', '/chain', '/with-then']) {
      assert.equal(site.acts('POST', 'site.example.test', path), true, `${path} has an action row`);
      const answer = await fetch(`${at}${path}`, { method: 'POST', body: '{"email":"a@example.test"}', headers: { 'content-type': 'application/json' } });
      assert.deepEqual(await answer.json(), { old: true }, `a POST to ${path} reaches the other program`);
    }
    assert.deepEqual(await (await fetch(`${at}/target/state?checkout=x`)).json(), { old: true }, 'a GET action row\'s exact path is passed on too');
    assert.deepEqual(await (await fetch(`${at}/before-booking/offer:a-call`, { method: 'POST', body: 'x' })).json(), { old: true }, 'an exact path may hold a colon');
    assert.equal(site.pageFor('site.example.test', '/members'), '/members', 'the members page row is there');
    assert.deepEqual(await (await fetch(`${at}/members`)).json(), { old: true }, 'under an entry marked first, the page row does not take the path');
    assert.deepEqual(seen.map(({ method, url }) => `${method} ${url}`), ['POST /book/call', 'POST /observe/visit', 'POST /chain', 'POST /with-then', 'GET /target/state?checkout=x', 'POST /before-booking/offer:a-call', 'GET /members']);
    assert.equal(seen[0].body, '{"email":"a@example.test"}', 'the body goes on whole');
    assert.equal(passOnFor(s.pass_on, 'site.example.test', '/target/kept', () => null, true), null, 'under a plain path, an action row is the site\'s');
    assert.throws(() => settings(d.address, { pass_on: [{ name: 'x', address: 'named:nowhere', exact: ['/a'] }] }), /names the address nowhere, which addresses does not hold/);
    assert.throws(() => settings(d.address, { addresses: { a: 'named:b' } }), /never another name/);
    assert.throws(() => settings(d.address, { pass_on: [{ name: 'x', address: oldAt, paths: ['/a'], first: 'yes' }] }), /pass_on lists/);
  } finally { server.close(); old.close(); d.server.close(); }
});

test('a command door\'s origin and key are checked', () => {
  for (const bad of [
    { address: 'cli:example-site', origin: '127.0.0.1:7190' },
    { address: 'cli:example-site', origin: 'http://127.0.0.1:7190/mcp' },
    { address: 'cli:example-site', key_credential: 5 },
    { address: 'http://127.0.0.1:1', pass_credential: 'site-door-pass', origin: 'http://127.0.0.1:7190' },
    { address: 'http://127.0.0.1:1', pass_credential: 'site-door-pass', key_credential: 'owner-key' },
  ]) assert.throws(() => settings('http://127.0.0.1:1', { door: bad }), /door is/);
  assert.equal(settings('http://127.0.0.1:1', { door: { address: 'cli:example-site', pins: [], origin: 'http://127.0.0.1:7190', key_credential: 'owner-key' } }).door.origin, 'http://127.0.0.1:7190');
});

test('a reply answers as the tool says (status, location, set-cookie, retry-after or none), and a next step that fails runs its failed step and fails the request', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address, { actions: 'site_actions' });
    const host = 'site.example.test';
    const get = (path: string) => site.act(path, undefined, host, { method: 'GET', bytes: Buffer.alloc(0) });
    const open = await get('/go/open');
    assert.equal(open.status, 302);
    assert.equal(open.headers.location, 'https://elsewhere.example.test/x');
    assert.deepEqual((open.headers as Record<string, unknown>)['set-cookie'], ['go=1; Path=/']);
    assert.equal(open.body, '', 'no json named, no body');
    const gone = await get('/go/gone');
    assert.equal(gone.status, 404, 'the tool\'s 404 is the visitor\'s, not a 502');
    assert.equal(gone.headers.location, undefined, 'a header whose value gives nothing is left out');
    const busy = await get('/go/busy');
    assert.equal(busy.status, 503);
    assert.equal(busy.headers['retry-after'], '30');
    for (const code of ['odd', 'wild', 'evil']) assert.equal((await get(`/go/${code}`)).status, 502, `${code}: a status out of range, a location no visitor may be sent to, or a header with a line break fails the row`);
    const json = (fields: Record<string, string>) => ({ contentType: 'application/json', bytes: Buffer.from(JSON.stringify(fields)) });
    d.calls.length = 0;
    const done = await site.act('/newsletter', undefined, host, json({ outcome: 'subscribed' }));
    assert.equal(done.status, 200);
    assert.deepEqual(JSON.parse(String(done.body)).echo.outcome, 'subscribed');
    assert.deepEqual(d.calls.map(call => call.run.tool), ['tool:echo'], 'a next step whose when is not true does not run');
    assert.equal((await site.act('/newsletter', undefined, host, json({ outcome: 'too_many' }))).status, 429, 'pick maps the outcome to its status');
    d.calls.length = 0;
    const unsent = await site.act('/newsletter', undefined, host, json({ outcome: 'send_confirmation' }));
    assert.equal(unsent.status, 502, 'the send failed, so the visitor gets the row\'s failure');
    assert.deepEqual(JSON.parse(String(unsent.body)), { error: 'The mail could not be sent.' });
    assert.deepEqual(d.calls.map(call => [call.run.tool, call.run.input]), [
      ['tool:echo', { outcome: 'send_confirmation', attempt: 'a-1' }], ['tool:fails', { mail: 'a-1' }], ['tool:echo', { action: 'send_failed', attempt: 'a-1' }],
    ], 'the failed step runs with what the row\'s tool answered');
    assert.equal((await site.act('/bad-reply', undefined, host, json({}))).status, 404, 'a reply naming a header outside the list is set aside');
    assert.equal((await site.act('/busy', undefined, host, json({}))).status, 503, 'a busy door is told as 503, so a page tries again, never a 502 refusal');
    assert.equal((await site.act('/bad-next', undefined, host, json({}))).status, 404, 'a next step with an unknown key is set aside');
  } finally { d.server.close(); }
});

// The FormOutcome part a redrawn page's tree carries (the tree JSON the browser draws again), or null.
function outcomeOf(page: string): Record<string, unknown> | null {
  const json = /<script[^>]*id="root-tree"[^>]*>([\s\S]*?)<\/script>/.exec(page)?.[1];
  const find = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') return null;
    const at = node as { module?: string; props?: Record<string, unknown>; children?: unknown[]; nodes?: unknown[] };
    if (at.module?.endsWith('show/FormOutcome.tsx#FormOutcome')) return at.props ?? null;
    for (const child of [...(at.children ?? []), ...(at.nodes ?? [])]) { const found = find(child); if (found) return found; }
    return null;
  };
  return json ? find(JSON.parse(json)) : null;
}

test('a browser form post that fails, by its action\'s tool, a refused right or another program, gets the page it came from again with the words at its form and what was typed', async () => {
  const old = http.createServer((request, response) => {
    if (request.url === '/target/pay') { response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'kept=1; Path=/' }); return response.end('{"redirect":"https://pay.example.test/s/1"}'); }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":"Something went wrong. Please try again."}');
  });
  await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const oldAt = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  const site = await siteOn(d.address, { actions: 'site_actions' });
  const server = http.createServer(handlerOf(site, [
    { name: 'the old program', address: oldAt, exact: ['/target/pay', '/target/broken'] },
    { name: 'a program that is down', address: 'http://127.0.0.1:1', exact: ['/target/down'] },
  ]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const typed = 'name=Ana+Lee&email=ana%40example.test&password=hunter2&card_number=4242&offerId=offer%3Aone';
    const formPost = (path: string, { accept = 'text/html,application/xhtml+xml', referer = 'https://site.example.test/?plan=a' } = {}) => fetch(`${at}${path}`, { method: 'POST', redirect: 'manual', body: typed,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept, referer, 'x-forwarded-host': 'site.example.test' } });
    const kept = { name: 'Ana Lee', email: 'ana@example.test', offerId: 'offer:one' };
    const redrawn = async (answer: Response, status: number, message: string, action: string) => {
      assert.equal(answer.status, status, `${action}: the failure's status is kept`);
      assert.match(answer.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(answer.headers.get('cache-control'), 'no-store', `${action}: a redrawn page is never kept`);
      const page = await answer.text();
      assert.match(page, /<title>Home<\/title>/, `${action}: the page it was posted from, drawn again`);
      assert.match(page, /Hello, everyone/, `${action}: with its own tool answers`);
      assert.deepEqual(outcomeOf(page), { action, title: 'That did not go through', message, values: kept }, `${action}: the words at its form and what was typed, never a password or card`);
      assert.equal(page.includes('{"error"') || page.includes('hunter2') || page.includes('4242'), false, `${action}: never raw JSON, never a secret typed`);
    };
    // 1. The action row's own tool fails: its row's `failed` words.
    await redrawn(await formPost('/fails'), 502, 'That did not work.', '/fails');
    // 2. A refused right (the door's 403): the row's words, status 403.
    await redrawn(await formPost('/not-yours'), 403, 'This was not kept for you.', '/not-yours');
    // 3. Another program answers a JSON 500: the site's own words row, never the program's words.
    await redrawn(await formPost('/target/broken'), 500, 'The site could not take that. Try again soon.', '/target/broken');
    // A program that does not answer at all is the same page, 502.
    await redrawn(await formPost('/target/down'), 502, 'The site could not take that. Try again soon.', '/target/down');
    // A Referer on another host is no page of this site: the site's page of the same words, with a way back to this site.
    const lost = await formPost('/target/broken', { referer: 'https://elsewhere.example.test/nowhere?x=1' });
    assert.equal(lost.status, 500);
    const words = await lost.text();
    assert.match(words, /That did not go through/);
    assert.match(words, /The site could not take that\. Try again soon\./);
    assert.match(words, /href="\/"/, 'a way back to this site: another host\'s path is no page of this site');
    assert.equal(outcomeOf(words), null);
    const pay = await formPost('/target/pay');
    assert.equal(pay.status, 303, 'a JSON answer naming an address sends the browser there');
    assert.equal(pay.headers.get('location'), 'https://pay.example.test/s/1');
    assert.deepEqual(pay.headers.getSetCookie(), ['kept=1; Path=/'], 'the program\'s cookies are kept');
    const script = await formPost('/target/broken', { accept: 'application/json' });
    assert.deepEqual(await script.json(), { error: 'Something went wrong. Please try again.' }, 'a page script asking for JSON gets the JSON as it is');
    const ownScript = await site.act('/fails', undefined, 'site.example.test', { contentType: 'application/json', bytes: Buffer.from('{}') });
    assert.deepEqual(JSON.parse(String(ownScript.body)), { error: 'That did not work.' }, 'a JSON post to an action row gets JSON');
  } finally { server.close(); old.close(); d.server.close(); }
  // A site with no words row: the tool's own words.
  const plain = await door(LOOK.filter(row => !row.name.startsWith('words.')));
  try {
    const site = await siteOn(plain.address, { actions: 'site_actions' });
    const failed = await site.failedForm(502, 'site.example.test', { action: '/somewhere', words: null, referer: 'https://site.example.test/', cookie: undefined, values: {} });
    assert.equal(outcomeOf(String(failed.body))?.message, 'Nothing was sent. Check what you typed and try again in a minute.');
  } finally { plain.server.close(); }
});

test('a browser form posted on to a program marked form_as_json reaches it as the JSON its own page script sent, and its JSON address is a 303', async () => {
  const seen: { type: string | undefined; body: unknown }[] = [];
  // The old checkout as it is: it JSON.parses the body, and answers 500 when that fails.
  const old = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try {
        seen.push({ type: request.headers['content-type'], body: JSON.parse(body) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"redirect":"https://pay.example.test/s/1"}');
      } catch {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end('{"error":"Something went wrong. Please try again."}');
      }
    });
  });
  await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const site = await siteOn(d.address, { actions: 'site_actions' });
  const oldAt = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
  const server = http.createServer(handlerOf(site, [
    { name: 'the old checkout', address: oldAt, exact: ['/target/checkout.start-checkout'], form_as_json: true },
    { name: 'a program that reads forms', address: oldAt, exact: ['/target/as-sent'] },
  ]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The live checkout form's exact fields.
    const fields = 'consent.billing=true&consent.legal=true&customerSelectedAmountCents=9900&offerId=offer%3Aone&priceOptionId=price%3Aone%3Amonthly&note=007';
    const post = (path: string, body: string | FormData, type?: string) => fetch(`${at}${path}`, { method: 'POST', redirect: 'manual', body,
      headers: { ...(type ? { 'content-type': type } : {}), accept: 'text/html', referer: 'https://site.example.test/', 'x-forwarded-host': 'site.example.test' } });
    const sent = await post('/target/checkout.start-checkout', fields, 'application/x-www-form-urlencoded');
    assert.equal(sent.status, 303, 'the program\'s JSON address sends the browser on');
    assert.equal(sent.headers.get('location'), 'https://pay.example.test/s/1');
    assert.equal(seen[0].type, 'application/json');
    assert.deepEqual(seen[0].body, { consent: { billing: true, legal: true }, customerSelectedAmountCents: 9900, offerId: 'offer:one', priceOptionId: 'price:one:monthly', note: '007' },
      'dotted names nested, plain numbers numbers, true a boolean, "007" kept as text');
    const multipart = new FormData();
    multipart.append('consent.billing', 'true');
    multipart.append('tag', 'a');
    multipart.append('tag', 'b');
    assert.equal((await post('/target/checkout.start-checkout', multipart)).status, 303);
    assert.deepEqual(seen[1].body, { consent: { billing: true }, tag: ['a', 'b'] }, 'a multipart form too, a repeated name a list');
    assert.equal((await post('/target/as-sent', fields, 'application/x-www-form-urlencoded')).status, 500, 'an entry not marked passes the form as it came');
  } finally { server.close(); old.close(); d.server.close(); }
});

test('a form that cannot be JSON (a file, clashing names) is passed as it came', async () => {
  const { formJsonOf } = await import('../do-work/serve.ts');
  assert.equal(await formJsonOf('application/x-www-form-urlencoded', Buffer.from('a=1&a.b=2')), null);
  assert.equal(await formJsonOf('application/x-www-form-urlencoded', Buffer.from('__proto__.x=1')), null);
  const withFile = new FormData();
  withFile.append('picture', new Blob(['bytes']), 'a.jpg');
  const encoded = new Response(withFile);
  assert.equal(await formJsonOf(encoded.headers.get('content-type') ?? '', Buffer.from(await encoded.arrayBuffer())), null);
});

test('each kind of row is kept until a row change names its table: an unchanged refresh asks once, a view reads no row, a change shows on the next view', async () => {
  const told = ['site_settings', 'pages', 'site_look', 'site_actions', 'notes'];
  const changes: { now: RowChanges } = { now: { newest: '10', changed: [], told } };
  const pages = PAGES.map(page => ({ ...page }));
  const d = await door(LOOK, pages, changes);
  const lines: string[] = [];
  try {
    const sqlOf = () => d.calls.filter(call => call.run.tool === 'tool:run-sql-in-my-database').map(call => String((call.run.input as { sql: string }).sql));
    const site = await siteOn(d.address, { actions: 'site_actions' }, { log: line => lines.push(line) });
    const first = sqlOf();
    assert.ok(first.some(sql => sql.includes('FROM pages')) && first.some(sql => sql.includes('FROM site_look')) && first.some(sql => sql.includes('FROM "site_actions"')) && first.some(sql => sql.includes('FROM "notes"')), 'the first read reads every kind');
    d.calls.length = 0;
    await site.read();
    assert.deepEqual(sqlOf().map(sql => sql.includes('FROM row_changes')), [true], 'an unchanged refresh is one ask and nothing else');
    d.calls.length = 0;
    for (const path of ['/', '/notes/first', '/notes/first']) assert.equal((await site.answer('GET', path, undefined, 'site.example.test')).status, 200, path);
    assert.deepEqual(sqlOf(), [], 'a view reads no row');
    const home = pages.find(page => page.path === '/')!;
    home.title = 'Home, changed';
    changes.now = { newest: '11', changed: ['pages'], told };
    d.calls.length = 0;
    await site.read();
    assert.deepEqual(sqlOf().map(sql => (sql.includes('FROM row_changes') ? 'ask' : sql.includes('FROM pages') ? 'pages' : sql)), ['ask', 'pages'], 'a change to pages reads pages again, and only pages');
    assert.match(String((await site.answer('GET', '/', undefined, 'site.example.test')).body), /<title>Home, changed<\/title>/, 'the change shows on the next view');
    changes.now = { newest: '11', changed: [], told: told.filter(table => table !== 'site_look') };
    d.calls.length = 0;
    await site.read();
    assert.deepEqual(sqlOf().map(sql => (sql.includes('FROM row_changes') ? 'ask' : sql.includes('FROM site_look') ? 'look' : sql)), ['ask', 'look'], 'a table that tells no changes is read every refresh, as before');
    changes.now = null;
    d.calls.length = 0;
    await site.read();
    await site.read();
    assert.equal(sqlOf().filter(sql => sql.includes('FROM pages')).length, 2, 'a row_changes the login cannot read: every kind every refresh, never kept stale');
    assert.equal(lines.filter(line => line.startsWith('The row changes could not be read')).length, 1, 'said once');
  } finally { d.server.close(); }
});

test('the site head is kept like a kind of row: read again only when its call changed or a change names a table it read', async () => {
  const told = ['pages', 'site_look', 'site_head', 'site_head_parts'];
  const changes: { now: RowChanges } = { now: { newest: '10', changed: [], told } };
  const d = await door(LOOK, PAGES, changes);
  const head = { tool: 'tool:read-the-site-head', input: { database: 'a_site_for_who_uses_it', site: 'a-site' } };
  const heads = () => d.calls.filter(call => call.run.tool === head.tool).length;
  const asked = () => d.calls.filter(call => String((call.run.input as { sql?: string }).sql ?? '').includes('FROM row_changes')).map(call => (call.run.input as { params: unknown[] }).params[1]);
  try {
    headAnswer = { ...HEAD_ANSWER, read_from: ['site_head', 'site_head_parts'] };
    const site = await siteOn(d.address, { site_head: head });
    assert.equal(heads(), 1, 'the first read reads the head');
    d.calls.length = 0;
    await site.read();
    assert.equal(heads(), 0, 'an unchanged refresh runs no head');
    assert.ok((asked()[0] as string[]).includes('site_head_parts'), 'the one ask names the head\'s tables too');
    assert.match(String((await site.answer('GET', '/', undefined)).body), /window\.consentFirst=1/, 'the kept head still opens every page');
    headAnswer = { head: '<script>window.consentSecond=1</script>', body_start: '', read_from: ['site_head', 'site_head_parts'] };
    changes.now = { newest: '11', changed: ['site_head_parts'], told };
    d.calls.length = 0;
    await site.read();
    assert.equal(heads(), 1, 'a change to a table the head read reads it again');
    assert.match(String((await site.answer('GET', '/', undefined)).body), /window\.consentSecond=1/, 'and the change shows on the next view');
    changes.now = { newest: '11', changed: [], told: told.filter(table => table !== 'site_head') };
    d.calls.length = 0;
    await site.read();
    await site.read();
    assert.equal(heads(), 2, 'a head table that tells no changes: the head is read every refresh, as before');
    changes.now = null;
    d.calls.length = 0;
    await site.read();
    assert.equal(heads(), 1, 'a row_changes the login cannot read: the head is read every refresh');
    changes.now = { newest: '12', changed: ['site_head'], told };
    headAnswer = HEAD_ANSWER;
    d.calls.length = 0;
    await site.read();
    changes.now = { newest: '12', changed: [], told };
    await site.read();
    await site.read();
    assert.equal(heads(), 3, 'a head that says no read_from is read every refresh');
    headAnswer = { ...HEAD_ANSWER, read_from: ['site_head', 'site_head_parts'] };
    const elsewhere = await siteOn(d.address, { site_head: { ...head, input: { ...head.input, database: 'another_database' } } });
    d.calls.length = 0;
    await elsewhere.read();
    assert.equal(heads(), 1, 'a head of another database than the pages\' is read every refresh: their changes are not the ones asked');
  } finally {
    headAnswer = HEAD_ANSWER;
    d.server.close();
  }
});

test('the network source is the address the site\'s own front web server saw: the last X-Forwarded-For entry, else the connection', async () => {
  const d = await door();
  const site = await siteOn(d.address, { actions: 'site_actions' });
  const server = http.createServer(handlerOf(site));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ask = async (headers: Record<string, string>) => (await (await fetch(`${at}/from-where`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'site.example.test', ...headers } })).json()).echo?.network;
    assert.equal(await ask({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }), '203.0.113.9', 'a visitor writes the first entries; the last is the front server\'s');
    assert.equal(await ask({}), '127.0.0.1', 'no front server: the connection\'s own address');
    assert.equal(await ask({ 'x-forwarded-for': 'not an address' }), undefined, 'something that is not an address gives nothing');
  } finally { server.close(); d.server.close(); }
});

test('a signed call is handed on as it came: the raw body\'s exact text and the one header its row names; a row never reads a visitor\'s credential header', async () => {
  const d = await door();
  const site = await siteOn(d.address, { actions: 'site_actions' });
  const server = http.createServer(handlerOf(site));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sent = '{"id":"evt_1",  "type":"checkout.session.completed",\n "data":{"object":{"id":"cs_1"}}}';
    const answer = await fetch(`${at}/signed`, { method: 'POST', body: sent, headers: { 'content-type': 'application/json', 'x-forwarded-host': 'site.example.test', 'stripe-signature': 't=1,v1=abc' } });
    assert.equal(answer.status, 200);
    assert.deepEqual((await answer.json()).echo, { payload: sent, signature_header: 't=1,v1=abc' }, 'the bytes a signature covers, spaces and line breaks kept');
    const unsigned = await fetch(`${at}/signed`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'site.example.test' } });
    assert.deepEqual((await unsigned.json()).echo, { payload: '{}' }, 'a header not sent gives nothing');
    for (const path of ['/reads-a-cookie-header', '/reads-an-odd-header']) {
      assert.equal((await site.act(path, 'session=secret', 'site.example.test', { contentType: 'application/json', headers: { cookie: 'session=secret' }, bytes: Buffer.from('{}') })).status, 404, `${path}: a row that reads a credential header, or names one out of lower case, is set aside`);
    }
  } finally { server.close(); d.server.close(); }
});

test('every words page (not found, a failed form with no page to go back to) wears the not-found row\'s frame at its words place, as a centred card', async () => {
  const frame = { path: '/404', title: 'Not found', access: 'public', tool: null, input: {}, collection: null, updated_at: null,
    layout: [{ part: TEXT, export: 'Text', props: { as: 'nav' }, children: [{ text: 'The site nav' }] }, { words: true }] };
  const d = await door(LOOK, [...PAGES, frame]);
  try {
    const site = await siteOn(d.address, { actions: 'site_actions' });
    const missing = await site.answer('GET', '/nowhere', undefined, 'site.example.test');
    assert.equal(missing.status, 404);
    const page = String(missing.body);
    assert.match(page, /The site nav/, 'the site\'s frame');
    assert.match(page, /There is no page at this address\./, 'the words, in the frame\'s place');
    assert.match(page, /ui\/show\/card\/Card\.tsx#Card/, 'a card, the shared Card part');
    const failed = await site.failedForm(502, 'site.example.test', { action: '/target/x', words: null, referer: 'https://elsewhere.example.test/away', cookie: undefined, values: {} });
    assert.equal(failed.status, 502);
    assert.equal(failed.headers['cache-control'], 'no-store');
    assert.match(String(failed.body), /The site nav[\s\S]*The site could not take that\. Try again soon\.[\s\S]*href="\/"/, 'a failed form posted from another host: the frame, the words, a way back to this site, never that host\'s path');
    const home = String((await site.answer('GET', '/', undefined, 'site.example.test')).body);
    for (const referer of [undefined, '', 'not an address', 'javascript:alert(1)', 'https://elsewhere.example.test/']) {
      const none = await site.failedForm(502, 'site.example.test', { action: '/target/x', words: null, referer, cookie: undefined, values: {} });
      assert.equal(none.status, 502);
      assert.notEqual(String(none.body), home, `${JSON.stringify(referer)}: a failure is never the home page drawn in its place`);
      assert.match(String(none.body), /The site could not take that\. Try again soon\.[\s\S]*href="\/"/, `${JSON.stringify(referer)}: the words and a way back`);
    }
    assert.equal((await site.answer('GET', '/404', undefined, 'site.example.test')).status, 404, 'the frame row is never a page of its own');
  } finally { d.server.close(); }
});

test('an old ".html" address of a page is 301 to the page, query kept; one with no page stays 404', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address);
    const get = (address: string) => site.answer('GET', address, undefined, 'site.example.test');
    const moved = await get('/sign-in.html');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.location, '/sign-in');
    assert.equal((await get('/sign-in.html?checkout=x&y=1')).headers.location, '/sign-in?checkout=x&y=1', 'the query is kept');
    assert.equal((await get('/index.html')).headers.location, '/', 'the home\'s index.html is the home');
    assert.equal((await get('/notes/first.html')).headers.location, '/notes/first', 'a template page\'s old address too');
    assert.equal((await get('/nothing-here.html')).status, 404, 'no page at the clean address: still 404');
  } finally { d.server.close(); }
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
    const sent = await site.act('/checkout', 'consent=granted; visitor=v-1', host, form({ offerId: 'offer:one', amount: '120', 'consent.billing': 'on' }));
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.location, 'https://pay.example.test/session/1', 'a form post is sent on to the address the tool answered');
    const run = d.calls.find(call => call.run.tool === 'tool:start-a-checkout')!.run.input as Record<string, unknown>;
    assert.equal(run.offerId, 'offer:one');
    assert.equal(run.amount, 120, 'a number source makes the form\'s words a number');
    assert.equal(run.visitor, 'v-1', 'a cookie with its consent given is carried');
    assert.equal(run.success_url, 'https://site.example.test/welcome');
    assert.deepEqual(run.offers, [{ id: 'offer:one', params: ['offer:one'] }], 'a rows source reads a database with its values');
    assert.equal((d.calls.find(call => String((call.run.input as { sql?: string }).sql).includes('FROM offers'))!.run.input as { database: string }).database, 'a_site_for_who_runs_it', 'as the site, on the database it names');
    assert.match(String(run.attempt), /^[0-9a-f-]{36}$/, 'with no attempt posted, the next value is used');
    assert.ok(!Number.isNaN(Date.parse(String(run.at))));
    assert.ok(!('email' in run), 'a signed-out visitor has no member claim, so the key is left out');
    assert.ok(!('customer' in run), 'an object all of whose values gave nothing is left out');
    assert.deepEqual(run.consent, { billing: true, legal: true }, 'a form field named with a dot is read whole, and "on" is true');
    d.calls.length = 0;
    const asJson = await site.act('/checkout', 'visitor=v-1; session=member', host, { contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ offerId: 'offer:one', attempt: 'page-attempt-1' })) });
    assert.equal(asJson.status, 200);
    assert.deepEqual(JSON.parse(String(asJson.body)), { redirect: 'https://pay.example.test/session/1' }, 'a JSON post gets the address as JSON');
    const memberRun = d.calls.find(call => call.run.tool === 'tool:start-a-checkout')!;
    assert.equal((memberRun.run.input as Record<string, unknown>).attempt, 'page-attempt-1', 'a posted value is the first that gives something');
    assert.equal(memberRun.pass, 'the-member-pass', 'a signed-in member\'s action runs as the member');
    const input = memberRun.run.input as Record<string, unknown>;
    assert.equal(input.email, 'member@example.test');
    assert.deepEqual(input.customer, { email: 'member@example.test' });
    assert.deepEqual(input.consent, { legal: true }, 'a boolean source with nothing to read gives nothing');
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
    assert.equal((await site.act('/checkout', undefined, host, { ...form({ offerId: 'offer:one' }), origin: 'http://127.0.0.1:18440', hostHeader: '127.0.0.1:18440' })).status, 303, 'a page on the very address the post was sent to may post');
    assert.equal((await site.act('/checkout', undefined, host, { ...form({}), origin: 'http://127.0.0.1:9', hostHeader: '127.0.0.1:18440' })).status, 403);
    assert.equal((await site.act('/checkout', undefined, host, { contentType: 'text/plain', bytes: Buffer.from('x') })).status, 400);
    assert.equal((await site.act('/checkout', undefined, host, { contentType: 'application/json', bytes: Buffer.alloc(MOST_ACTION_BYTES + 1, 32) })).status, 413);
    assert.throws(() => settingsOf({ ...settings(d.address), actions: 'site actions' }), /actions/);
    d.calls.length = 0;
    const state = await site.act('/target/state?checkout=cs_1', undefined, host, { method: 'GET', bytes: Buffer.alloc(0) });
    assert.equal(state.status, 200);
    assert.deepEqual(JSON.parse(String(state.body)), { kept: 1 }, 'a GET row answers its JSON keys');
    assert.deepEqual(d.calls.at(-1)!.run.input, { checkout: 'cs_1' }, 'a query source reads the address\'s query value');
    assert.equal((await site.act('/target/state', undefined, host, { method: 'GET', bytes: Buffer.alloc(0) })).status, 200, 'a query value the address does not carry is left out');
    assert.equal(d.calls.at(-1)!.run.input, undefined, 'so the input, all of whose values gave nothing, is nothing');
    assert.equal((await site.act('/target/state', undefined, host, { method: 'HEAD', bytes: Buffer.alloc(0) })).status, 200, 'a GET row answers HEAD');
    assert.equal((await site.act('/target/state', undefined, host, form({}))).status, 404, 'a POST to an address only a GET row names does nothing');
    assert.equal((await site.act('/checkout', undefined, host, { method: 'GET', bytes: Buffer.alloc(0) })).status, 404, 'a GET to an address only a POST row names does nothing');
    const beacon = (cookie: string | undefined, href: string) => site.act('/observe/visit', cookie, host, { contentType: 'text/plain;charset=UTF-8', bytes: Buffer.from(JSON.stringify({ href, referrer: 'https://www.search.example.test/q?x=1' })) });
    const first = await beacon('consent=granted', 'https://site.example.test/courses/a?utm_source=post&t=t1');
    assert.equal(first.status, 200, 'a beacon\'s text/plain JSON is read');
    const visitor = (d.calls.at(-1)!.run.input as { visitor: string }).visitor;
    assert.match(visitor, /^[0-9a-f-]{36}$/, 'with consent and no visitor cookie, a new id');
    assert.equal(first.headers['set-cookie'], `jv=${visitor}; Max-Age=34128000; Path=/; SameSite=Lax; HttpOnly; Secure`, 'the cookie is the id the tool was given');
    assert.deepEqual(d.calls.at(-1)!.run.input, { visitor, origin: 'https://site.example.test', path: '/courses/a', query: { utm_source: 'post', t: 't1' }, from: 'www.search.example.test' });
    const again = await beacon(`consent=granted; jv=${visitor}`, 'https://site.example.test/');
    assert.equal(again.headers['set-cookie'], undefined, 'a visitor cookie already carried is not set again');
    assert.deepEqual(d.calls.at(-1)!.run.input, { visitor, origin: 'https://site.example.test', path: '/', from: 'www.search.example.test' }, 'an address with no query gives no query');
    const declined = await beacon('consent=denied; jv=old-visitor-1', 'not an address');
    assert.equal(declined.headers['set-cookie'], undefined, 'without consent no cookie is set');
    assert.deepEqual(d.calls.at(-1)!.run.input, { from: 'www.search.example.test' }, 'without consent no visitor; a value that is not an address gives no part');
    assert.equal((await site.act('/bad-cookie', undefined, host, form({}))).status, 404, 'a row whose cookie breaks a rule is set aside');
    d.calls.length = 0;
    assert.equal((await site.act('/chain', undefined, host, form({}))).status, 200);
    const chained = d.calls.filter(call => call.run.tool !== 'tool:run-sql-in-my-database').map(call => [call.run.tool, call.run.input]);
    assert.deepEqual(chained, [['tool:echo', { n: 1 }], ['tool:echo', { busy: 1 }], ['tool:keep-a-lead', { event: { busy: 1 }, account: 'offer:one' }]],
      'nested tool sources run once each, innermost first, and a key reads into an answer or a place in rows');
    d.calls.length = 0;
    const unbooked = await site.act('/chain-undo', undefined, host, { contentType: 'application/json', bytes: Buffer.from('{}') });
    assert.equal(unbooked.status, 502, 'the visitor still gets the failure');
    assert.deepEqual(d.calls.map(call => [call.run.tool, call.run.input]), [['tool:echo', { id: 'ev-1' }], ['tool:fails', { event: { id: 'ev-1' } }], ['tool:echo', { cancel: 'ev-1' }]],
      'when the row\'s own tool fails, its undo runs with what that tool was given');
    assert.equal((await site.act('/bad-undo', undefined, host, form({}))).status, 404, 'a row whose undo breaks a rule is set aside');
    d.calls.length = 0;
    const started = await site.act('/with-then', undefined, host, { contentType: 'application/json', referer: 'https://site.example.test/?utm_source=post&t=touch-9', bytes: Buffer.from('{}') });
    assert.deepEqual(JSON.parse(String(started.body)), { sessionId: 's1' });
    assert.deepEqual(d.calls.map(call => [call.run.tool, call.run.input]), [
      ['tool:echo', { code: 'C1' }],
      ['tool:start-a-checkout', { code: 'C1', again: { code: 'C1' }, touch: 'touch-9' }],
      ['tool:keep-a-lead', { session: 's1', touch: 'touch-9' }],
    ], 'one tool with one input is one run however many keys are read; the referer\'s query value is read by key; then runs after, reading the answer and the input');
    d.calls.length = 0;
    assert.equal((await site.act('/then-after-fail', undefined, host, { contentType: 'application/json', bytes: Buffer.from('{}') })).status, 502);
    assert.deepEqual(d.calls.map(call => call.run.tool), ['tool:fails'], 'then does not run when the row\'s own tool fails');
    assert.deepEqual(JSON.parse(String((await site.act('/then-fails', undefined, host, { contentType: 'application/json', bytes: Buffer.from('{}') })).body)), { kept: 1 }, 'a then that fails does not change what the visitor gets');
    assert.equal((await site.act('/bad-key', undefined, host, form({}))).status, 404, 'an address key names a query value only');
    const asJsonPost = { contentType: 'application/json', bytes: Buffer.from('{}') };
    const told = await site.act('/refuses-tells', undefined, host, asJsonPost);
    assert.equal(told.status, 422);
    assert.deepEqual(JSON.parse(String(told.body)), { error: 'That answer was not kept.', why: 'An answer is written as text.' }, 'a row that says why passes its tool\'s own words');
    assert.match(String((await site.act('/refuses-tells', undefined, host, form({}))).body), /That answer was not kept\. An answer is written as text\./, 'a form post gets them on its page');
    const quiet = await site.act('/refuses-quiet', undefined, host, asJsonPost);
    assert.deepEqual([quiet.status, JSON.parse(String(quiet.body))], [502, { error: 'That answer was not kept.' }], 'a row that does not say why passes only its own words');
    const nested = await site.act('/refuses-nested', undefined, host, asJsonPost);
    assert.deepEqual([nested.status, JSON.parse(String(nested.body))], [502, { error: 'Not kept.' }], 'a nested tool\'s words are never passed');
    const listed = await site.act('/observe/listed', undefined, host, form({}));
    assert.equal(listed.headers['set-cookie'], `n=${(d.calls.at(-1)!.run.input as { params: string[] }).params[0]}; Max-Age=86400; Path=/; SameSite=Lax; Secure`, 'a dotted key reads a place in a list');
  } finally { d.server.close(); }
});

test('a tool\'s own refusal status (400 to 499) crosses to the visitor unchanged, a crash stays 502, and a reply failure with no json carries the row\'s words', async () => {
  const d = await door();
  const server = http.createServer(handlerOf(await siteOn(d.address, { actions: 'site_actions' })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string) => {
      const sent = await fetch(`${at}${path}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'site.example.test' } });
      return [sent.status, await sent.json()];
    };
    assert.deepEqual(await post('/keep-signed-out/401'), [401, { error: 'Sign in to keep your answers.' }], 'a signed-out keep is the tool\'s 401, not a 502');
    for (const code of [400, 403, 409, 422]) {
      assert.deepEqual(await post(`/refuses-with/${code}`), [code, { error: 'Not kept.', why: `Refused with ${code}.` }], `${code} passes through with its words`);
    }
    assert.deepEqual(await post('/keep-signed-out/crash'), [502, { error: 'Sign in to keep your answers.' }], 'a tool that crashed is a 502, and its own words are not passed');
    assert.deepEqual(await post('/keep-signed-out/500'), [502, { error: 'Sign in to keep your answers.' }], 'a status outside 400 to 499 is not the tool\'s to give');
    assert.deepEqual(await post('/refuses-with/crash'), [422, { error: 'Not kept.', why: 'TypeError: Cannot read properties of undefined' }], 'a row that says why still tells a statusless refusal as 422, as before');
    assert.deepEqual(await post('/keep-signed-out/504'), [504, { error: 'Sign in to keep your answers.' }], 'a timed-out door is still 504');
    assert.deepEqual(await post('/busy'), [503, { error: 'Not now.' }], 'a busy door is still 503');
    const get = async (path: string) => {
      const sent = await fetch(`${at}${path}`, { redirect: 'manual', headers: { 'x-forwarded-host': 'site.example.test' } });
      return { status: sent.status, type: sent.headers.get('content-type'), location: sent.headers.get('location'), body: await sent.text() };
    };
    assert.deepEqual(await get('/go/gone'), { status: 404, type: 'application/json; charset=utf-8', location: null, body: '{"error":"That link is not open."}' }, 'a 404 with no json carries the row\'s own words');
    assert.deepEqual(await get('/go-json/gone'), { status: 404, type: 'application/json; charset=utf-8', location: null, body: '{"echo":{"status":404}}' }, 'a 404 with json is that json, unchanged');
    assert.deepEqual(await get('/go/open'), { status: 302, type: null, location: 'https://elsewhere.example.test/x', body: '' }, 'a redirect is as before: no body, no content type');
    assert.deepEqual(await get('/go-json/open'), { status: 200, type: 'application/json; charset=utf-8', location: null, body: '{"echo":{"status":200}}' }, 'a 200 reply is byte for byte as before');
  } finally { server.close(); d.server.close(); }
});

test('over node:http, an action row\'s request and a page row under a passed-on path are the site\'s; the rest is passed on', async () => {
  const seen: string[] = [];
  const other = http.createServer((request, response) => { seen.push(`${request.method} ${request.url}`); response.end('{"other":true}'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const server = http.createServer(handlerOf(await siteOn(d.address, { actions: 'site_actions' }), [{ name: 'the old program', address: `http://127.0.0.1:${(other.address() as AddressInfo).port}`, paths: ['/checkout', '/target', '/notes'] }]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sent = await fetch(`${at}/checkout`, { method: 'POST', redirect: 'manual', body: 'offerId=offer%3Aone', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-host': 'site.example.test' } });
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('location'), 'https://pay.example.test/session/1');
    assert.equal((await fetch(`${at}/target/other`, { method: 'POST', body: '{}' })).status, 200);
    const state = await fetch(`${at}/target/state?checkout=cs_1`, { headers: { 'x-forwarded-host': 'site.example.test' } });
    assert.deepEqual(await state.json(), { kept: 1 }, 'a GET an action row names is the site\'s even under a passed-on path');
    assert.match(await (await fetch(`${at}/notes/first`, { headers: { 'x-forwarded-host': 'site.example.test' } })).text(), /Hello, first/, 'a page row under a passed-on path is the site\'s');
    await (await fetch(`${at}/notes/unheld`, { headers: { 'x-forwarded-host': 'site.example.test' } })).text();
    await (await fetch(`${at}/notes`, { headers: { 'x-forwarded-host': 'site.example.test' } })).text();
    assert.deepEqual(seen, ['POST /target/other', 'GET /notes/unheld', 'GET /notes'], 'only what no row of the site answers went to the other program');
  } finally { server.close(); other.close(); d.server.close(); }
});

test('a passed-on program is asked for its answer uncompressed, and its whole HTML pages carry the site head when its entry says so', async () => {
  const asked: (string | undefined)[] = [];
  const page = `${String.fromCharCode(60)}!doctype html>${String.fromCharCode(60)}html>${String.fromCharCode(60)}head>${String.fromCharCode(60)}/head>${String.fromCharCode(60)}body>Sign in${String.fromCharCode(60)}/body>${String.fromCharCode(60)}/html>`;
  const other = http.createServer((request, response) => {
    asked.push(request.headers['accept-encoding'] as string | undefined);
    if (request.url === '/fragment') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('just words'); }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  const d = await door();
  const address = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  const site = await siteOn(d.address, { site_head: { tool: 'tool:read-the-site-head', input: {} } });
  const server = http.createServer(handlerOf(site, [{ name: 'sign-in', address, paths: ['/sign-in', '/fragment'], site_head: true }, { name: 'plain', address, paths: ['/plain'] }]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const signIn = await fetch(`${at}/sign-in`, { headers: { 'accept-encoding': 'gzip, br' } });
    assert.match(await signIn.text(), /window\.consentFirst=1/, 'the passed-on page carries the site head');
    assert.equal(asked[0], undefined, 'the browser\'s accept-encoding is not passed on');
    assert.equal(await (await fetch(`${at}/fragment`)).text(), 'just words', 'a fragment is passed as it is');
    assert.doesNotMatch(await (await fetch(`${at}/plain`)).text(), /consentFirst/, 'an entry without site_head passes its page as it is');
    assert.throws(() => settingsOf({ ...settings(d.address), pass_on: [{ name: 'x', address, paths: ['/x'], site_head: 'yes' }] }), /site_head/);
  } finally { server.close(); other.close(); d.server.close(); }
});

test('a served_files rule with only_listed_by answers a file only while its listing tool lists it: a withdrawn one is 404 within seconds, a failed listing 503', async () => {
  const d = await door();
  const store = { endpoint: 'https://store.example.test', region: 'r1', bucket: 'site-files', style: 'path' as const };
  const asked: string[] = [];
  const storeFiles = new StoreFiles(store, { id: 'key-id', secret: 'key-secret' }, {
    fetchImpl: (async (url: string) => { asked.push(new URL(String(url)).pathname); return new Response('clip bytes', { status: 200 }); }) as typeof fetch,
  });
  const listing = { tool: 'tool:read-the-listed-files', input: { database: 'a_site_for_who_uses_it', limit: 100 }, seconds: 1 };
  listedClips = ['aa', 'bb'];
  try {
    const site = await siteOn(d.address, {
      files_store: { ...store, credential: 'store-read' },
      served_files: [
        { paths: ['/published-clips/'], key_prefix: 'site-files/', cache_seconds: 86400, only_listed_by: listing },
        { paths: ['/held-clips/'], key_prefix: 'site-files/', cache_seconds: 300, only_listed_by: { ...listing, tool: 'tool:busy' } },
      ],
    }, { storeFiles, storeKey: { id: 'key-id', secret: 'key-secret' } });
    const before = d.calls.length;
    const [mp4, jpg, other] = await Promise.all(['/published-clips/aa.mp4', '/published-clips/bb.jpg', '/published-clips/cc.mp4'].map(path => site.answer('GET', path, undefined)));
    assert.deepEqual([mp4.status, jpg.status, other.status], [200, 200, 404]);
    assert.equal(mp4.headers['cache-control'], 'public, max-age=1', 'a browser keeps a listed file no longer than the listing\'s seconds');
    assert.equal(other.headers['cache-control'], 'no-store');
    assert.deepEqual(asked, ['/site-files/site-files/published-clips/aa.mp4', '/site-files/site-files/published-clips/bb.jpg'], 'an unlisted file is never asked of the store');
    const listed = d.calls.slice(before).filter(call => call.run.tool === 'tool:read-the-listed-files');
    assert.equal(listed.length, 1, 'three files at once ask the listing once');
    assert.equal(listed[0].pass, 'the-site-pass', 'the listing runs with the site\'s own key');
    assert.deepEqual(listed[0].run.input, { database: 'a_site_for_who_uses_it', limit: 100 }, 'its input as written');
    listedClips = ['aa'];
    assert.equal((await site.answer('GET', '/published-clips/bb.jpg', undefined)).status, 200, 'within seconds the kept listing answers');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal((await site.answer('GET', '/published-clips/bb.jpg', undefined)).status, 404, 'a withdrawn file is 404 once the listing is asked again');
    assert.equal((await site.answer('GET', '/published-clips/aa.mp4', undefined, undefined, 'bytes=0-3')).status, 206, 'a listed file still answers its range');
    const held = await site.answer('GET', '/held-clips/aa.mp4', undefined);
    assert.equal(held.status, 503, 'a listing that does not answer shows nothing it would list');
    assert.equal(held.headers['cache-control'], 'no-store');
  } finally { d.server.close(); listedClips = []; }
});

test('a row naming a part export the running commit lacks draws that node as nothing, logs it, and the page still answers 200', async () => {
  const ahead = { path: '/ahead', title: 'Ahead', access: 'public', tool: null, input: {}, collection: null, updated_at: null, layout: { part: TEXT, export: 'Text', props: { as: 'main' }, children: [
    { part: TEXT, export: 'Section', children: [{ text: 'Inside the missing section' }] },
    { part: 'ui/show/not-in-this-commit/NotHere.tsx', children: [{ text: 'Inside the missing file' }] },
    { text: 'Still drawn' },
    { tool: 'tool:read-a-greeting', input: { who: 'the rest' } },
  ] } };
  const d = await door(LOOK, [...PAGES, ahead]);
  const told: string[] = [];
  try {
    const site = await siteOn(d.address, {}, { log: line => told.push(line) });
    const page = await site.answer('GET', '/ahead', undefined);
    assert.equal(page.status, 200);
    const html = String(page.body);
    assert.match(html, /Still drawn/);
    assert.match(html, /Hello, the rest/);
    assert.doesNotMatch(html, /Inside the missing/);
    assert.deepEqual(told.filter(line => line.startsWith('/ahead')), [
      '/ahead: ui/show/not-in-this-commit/NotHere.tsx is not in the tools folder, so that part of the page is left out.',
      `/ahead: ${TEXT} has no export Section, so that part of the page is left out.`,
    ]);
    assert.equal((await site.answer('GET', '/ahead', undefined)).status, 200, 'and again, from the kept reads');
  } finally { d.server.close(); }
});

test('an answer a row names in outcomes ends the request with its own status and words: a form drawn again with them, a script given JSON, nothing run after', async () => {
  const d = await door();
  try {
    const site = await siteOn(d.address, { actions: 'site_actions' });
    const host = 'site.example.test';
    const form = (fields: Record<string, string>) => ({ contentType: 'application/x-www-form-urlencoded', origin: 'https://site.example.test', referer: 'https://site.example.test/', bytes: Buffer.from(new URLSearchParams(fields).toString()) });
    d.calls.length = 0;
    const bad = await site.act('/signup', undefined, host, form({ pick: 'invalid_email', email: 'not-an-address' }));
    assert.equal(bad.status, 400);
    assert.match(String(bad.body), /That address does not look right\./, 'the row\'s words at the form');
    assert.match(String(bad.body), /not-an-address/, 'what the visitor typed is put back');
    assert.match(String(bad.body), /Hello, everyone/, 'on the page the form was posted from');
    assert.deepEqual(d.calls.filter(call => call.run.tool !== 'tool:run-sql-in-my-database' && call.run.tool !== 'tool:read-a-greeting').map(call => call.run.tool), ['tool:say-an-outcome'], 'no next step and no then runs');
    const many = await site.act('/signup', undefined, host, { contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ pick: 'too_many' })) });
    assert.equal(many.status, 429);
    assert.deepEqual(JSON.parse(String(many.body)), { error: 'Too many sign-ups from here.', outcome: 'too_many' });
    d.calls.length = 0;
    const good = await site.act('/signup', undefined, host, form({ pick: 'check_inbox', email: 'a@example.test' }));
    assert.equal(good.status, 303, 'an outcome the row does not name goes on as before');
    assert.equal(good.headers.location, '/signup/check-inbox');
    assert.deepEqual(d.calls.map(call => call.run.tool), ['tool:say-an-outcome', 'tool:keep-a-lead', 'tool:keep-a-lead']);
    assert.equal((await site.act('/bad-outcomes', undefined, host, form({}))).status, 404, 'an outcome whose status is not 400 to 599 sets the row aside');
  } finally { d.server.close(); }
});

test('a site whose settings name its settings row reads its site head, served files and action table from that row, read again with the rows', async () => {
  const d = await door();
  const store = { endpoint: 'https://store.example.test', region: 'r1', bucket: 'site-files', style: 'path' as const };
  const storeFiles = new StoreFiles(store, { id: 'key-id', secret: 'key-secret' }, { fetchImpl: (async () => new Response('app', { status: 200 })) as typeof fetch });
  const use = { purpose: 'serve the site', surface: 'site pages' };
  const row = { use, site_head: { tool: 'tool:read-the-site-head', input: { database: 'a_site_for_who_uses_it' } },
    served_files: [{ paths: ['/app.js'], key_prefix: 'site-files/', cache_seconds: 60 }], actions: 'site_actions' };
  const rowOf = (value: Record<string, unknown>) => ({ site: 'site.example.test', key: 'runs', value });
  siteSettingsRows = [rowOf(row)];
  const told: string[] = [];
  try {
    const more = { files_store: { ...store, credential: 'store-read' }, pages: { database: 'a_site_for_who_uses_it', use, refresh_seconds: 60, answer_seconds: 60, settings: 'site.example.test' } };
    const site = await siteOn(d.address, more, { storeFiles, storeKey: { id: 'key-id', secret: 'key-secret' }, log: line => told.push(line) });
    assert.match(String((await site.answer('GET', '/', undefined)).body), /consentFirst/, 'the row\'s site head');
    assert.equal((await site.answer('GET', '/app.js', undefined)).status, 200, 'the row\'s served files');
    assert.ok(site.acts('POST', 'site.example.test', '/checkout'), 'the row\'s action table');
    siteSettingsRows = [rowOf({ use })];
    await site.read();
    assert.doesNotMatch(String((await site.answer('GET', '/', undefined)).body), /consentFirst/, 'read again: no site head');
    assert.notEqual((await site.answer('GET', '/app.js', undefined)).status, 200, 'read again: no served file');
    assert.ok(!site.acts('POST', 'site.example.test', '/checkout'), 'read again: no action table');
    siteSettingsRows = [rowOf({ ...row, use: { purpose: 'other', surface: 'site pages' } })];
    await assert.rejects(site.read(), /is not the use its rows are read under/, 'a row naming another use is refused, never followed');
    siteSettingsRows = [rowOf({ ...row, extra: 1 })];
    await assert.rejects(site.read(), /its value is \{ use, site_head\?, served_files\?, actions\? \}/);
    siteSettingsRows = [];
    await assert.rejects(site.read(), /holds 0 runs rows for the site site\.example\.test/);
    assert.ok(!site.acts('POST', 'site.example.test', '/checkout'), 'a refused read keeps the last good set');
    for (const key of ['site_head', 'served_files', 'actions']) {
      assert.throws(() => settings(d.address, { ...more, [key]: key === 'actions' ? 'site_actions' : key === 'served_files' ? [] : row.site_head }), /says .* this file does not say them too/, key);
    }
    assert.throws(() => settings(d.address, { ...more, pages: { ...more.pages, settings: 'Not A Site' } }), /pages\.settings/);
  } finally { d.server.close(); siteSettingsRows = []; }
});
