// tools/publish-content-for-discovery: the search head of a built page and the robots.txt and llms.txt of a site, from DATA.
// Made-up pages on invalid hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { llmsTxt, robotsTxt, searchHeadMarkup, searchMetaProblems, withSearchHead } from '../do-work/site-search-head.mjs';

const meta = {
  title: 'Cedar Field Lab',
  description: 'A lab for "careful" cedar & pine.',
  canonical: 'https://cedar.invalid/',
  og: { type: 'website', title: 'Cedar Field Lab', description: 'A lab.', image: 'https://cedar.invalid/cover.png', site_name: 'Cedar', locale: 'en_US' },
  twitter: { card: 'summary_large_image' },
  jsonld: [{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Cedar', url: 'https://cedar.invalid/', note: '</script><!--' }],
};

test('a valid meta writes title, description, canonical, Open Graph, Twitter and JSON-LD', () => {
  const head = searchHeadMarkup(meta);
  assert.match(head, /<title>Cedar Field Lab<\/title>/);
  assert.match(head, /<meta name="description" content="A lab for &quot;careful&quot; cedar &amp; pine."\/>/);
  assert.match(head, /<link rel="canonical" href="https:\/\/cedar\.invalid\/"\/>/);
  assert.match(head, /<meta property="og:type" content="website"\/>/);
  assert.match(head, /<meta property="og:url" content="https:\/\/cedar\.invalid\/"\/>/);
  assert.match(head, /<meta property="og:image" content="https:\/\/cedar\.invalid\/cover\.png"\/>/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image"\/>/);
  assert.match(head, /<meta name="twitter:title" content="Cedar Field Lab"\/>/);
  assert.match(head, /<script type="application\/ld\+json">/);
});

test('JSON-LD cannot end its script element', () => {
  const head = searchHeadMarkup(meta);
  assert.equal(head.includes('</script><!--'), false);
  assert.match(head, /\\u003c\/script\\u003e/);
});

test('a page-level copy of the search tags is replaced, and the visible body is untouched', () => {
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Old</title><meta name="description" content="old"/><link rel="canonical" href="https://cedar.invalid/old"/><meta property="og:title" content="old"/><script type="application/ld+json">{"@type":"Thing"}</script><link rel="stylesheet" href="/app.css"/></head><body><main><h1>Visible words</h1></main></body></html>';
  const out = withSearchHead(page, meta);
  assert.equal((out.match(/<title>/g) ?? []).length, 1);
  assert.equal((out.match(/rel="canonical"/g) ?? []).length, 1);
  assert.equal(out.includes('>Old<'), false);
  assert.equal(out.includes('{"@type":"Thing"}'), false);
  assert.match(out, /<link rel="stylesheet" href="\/app.css"\/>/);
  assert.match(out, /<body><main><h1>Visible words<\/h1><\/main><\/body>/);
});

test('a noindex robots directive is written only when the meta gives one', () => {
  assert.match(searchHeadMarkup({ ...meta, robots: 'noindex' }), /<meta name="robots" content="noindex"\/>/);
  assert.equal(searchHeadMarkup(meta).includes('name="robots"'), false);
});

test('refusals list every problem', () => {
  const problems = searchMetaProblems({ title: '', description: 'x', canonical: 'http://cedar.invalid/', og: { type: 'thing' }, jsonld: [{ '@type': 'Thing' }] });
  assert.equal(problems.length, 6);
  assert.throws(() => searchHeadMarkup({ ...meta, canonical: 'ftp://cedar.invalid/' }), /canonical/);
  assert.throws(() => withSearchHead('<html><body></body></html>', meta), /no <head>/);
});

test('robots.txt lists each group and the sitemap', () => {
  const body = robotsTxt({
    sitemap: 'https://cedar.invalid/sitemap.xml',
    groups: [{ agents: ['GPTBot', 'ClaudeBot'], allow: ['/'] }, { agents: ['*'], allow: ['/'], disallow: ['/members'] }],
  });
  assert.equal(body, 'User-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: *\nAllow: /\nDisallow: /members\n\nSitemap: https://cedar.invalid/sitemap.xml\n');
  assert.throws(() => robotsTxt({ sitemap: 'http://cedar.invalid/sitemap.xml', groups: [{ agents: ['*'] }] }), /https/);
});

test('llms.txt has the name, a summary, and sections of links', () => {
  const body = llmsTxt({
    name: 'Cedar Field Lab',
    summary: 'Notes on cedar.',
    sections: [{ title: 'Articles', links: [{ title: 'Pine', url: 'https://cedar.invalid/pine', note: 'on pine' }, { title: 'Oak', url: 'https://cedar.invalid/oak' }] }],
  });
  assert.equal(body, '# Cedar Field Lab\n\n> Notes on cedar.\n\n## Articles\n\n- [Pine](https://cedar.invalid/pine): on pine\n- [Oak](https://cedar.invalid/oak)\n');
});
