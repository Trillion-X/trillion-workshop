import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyHtml, createSite } from '../do-work/pursuit-site.mjs';

const site = (overrides = {}) => createSite({
  db: async () => [], mail: async () => {}, origin: 'https://example.test', brand: 'Example', secret: 'x'.repeat(40),
  layout: ({ title, body }) => `<!doctype html><title>${title}</title>${body}`,
  signupText: { label: 'Email', consent: 'Send me new articles.', button: 'Sign up', confirm: { subject: 'Confirm', body: 'Confirm your address.', button: 'Confirm' } },
  ...overrides,
});

test('a body is escaped: a row never writes raw HTML into a page', () => {
  const html = bodyHtml('# Hi <img src=x onerror=alert(1)>\n\nSome "text" & more');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<h1>Hi'));
});

test('paths this site does not serve are left to the site\'s own program', async () => {
  const handler = site();
  assert.equal(await handler.handle(new Request('https://example.test/about')), null);
  assert.equal(await handler.handle(new Request('https://example.test/subscribe', { method: 'GET' })), null);
});

test('an unknown article address answers 404 with no article row', async () => {
  const handler = site();
  const answer = await handler.handle(new Request('https://example.test/articles/nope'));
  assert.equal(answer.status, 404);
});

test('a draft answers only with its own preview token', async () => {
  const draft = { slug: 'a-draft', title: 'Draft', description: '', body_markdown: 'Secret words', status: 'draft', published_at: null, updated_at: '2026-11-21' };
  const handler = site({ db: async (sql) => (sql.startsWith('SELECT slug, title, description, body_markdown, picture, keywords, status') ? [draft] : []) });
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

test('a paragraph\'s markdown link is an anchor, and only to an http or https address', () => {
  const html = bodyHtml('If you want it, [book a call with me](https://example.test/book?utm_source=site&utm_medium=article). Or [this](javascript:alert(1)).');
  assert.ok(html.includes('<a href="https://example.test/book?utm_source=site&amp;utm_medium=article">book a call with me</a>'));
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes('[this](javascript:alert(1))'));
  assert.ok(!bodyHtml('[x](https://a.test/"onmouseover=alert(1))').includes('"onmouseover'));
});

// The article's search head: canonical from its row (else this page), Open Graph, and a JSON-LD Article with the site's author and the row's dates.
const headed = (row, options = {}) => site({
  author: 'Example Author',
  layout: ({ title, description, body }) => `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title></head><body>${body}</body></html>`,
  db: async (sql) => (sql.startsWith('SELECT slug, title, description, body_markdown, picture, keywords, status') ? [row] : []),
  ...options,
});
const article = {
  slug: 'a-guide', title: 'A Guide', description: 'Plain words about a guide.', body_markdown: 'Body.', picture: '/img/guide.png',
  keywords: 'guide', status: 'published', canonical: null, published_at: '2026-11-01T09:00:00.000Z', updated_at: '2026-11-03T09:00:00.000Z',
};

test('an article names itself as canonical, with Open Graph and a JSON-LD Article from its row', async () => {
  const html = await (await headed(article).handle(new Request('https://example.test/articles/a-guide'))).text();
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

test('a cross-posted article names the row\'s canonical; a bad canonical falls back to this page', async () => {
  const home = 'https://home.example/articles/a-guide';
  const cross = await (await headed({ ...article, canonical: home }).handle(new Request('https://example.test/articles/a-guide'))).text();
  assert.match(cross, new RegExp(`<link rel="canonical" href="${home}"/>`));
  const bad = await (await headed({ ...article, canonical: 'javascript:alert(1)' }).handle(new Request('https://example.test/articles/a-guide'))).text();
  assert.match(bad, /<link rel="canonical" href="https:\/\/example\.test\/articles\/a-guide"\/>/);
});

test('the author is left out of JSON-LD when the site does not name one, and no head is written without a description', async () => {
  const noAuthor = await (await headed(article, { author: null }).handle(new Request('https://example.test/articles/a-guide'))).text();
  assert.equal(noAuthor.includes('"author"'), false);
  const bare = await (await headed({ ...article, description: '' }).handle(new Request('https://example.test/articles/a-guide'))).text();
  assert.equal(bare.includes('application/ld+json'), false);
  assert.match(bare, /<title>A Guide \| Example<\/title>/);
});
