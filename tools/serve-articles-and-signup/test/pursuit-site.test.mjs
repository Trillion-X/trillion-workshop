import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSite } from '../do-work/pursuit-site.mjs';

const site = (overrides = {}) => createSite({
  db: async () => [], mail: async () => {}, origin: 'https://example.test', brand: 'Example', secret: 'x'.repeat(40),
  signupText: { label: 'Email', consent: 'Send me new articles.', button: 'Sign up', confirm: { subject: 'Confirm', body: 'Confirm your address.', button: 'Confirm' } },
  ...overrides,
});

const published = { slug: 'a-guide', title: 'A Guide', description: 'Plain words about a guide.', body_markdown: 'Body.', picture: '/img/guide.png', keywords: 'guide', status: 'published', canonical: null, published_at: '2026-11-01T09:00:00.000Z', updated_at: '2026-11-03T09:00:00.000Z' };
const articleSite = (row = published, options = {}) => site({
  author: 'Example Author',
  db: async (sql) => (sql.startsWith('SELECT slug, title, description, body_markdown, picture, keywords, status') ? [row] : []),
  ...options,
});
const pageOf = async (handler, path) => (await handler.handle(new Request(`https://example.test${path}`))).text();

test('an article body is markdown drawn by document-page: raw HTML in a row is shown as text, never written as a tag', async () => {
  const html = await pageOf(articleSite({ ...published, body_markdown: '# Hi <img src=x onerror=alert(1)>\n\nSome "text" & more' }), '/articles/a-guide');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
  assert.match(html, /<article class="doc-article">/);
  assert.match(html, /<h1 class="doc-h1">A Guide<\/h1>/);
});

test('a link in an article is an anchor only to an http or https address', async () => {
  const body = 'If you want it, [book a call with me](https://example.test/book?utm_source=site&utm_medium=article). Or [this](javascript:alert(1)).';
  const html = await pageOf(articleSite({ ...published, body_markdown: body }), '/articles/a-guide');
  assert.match(html, /href="https:\/\/example\.test\/book\?utm_source=site&amp;utm_medium=article"/);
  assert.ok(!html.includes('href="javascript'));
});

test('paths this site does not serve are left to the site\'s own program', async () => {
  const handler = site();
  assert.equal(await handler.handle(new Request('https://example.test/about')), null);
  assert.equal(await handler.handle(new Request('https://example.test/subscribe', { method: 'GET' })), null);
});

test('an unknown article address answers 404 with no article row, kept out of search', async () => {
  const handler = site();
  const answer = await handler.handle(new Request('https://example.test/articles/nope'));
  assert.equal(answer.status, 404);
  const html = await answer.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/articles\/nope"\/>/);
});

test('a draft answers only with its own preview token', async () => {
  const draft = { ...published, slug: 'a-draft', title: 'Draft', description: '', body_markdown: 'Secret words', status: 'draft', published_at: null };
  const handler = articleSite(draft);
  const hidden = await handler.handle(new Request('https://example.test/articles/a-draft'));
  assert.equal(hidden.status, 404);
  const shown = await handler.handle(new Request(`https://example.test/articles/a-draft?preview=${handler.previewToken('a-draft')}`));
  assert.equal(shown.status, 200);
  assert.ok((await shown.text()).includes('Secret words'));
});

test('a row listed false answers at its address and is left out of the index', async () => {
  const row = { slug: 'quiet', title: 'Quiet', description: 'd', body_markdown: 'Words', status: 'published', published_at: null, updated_at: '2026-11-21', listed: false };
  const handler = site({
    db: async (sql) => (sql.includes('listed IS DISTINCT FROM false') ? [row].filter((item) => item.listed !== false) : sql.includes('WHERE slug') ? [row] : []),
    draw: { index: (rows) => `index:${rows.map((item) => item.slug).join(',')}`, article: (item) => `article:${item.slug}` },
  });
  const answer = await handler.handle(new Request('https://example.test/articles/quiet'));
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), 'article:quiet');
  assert.equal(await (await handler.handle(new Request('https://example.test/articles'))).text(), 'index:');
});

test('a published row whose time has come answers when read from the database as a Date', async () => {
  const row = { slug: 'dated', title: 'Dated', description: 'd', body_markdown: 'Words', status: 'published', published_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z') };
  const handler = site({ db: async () => [row], draw: { index: () => '', article: (item) => `article:${item.slug}` } });
  const answer = await handler.handle(new Request('https://example.test/articles/dated'));
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), 'article:dated');
});

