import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { prepareContentForDiscovery } from '../do-work/prepare-content-for-discovery.mjs';
import { createContentDiscoveryHandler } from '../do-work/serve-content-for-discovery.mjs';

function inputFor({ name, origin, title = 'A public guide', version = 'edition:1', schemaType = 'Thing', openGraphType = 'website', schemaProperties = {}, text = 'Useful information', complete = true, requestedCursor = null, nextCursor = null } = {}) {
  return {
    site: { name, origin, language: 'en' },
    source: {
      ref: `source:${name.toLowerCase().replaceAll(' ', '-')}:public-list`,
      version: 'snapshot:2026-10-31T10:00:00Z',
      observedAt: '2026-10-31T10:00:00Z',
      requestedCursor,
      complete,
      nextCursor,
      documents: [{
        ref: `record:${name.toLowerCase().replaceAll(' ', '-')}:guide`, version, title,
        schemaType, openGraphType, schemaProperties, description: `About ${name}`, updatedAt: '2026-10-31T10:00:00Z',
        sections: [{ kind: 'heading', level: 4, text: 'Details' }, { kind: 'paragraph', text }, { kind: 'list', items: ['First item', 'Second item'] }],
        citations: [{ ref: 'private-source-id:guide-4', version: 'edition:secret', url: 'https://sources.invalid/guide', label: 'The source guide' }],
      }],
    },
    routes: [{ documentRef: `record:${name.toLowerCase().replaceAll(' ', '-')}:guide`, path: '/guides/public-guide' }],
  };
}

test('same shared projection serves unrelated brands with their own canonical origins', () => {
  const one = prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid' }));
  const two = prepareContentForDiscovery(inputFor({ name: 'Northwind Learning', origin: 'https://northwind.invalid', title: 'Learning notes' }));
  assert.equal(one.outputs.documents[0].canonicalUrl, 'https://cedar.invalid/guides/public-guide');
  assert.equal(two.outputs.documents[0].canonicalUrl, 'https://northwind.invalid/guides/public-guide');
  assert.notEqual(one.outputs.documents[0].identity.html, two.outputs.documents[0].identity.html);
  assert.equal(one.manifest.source.version, 'snapshot:2026-10-31T10:00:00Z');
  assert.equal(two.outputs.documents[0].jsonLd.name, 'Learning notes');
  assert.match(two.outputs.documents[0].html, /property="og:type" content="website"/);
  const article = prepareContentForDiscovery(inputFor({ name: 'Northwind Learning', origin: 'https://northwind.invalid', schemaType: 'Article', openGraphType: 'article', schemaProperties: { headline: 'Learning notes', author: { name: 'Research team' }, image: 'https://northwind.invalid/images/cover.png', keywords: ['learning', 'evidence'], datePublished: '2026-10-01T12:00:00Z' } })).outputs.documents[0];
  assert.equal(article.jsonLd['@type'], 'Article');
  assert.equal(article.jsonLd.datePublished, '2026-10-01T12:00:00.000Z');
  assert.match(article.html, /property="og:type" content="article"/);
  assert.match(article.html, /Research team/);
  assert.match(article.html, /Keywords: learning, evidence/);
  assert.match(article.bodyMarkdown, /Headline: Learning notes/);
  assert.match(article.bodyMarkdown, /Published: 2026-10-01T12:00:00.000Z/);
  const example = prepareContentForDiscovery(inputFor({ name: 'A better example', origin: 'https://example.invalid', title: 'A better example' }));
  assert.equal(example.outputs.documents[0].title, 'A better example');
});

test('source edits change bytes and identity while preserving explicit provenance', () => {
  const first = prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', version: 'edition:1' }));
  const edited = prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', version: 'edition:2', text: 'Updated information' }));
  assert.notEqual(first.outputs.documents[0].identity.html, edited.outputs.documents[0].identity.html);
  assert.match(edited.outputs.documents[0].markdown, /Updated information/);
  assert.doesNotMatch(JSON.stringify(edited), /record:cedar-field-lab|source:cedar-field-lab/);
});

