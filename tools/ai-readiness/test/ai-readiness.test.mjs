import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { auditServedHtml, robotsAllows } from '../do-work/audit-served-html.mjs';
import { checkAPage, linkStatus } from '../do-work/check_a_page.mjs';
import { completeServedHtml } from '../do-work/complete-served-html.mjs';
import { negotiateMarkdown, prefersMarkdown } from '../do-work/negotiate-markdown.mjs';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const prose = count => Array.from({ length: count }, (_, at) => `word${at}`).join(' ');
const GOOD = `<!doctype html><html lang="en"><head><title>Sourdough Club: weekly bread for neighbours</title>
<meta name="description" content="Sourdough Club bakes bread every week for people in the neighbourhood who want fresh loaves."/>
<link rel="canonical" href="https://club.example/"/>
<meta property="article:published_time" content="2026-09-01T00:00:00Z"/><meta property="article:modified_time" content="2026-10-15T00:00:00Z"/>
<script type="application/ld+json">{"@type":"WebPage","datePublished":"2026-09-01","dateModified":"2026-10-15"}</script></head>
<body><header><nav><a href="/menu">Menu</a><button aria-label="Open the cart"><svg></svg></button></nav></header>
<main><h1>Sourdough Club</h1><p>Sourdough Club is a neighbourhood bakery for people who want fresh bread each week. ${prose(160)}</p>
<h2>How much does a loaf cost?</h2><p>It depends on the size: a small loaf is five dollars and a large one eight, as of October 2026.</p>
<h3>Small loaf</h3><p>${prose(30)}</p>
<label for="email">Email</label><input id="email" name="email"><img src="/loaf.jpg" alt="A round loaf cut open">
<blockquote>The best bread in town.</blockquote><p>Updated <time datetime="2026-10-15">October 15, 2026</time></p></main><footer>Contact</footer></body></html>`;

test('a page written for readers and engines passes every scored check that can be read', async () => {
  const audit = await auditServedHtml({ html: GOOD, robotsTxt: 'User-agent: *\nAllow: /\n', now: NOW });
  assert.deepEqual(audit.missing.map(check => check.id), []);
  assert.equal(audit.score, 100);
  assert.deepEqual(audit.not_checked, ['no-broken-links']);
});

test('each missing check names what to fix and where', async () => {
  const bad = `<html><head></head><body><div id="root"></div><div onclick="go()">Go</div><button><svg></svg></button><input name="q"><img src="shot.png" alt="shot.png"><h1>A</h1><h1>B</h1><h4>Skipped</h4></body></html>`;
  const audit = await auditServedHtml({ html: bad, robotsTxt: 'User-agent: meta-webindexer\nDisallow: /\n', now: NOW });
  const missing = new Map(audit.missing.map(check => [check.id, check]));
  for (const id of ['icon-buttons-named', 'fields-labelled', 'images-have-alt', 'facts-in-served-html', 'one-main', 'one-h1', 'headings-in-order', 'real-elements-for-controls', 'page-has-title-and-description', 'published-date', 'updated-date', 'robots-allows-meta-webindexer']) assert.ok(missing.has(id), id);
  assert.match(missing.get('icon-buttons-named').examples[0], /^<button/);
  assert.ok(audit.score < 30);
  assert.ok(missing.get('icon-buttons-named').fix);
});

test('a link that does not answer is found, and a link check without a resolver is not run', async () => {
  const html = '<html><body><main><a href="/ok">ok</a><a href="/gone">gone</a><a href="mailto:a@b.c">mail</a></main></body></html>';
  const asked = [];
  const audit = await auditServedHtml({ html, pageUrl: 'https://club.example/', resolveLink: async url => { asked.push(url); return url.endsWith('/gone') ? 404 : 200; }, now: NOW });
  assert.deepEqual(asked.sort(), ['https://club.example/gone', 'https://club.example/ok']);
  assert.deepEqual(audit.missing.find(check => check.id === 'no-broken-links').examples, ['https://club.example/gone']);
});

test('a page that asks not to be indexed is not scored', async () => {
  const audit = await auditServedHtml({ html: '<html><head><meta name="robots" content="noindex"></head><body></body></html>', now: NOW });
  assert.equal(audit.indexable, false);
  assert.equal(audit.score, null);
});