test('the index lists the listed articles as links and carries its own canonical and the signup form', async () => {
  const rows = [published, { ...published, slug: 'second', title: 'Second' }];
  const html = await pageOf(site({ db: async (sql) => (sql.includes('listed IS DISTINCT FROM false') ? rows : []) }), '/articles');
  assert.match(html, /<a class="doc-links-title" href="\/articles\/a-guide">A Guide<\/a>/);
  assert.match(html, /<a class="doc-links-title" href="\/articles\/second">Second<\/a>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/articles"\/>/);
  assert.match(html, /<form class="doc-form" method="post" action="\/subscribe">/);
});

// The article's search head: canonical from its row (else this page), Open Graph, and a JSON-LD Article with the site's author and the row's dates.
test('an article names itself as canonical, with Open Graph and a JSON-LD Article from its row', async () => {
  const html = await pageOf(articleSite(), '/articles/a-guide');
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/articles\/a-guide"\/>/);
  assert.match(html, /<meta property="og:type" content="article"\/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/example\.test\/img\/guide\.png"\/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"\/>/);
  const jsonld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(jsonld['@type'], 'Article');
  assert.equal(jsonld.author.name, 'Example Author');
  assert.equal(jsonld.datePublished, '2026-11-01T09:00:00.000Z');
  assert.equal(jsonld.dateModified, '2026-11-03T09:00:00.000Z');
});

test('the search head is written once: document-page\'s own head facts are replaced, not doubled', async () => {
  const html = await pageOf(articleSite(), '/articles/a-guide');
  assert.equal(html.match(/<title>/g).length, 1);
  assert.equal(html.match(/<meta name="description"/g).length, 1);
  assert.equal(html.match(/<link rel="canonical"/g).length, 1);
  assert.equal(html.match(/<meta property="og:title"/g).length, 1);
  assert.match(html, /<title>A Guide \| Example<\/title>/);
});

test('a cross-posted article names the row\'s canonical; a bad canonical falls back to this page', async () => {
  const home = 'https://home.example/articles/a-guide';
  const cross = await pageOf(articleSite({ ...published, canonical: home }), '/articles/a-guide');
  assert.match(cross, new RegExp(`<link rel="canonical" href="${home}"/>`));
  const bad = await pageOf(articleSite({ ...published, canonical: 'javascript:alert(1)' }), '/articles/a-guide');
  assert.match(bad, /<link rel="canonical" href="https:\/\/example\.test\/articles\/a-guide"\/>/);
});

test('the author is left out of JSON-LD when the site does not name one', async () => {
  const noAuthor = await pageOf(articleSite(published, { author: null }), '/articles/a-guide');
  assert.equal(noAuthor.includes('"author"'), false);
});

test('a row with no description is described by its body\'s first sentence, cut at a word boundary near 155 characters, else by its title', async () => {
  const opening = await pageOf(articleSite({ ...published, description: '', body_markdown: '# Heading\n\nThe **first** sentence has a [link](https://example.test/x). Then more words follow here.' }), '/articles/a-guide');
  assert.match(opening, /<meta name="description" content="The first sentence has a link\."\/>/);
  assert.match(opening, /"description":"The first sentence has a link\."/);
  const long = 'word '.repeat(60).trim();
  const cut = await pageOf(articleSite({ ...published, description: '', body_markdown: long }), '/articles/a-guide');
  const description = cut.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.ok(description.length <= 155 && description.length > 140, description.length);
  assert.ok(long.startsWith(description));
  assert.match(description, /word$/);
  const empty = await pageOf(articleSite({ ...published, description: '', body_markdown: '' }), '/articles/a-guide');
  assert.match(empty, /<meta name="description" content="A Guide"\/>/);
});

test('the page takes the site\'s stylesheets, its theme attribute, and its token names', async () => {
  const html = await pageOf(articleSite(published, {
    stylesheets: ['/assets/site.css'],
    themeAttributes: { 'data-theme': 'paper' },
    tokens: { 'button-bg': 'button-primary-bg', ink: 'text-main' },
  }), '/articles/a-guide');
  assert.match(html, /<html lang="en" data-theme="paper">/);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/site\.css"\/>/);
  assert.match(html, /<style>:root\{--button-bg:var\(--button-primary-bg\);--ink:var\(--text-main\);\}<\/style>/);
});

test('a token name that is not a word with dashes is refused when the site is made', () => {
  assert.throws(() => site({ tokens: { 'button-bg': 'Button Primary' } }), TypeError);
  assert.throws(() => site({ tokens: { 'bg; color: red': 'x' } }), TypeError);
});

test('the signup form posts to /subscribe with the page it came from', async () => {
  const html = await pageOf(articleSite(), '/articles/a-guide');
  assert.match(html, /<form class="doc-form" method="post" action="\/subscribe">/);
  assert.match(html, /<input type="hidden" name="source" value="\/articles\/a-guide"\/>/);
  assert.match(html, /<input class="doc-field-input" id="doc-field-email" name="email" type="email" required autocomplete="email"\/>/);
  assert.match(html, /Send me new articles\./);
});

test('an article answers HEAD with its GET status and headers and no body; a missing one is 404; a route with effects ignores HEAD', async () => {
  const row = { slug: 'here', title: 'Here', description: 'd', body_markdown: 'Words', status: 'published', published_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const handler = site({ db: async (sql, params) => (params?.[0] === 'here' ? [row] : []) });
  const head = await handler.handle(new Request('https://example.test/articles/here', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type'), /text\/html/);
  assert.equal(await head.text(), '');
  const missing = await handler.handle(new Request('https://example.test/articles/gone', { method: 'HEAD' }));
  assert.equal(missing.status, 404);
  assert.equal(await handler.handle(new Request('https://example.test/subscribe/confirm?s=x&t=y', { method: 'HEAD' })), null);
});

// A site that passes `layout` (its layout carries a consent bar and page parts): they wrap every page the module draws, as they always have.
const SECRET = 'x'.repeat(40);
const digest = (purpose, value) => createHmac('sha256', SECRET).update(`${purpose}\n${value}`).digest('base64url');
const layout = ({ title, description, body }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"/></head><body data-parts="layout">${body}</body></html>`;
const pending = { id: 'sub-1', status: 'pending', confirm_sent_at: new Date().toISOString(), confirm_digest: digest('confirm', 'sub-1:tok') };
const journey = (mail) => async (sql, params = []) => {
  if (sql.includes('count(*)')) return [{ n: 0 }];
  if (sql.includes('listed IS DISTINCT FROM false')) return [published];
  if (sql.includes('WHERE slug = $1')) return params[0] === 'a-guide' ? [published] : [];
  if (sql.startsWith('SELECT * FROM subscribers WHERE id')) return params[0] === 'sub-1' ? [pending] : [];
  if (sql.startsWith('SELECT id, status FROM subscribers')) return params[0] === 'sub-1' ? [{ id: 'sub-1', status: 'confirmed' }] : [];
  if (sql.startsWith('SELECT * FROM subscribers WHERE email')) return [];
  return [];
};

test('a site that passes layout has every page the module draws wrapped in its layout, with one search head each', async () => {
  const mail = [];
  const handler = site({ layout, db: journey(mail), mail: async (message) => mail.push(message) });
  const pages = [
    ['index', new Request('https://example.test/articles')],
    ['article', new Request('https://example.test/articles/a-guide')],
    ['article not found', new Request('https://example.test/articles/nope')],
    ['signup refused', new Request('https://example.test/subscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=not-an-address&source=%2Farticles' })],
    ['signup sent', new Request('https://example.test/subscribe', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=reader%40example.test&source=%2Farticles' })],
    ['confirm', new Request('https://example.test/subscribe/confirm?s=sub-1&t=tok')],
    ['confirm expired', new Request('https://example.test/subscribe/confirm?s=nope&t=tok')],
    ['unsubscribe', new Request(`https://example.test/unsubscribe?s=sub-1&t=${digest('unsubscribe', 'sub-1')}`)],
    ['unsubscribe refused', new Request('https://example.test/unsubscribe?s=sub-1&t=wrong')],
  ];
  for (const [name, request] of pages) {
    const answer = await handler.handle(request);
    const html = await answer.text();
    assert.ok(html.includes('data-parts="layout"'), `${name} has the layout's parts`);
    assert.equal(html.includes('doc-article'), false, `${name} is drawn by the layout, not document-page`);
    assert.equal(html.match(/<title>/g).length, 1, `${name} has one title`);
    assert.equal(html.match(/<meta name="description"/g).length, 1, `${name} has one description`);
  }
  assert.equal(mail.length, 1, 'the confirmation mail is sent once');
});

test('the confirm and unsubscribe pages of a layout site keep the layout\'s consent bar and its parts', async () => {
  const handler = site({ layout, db: journey([]) });
  const confirmed = await (await handler.handle(new Request('https://example.test/subscribe/confirm?s=sub-1&t=tok'))).text();
  assert.match(confirmed, /<body data-parts="layout"><h1>You are subscribed<\/h1><p>Thank you\.<\/p><\/body>/);
  const unsubscribed = await (await handler.handle(new Request(`https://example.test/unsubscribe?s=sub-1&t=${digest('unsubscribe', 'sub-1')}`))).text();
  assert.match(unsubscribed, /<body data-parts="layout"><h1>You are unsubscribed<\/h1><\/body>/);
});

test('a site that does not pass layout has its pages drawn by document-page', async () => {
  const handler = site({ db: journey([]) });
  const confirmed = await (await handler.handle(new Request('https://example.test/subscribe/confirm?s=sub-1&t=tok'))).text();
  assert.match(confirmed, /<article class="doc-article">/);
  assert.equal(confirmed.includes('data-parts'), false);
  const index = await (await handler.handle(new Request('https://example.test/articles'))).text();
  assert.match(index, /<form class="doc-form" method="post" action="\/subscribe">/);
});