test('partial pages expose continuation and cannot claim completeness', () => {
  const result = prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', complete: false, nextCursor: 'cursor:page-2' }));
  assert.equal(result.manifest.source.complete, false);
  assert.equal(result.manifest.source.continuation, 'cursor:page-2');
  assert.equal(result.outputs.sitemap.complete, false);
  assert.doesNotMatch(result.outputs.llms, /cursor:page-2/);
  assert.throws(() => prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', complete: false })), /nextCursor/);
  assert.throws(() => prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', complete: true, nextCursor: 'cursor:page-2' })), /complete source page/);
  assert.throws(() => prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', complete: false, requestedCursor: 'cursor:page-2', nextCursor: 'cursor:page-2' })), /repeat its requested cursor/);
});

test('untrusted content stays text in HTML and cannot close JSON-LD script', () => {
  const result = prepareContentForDiscovery(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', title: '</script><script>alert(1)</script>', text: '<img src=x onerror=alert(1)>' }));
  const page = result.outputs.documents[0].html;
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page, /\\u003c\/script/);
  assert.equal((page.match(/<script/g) ?? []).length, 1);
  assert.equal(result.outputs.documents[0].jsonLd.name, '</script><script>alert(1)</script>');
});

test('Markdown bodies become escaped structured blocks with headings, quotes, lists, and public links', () => {
  const input = inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid' });
  delete input.source.documents[0].sections;
  input.source.documents[0].bodyMarkdown = '## Details\n\n#### Subdetails\n\nA **plain** paragraph with [source](https://sources.invalid/item).\n\n> Quoted words\n\n- First\n- Second <img src=x onerror=alert(1)>';
  const parsed = prepareContentForDiscovery(input);
  const doc = parsed.outputs.documents[0];
  assert.deepEqual(doc.sections.map(section => section.kind), ['heading', 'heading', 'paragraph', 'quote', 'list', 'paragraph']);
  assert.match(doc.html, /<h2>Details<\/h2>/);
  assert.match(doc.html, /<h4>Subdetails<\/h4>/);
  assert.match(doc.html, /"@type":"Thing"/);
  assert.match(doc.html, /https:\/\/sources\.invalid\/guide/);
  assert.doesNotMatch(doc.html, /<img|onerror/);
  assert.match(doc.html, /<li>Second<\/li>/);
  assert.deepEqual(doc.citations, [{ url: 'https://sources.invalid/guide', label: 'The source guide' }]);
  assert.doesNotMatch(JSON.stringify(parsed), /private-source-id|edition:secret/);
  assert.match(parsed.outputs.llms, /https:\/\/sources.invalid\/guide/);
});

test('rejects cross-origin, duplicate, malformed routes and non-provenance placeholders', () => {
  const base = inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid' });
  assert.throws(() => prepareContentForDiscovery({ ...base, routes: [{ ...base.routes[0], path: 'https://elsewhere.invalid/guide' }] }), /origin-relative/);
  assert.throws(() => prepareContentForDiscovery({ ...base, routes: [...base.routes, base.routes[0]] }), /duplicate/);
  assert.throws(() => prepareContentForDiscovery({ ...base, source: { ...base.source, version: 'unversioned-source' } }), /actual source version/);
  assert.throws(() => prepareContentForDiscovery({ ...base, source: { ...base.source, version: 'unknown' } }), /actual source version/);
  const privateLocal = structuredClone(base);
  privateLocal.source.documents[0].schemaProperties = { localPath: '/Users/person/notes.txt' };
  assert.throws(() => prepareContentForDiscovery(privateLocal), /private local path/);
  const unsafeSchemaUrl = structuredClone(base);
  unsafeSchemaUrl.source.documents[0].schemaProperties = { image: 'javascript:alert(1)' };
  assert.throws(() => prepareContentForDiscovery(unsafeSchemaUrl), /public HTTPS URL/);
  const noCitations = structuredClone(base);
  noCitations.source.documents[0].citations = [];
  const withoutCitations = prepareContentForDiscovery(noCitations);
  assert.deepEqual(withoutCitations.outputs.documents[0].citations, []);
});

test('read-only serving resolves each request, fails withdrawn rights closed, then retries current source', async () => {
  let current = inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', version: 'edition:1' });
  let unavailable = false;
  const calls = [];
  const handle = createContentDiscoveryHandler({ loadCurrentPublicSnapshot: async requestContext => {
    calls.push(requestContext);
    if (unavailable) throw new Error('source no longer publicly visible');
    if (requestContext.path === '/guides/public-guide') return current;
    return { ...current, source: { ...current.source, requestedCursor: requestContext.cursor, complete: false, nextCursor: 'cursor:second-page' } };
  } });
  const first = await handle(new Request('https://cedar.invalid/guides/public-guide'));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(await first.text(), /A public guide/);
  const markdown = await handle(new Request('https://cedar.invalid/guides/public-guide', { headers: { accept: 'text/markdown' } }));
  assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.match(await markdown.text(), /Useful information/);
  const listPage = await handle(new Request('https://cedar.invalid/feed.xml?limit=1'));
  assert.equal(listPage.headers.get('x-source-complete'), 'false');
  assert.match(listPage.headers.get('link'), /cursor%3Asecond-page/);
  const feedXml = await listPage.text();
  assert.match(feedXml, /rss version="2.0"/);
  assert.match(feedXml, /source url="https:\/\/sources\.invalid\/guide"/);
  assert.doesNotMatch(feedXml, /private-source-id|edition:secret/);
  assert.equal(calls.at(-1).limit, 1);
  const sitemapIndex = await handle(new Request('https://cedar.invalid/sitemap.xml'));
  const sitemapIndexBody = await sitemapIndex.text();
  assert.match(sitemapIndexBody, /sitemapindex/);
  assert.match(sitemapIndexBody, /sitemap-page.xml/);
  assert.match(sitemapIndexBody, /cursor%3Asecond-page/);
  const sitemapPage = await handle(new Request('https://cedar.invalid/sitemap-page.xml'));
  assert.match(await sitemapPage.text(), /urlset/);
  assert.match(sitemapPage.headers.get('link'), /sitemap-page.xml\?cursor=/);
  unavailable = true;
  const withdrawn = await handle(new Request('https://cedar.invalid/guides/public-guide'));
  assert.equal(withdrawn.status, 503);
  assert.equal(withdrawn.headers.get('cache-control'), 'no-store');
  unavailable = false;
  current = inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid', version: 'edition:2', text: 'Available again' });
  const retried = await handle(new Request('https://cedar.invalid/guides/public-guide'));
  assert.equal(retried.status, 200);
  assert.match(await retried.text(), /Available again/);
  assert.equal(calls.length, 7);
});

test('callable descriptors and package export metadata are valid JSON', () => {
  const toolRows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const part = JSON.parse(readFileSync(new URL('../part.json', import.meta.url), 'utf8'));
  assert.equal(toolRows.records[0].payload.id, 'tool:prepare-public-content-for-discovery');
  assert.equal(toolRows.records[0].payload.invoke.kind, 'container', 'pure input projection needs no computer capability grant');
  assert.equal(toolRows.records[0].payload.invoke.internet, false);
  assert.ok(part.public.includes('do-work/prepare-content-for-discovery.mjs'));
  assert.ok(part.public.includes('do-work/serve-content-for-discovery.mjs'));
});

test('declared stdin tool entrypoint returns prepared JSON', () => {
  const result = spawnSync(process.execPath, [new URL('../do-work/prepare-from-stdin.mjs', import.meta.url).pathname], { input: JSON.stringify(inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid' })), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.manifest.documents[0].canonicalUrl, 'https://cedar.invalid/guides/public-guide');
});

test('a site declares its trailing-slash policy and every output follows it', () => {
  const base = inputFor({ name: 'Cedar Field Lab', origin: 'https://cedar.invalid' });
  for (const [trailingSlash, declared, served] of [[true, '/guides/public-guide', '/guides/public-guide/'], [true, '/guides/public-guide/', '/guides/public-guide/'], [false, '/guides/public-guide/', '/guides/public-guide'], [undefined, '/guides/public-guide', '/guides/public-guide']]) {
    const input = structuredClone(base);
    input.site.trailingSlash = trailingSlash;
    input.routes[0].path = declared;
    const result = prepareContentForDiscovery(input);
    const url = `https://cedar.invalid${served}`;
    const doc = result.outputs.documents[0];
    assert.equal(doc.path, served);
    assert.equal(doc.canonicalUrl, url);
    assert.ok(doc.html.includes(`<link rel="canonical" href="${url}" />`));
    assert.ok(doc.html.includes(`<meta property="og:url" content="${url}" />`));
    assert.ok(doc.html.includes(`"mainEntityOfPage":"${url}"`));
    assert.equal(doc.jsonLd.mainEntityOfPage, url);
    assert.equal(result.outputs.sitemap.urls[0].loc, url);
    assert.equal(result.outputs.rss.items[0].link, url);
    assert.equal(result.outputs.rss.items[0].guid, url);
    assert.ok(result.outputs.llms.split('\n').includes(url));
    assert.equal(result.manifest.documents[0].canonicalUrl, url);
    assert.equal(result.manifest.site.trailingSlash, trailingSlash === true);
  }
  const root = structuredClone(base);
  root.site.trailingSlash = true;
  root.routes[0].path = '/';
  assert.equal(prepareContentForDiscovery(root).outputs.documents[0].canonicalUrl, 'https://cedar.invalid/');
  const invalid = structuredClone(base);
  invalid.site.trailingSlash = 'yes';
  assert.throws(() => prepareContentForDiscovery(invalid), /trailingSlash/);
});