test('robots.txt: an agent follows its own group, else the star group, and the longest rule wins', () => {
  const text = 'User-agent: *\nDisallow: /private\nAllow: /\n\nUser-agent: meta-webindexer\nDisallow: /\nAllow: /public\n';
  assert.equal(robotsAllows(text, 'meta-webindexer', '/'), false);
  assert.equal(robotsAllows(text, 'meta-webindexer', '/public/page'), true);
  assert.equal(robotsAllows(text, 'other', '/private/x'), false);
  assert.equal(robotsAllows(text, 'other', '/x'), true);
  assert.equal(robotsAllows('', 'meta-webindexer', '/'), true);
});

test('completeServedHtml adds only what a page leaves out, and leaves fragments and written facts alone', () => {
  const bare = '<!doctype html><html><head><title>t</title></head><body><main>x</main></body></html>';
  const done = completeServedHtml(bare, { published_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-15T00:00:00Z', canonical_url: 'https://club.example/' });
  assert.match(done, /<html lang="en">/);
  assert.match(done, /<link rel="canonical" href="https:\/\/club\.example\/">/);
  assert.match(done, /<meta property="article:published_time" content="2026-09-01T00:00:00.000Z">/);
  assert.match(done, /<meta property="article:modified_time" content="2026-10-15T00:00:00.000Z">/);
  assert.equal(completeServedHtml(GOOD, { published_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-02T00:00:00Z', canonical_url: 'https://other.example/' }), GOOD);
  assert.equal(completeServedHtml('<p>fragment</p>', { published_at: '2026-09-01T00:00:00Z' }), '<p>fragment</p>');
});

test('a page with a password field is a form, so article checks do not apply to it', async () => {
  const html = '<html lang="en"><head><title>Create your account</title><meta name="description" content="Create your account to join the club and get the weekly bread order started."></head><body><main><h1>Create</h1><label for="p">Password</label><input id="p" type="password"></main></body></html>';
  const audit = await auditServedHtml({ html, now: NOW });
  const status = id => audit.results.find(check => check.id === id).status;
  assert.equal(status('published-date'), 'not_applicable');
  assert.equal(status('one-h1'), 'pass');
});

test('first-words checks read the main landmark, so a menu before the page does not push the definition out', async () => {
  const menu = Array.from({ length: 300 }, (_, at) => `item${at}`).join(' ');
  const html = `<html lang="en"><head><title>Acme home page</title></head><body><header><nav><h2>Menu heading</h2><p>${menu}</p></nav></header><main><h1>Acme</h1><p>Acme is a bakery for people in the neighbourhood who want fresh bread. ${prose(170)}</p><h2>How much is a loaf?</h2><p>It depends on the size.</p></main></body></html>`;
  const audit = await auditServedHtml({ html, now: NOW });
  const status = id => audit.results.find(check => check.id === id).status;
  assert.equal(status('says-what-it-is'), 'pass');
  assert.equal(status('says-who-it-is-for'), 'pass');
  assert.equal(status('first-h2-is-the-question'), 'pass', 'the menu\'s own H2 is not the page\'s first H2');
});

test('a caller may pass its own check rows and skip a check by id', async () => {
  const one = [{ id: 'has-h1', area: 'structure', says: 'The page has one H1', fix: 'Add an H1.', check: { elements: [{ tags: ['h1'] }], count: { min: 1, max: 1 } } }];
  const missing = async html => (await auditServedHtml({ html, checks: one, now: NOW })).missing.map(check => check.id);
  assert.deepEqual(await missing('<html><body><h1>A</h1></body></html>'), []);
  assert.deepEqual(await missing('<html><body></body></html>'), ['has-h1']);
  const skipped = await auditServedHtml({ html: '<html><body></body></html>', checks: one, skip: ['has-h1'], now: NOW });
  assert.equal(skipped.results[0].status, 'not_applicable');
});

test('Accept: text/markdown is honoured only when explicit, and the page answers as Markdown with its size saving', async () => {
  assert.equal(prefersMarkdown('text/markdown'), true);
  assert.equal(prefersMarkdown('*/*'), false);
  assert.equal(prefersMarkdown('text/html, text/markdown'), false);
  assert.equal(prefersMarkdown('text/markdown, text/html'), true);
  assert.equal(prefersMarkdown('text/markdown;q=0.4, text/html;q=0.9'), false);
  assert.equal(prefersMarkdown('text/markdown;q=0'), false);
  const limits = { origin: 'https://app.example', tokensPerCharacter: 0.25, mostHtmlCharacters: 100_000 };
  const page = () => new Response('<html><head><style>p{}</style></head><body><nav>menu</nav><main><h1>Hello</h1><p>World body.</p><a href="/open">Open</a></main></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '999', etag: '"x"', 'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT', vary: 'cookie' } });
  const asked = await negotiateMarkdown(new Request('https://app.example/p', { headers: { accept: 'text/markdown' } }), page(), limits);
  assert.equal(asked.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(asked.headers.get('vary'), 'cookie, Accept');
  for (const name of ['content-length', 'etag', 'last-modified']) assert.equal(asked.headers.has(name), false, name);
  assert.ok(Number(asked.headers.get('x-original-tokens')) > Number(asked.headers.get('x-markdown-tokens')));
  assert.equal(await asked.text(), '# Hello\n\nWorld body.\n\n[Open](https://app.example/open)\n');
  const head = await negotiateMarkdown(new Request('https://app.example/p', { method: 'HEAD', headers: { accept: 'text/markdown' } }), page(), limits);
  assert.equal(head.body, null);
  assert.ok(head.headers.get('x-markdown-tokens'));
  const normal = await negotiateMarkdown(new Request('https://app.example/p', { headers: { accept: '*/*' } }), page(), limits);
  assert.match(normal.headers.get('content-type'), /^text\/html/);
  assert.equal(normal.headers.get('vary'), 'cookie, Accept');
  assert.equal(normal.headers.get('etag'), '"x"');
});

test('the tool reads the page, its host\'s robots.txt and its links through one getter, and answers fixes', async () => {
  const bad = '<html><head><title>x</title></head><body><main><h1>One</h1><a href="/gone">gone</a></main></body></html>';
  const asked = [];
  const getter = async (address, { method = 'GET' } = {}) => {
    asked.push(`${method} ${address}`);
    if (address === 'https://club.example/robots.txt') return { status: 200, final_url: address, text: 'User-agent: meta-webindexer\nDisallow: /\n' };
    if (address.endsWith('/gone')) return { status: 404, final_url: address, text: '' };
    return { status: 200, final_url: address, text: bad };
  };
  const report = await checkAPage({ url: 'https://club.example/' }, getter);
  assert.equal(report.status, 200);
  assert.equal(report.indexable, true);
  assert.equal(report.score, Math.round(100 * report.passed / (report.passed + report.failed)));
  const ids = report.missing.map(check => check.id);
  for (const id of ['no-broken-links', 'robots-allows-meta-webindexer', 'page-has-title-and-description']) assert.ok(ids.includes(id), id);
  assert.deepEqual(report.missing.find(check => check.id === 'no-broken-links').examples, ['https://club.example/gone']);
  assert.ok(report.missing.every(check => check.fix));
  assert.deepEqual(report.not_checked, []);
  assert.ok(asked.includes('GET https://club.example/robots.txt'));
  assert.ok(asked.includes('HEAD https://club.example/gone'));
  await assert.rejects(checkAPage({ url: 'https://club.example/' }, async () => ({ status: 503, final_url: 'x', text: '' })), /HTTP 503/);
});

test('a link whose server refuses HEAD is asked again with GET', async () => {
  const seen = [];
  const status = await linkStatus('https://club.example/a', async (address, { method = 'GET' } = {}) => { seen.push(method); return { status: method === 'HEAD' ? 405 : 200, final_url: address, text: '' }; });
  assert.equal(status, 200);
  assert.deepEqual(seen, ['HEAD', 'GET']);
  assert.equal(await linkStatus('https://club.example/b', async () => { throw new Error('down'); }), 0);
});

test('the tool row takes a page address, runs in the network-enabled container and carries a verify run', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records;
  const row = rows.find(record => record.payload.id === 'tool:check-a-page-for-search-and-answer-engines').payload;
  assert.deepEqual(row.input_schema.required, ['url']);
  assert.equal(row.invoke.kind, 'container');
  assert.equal(row.invoke.internet, true);
  assert.ok(row.verify.length > 0);
  const shipped = row.invoke.files.package_files;
  assert.ok(shipped.paths.includes('do-work/check_a_page.mjs'));
  assert.ok(shipped.paths.includes('read-data/ai-readiness-checks.json'));
});
