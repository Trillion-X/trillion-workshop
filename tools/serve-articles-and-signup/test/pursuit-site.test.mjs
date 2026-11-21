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
