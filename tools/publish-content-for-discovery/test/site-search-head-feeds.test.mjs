// A page's head advertises the site's feeds as RSS alternates, replaces any it already carried, and refuses a feed with no https
// address or no title. Made-up pages on invalid hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchHeadMarkup, searchMetaProblems, withSearchHead } from '../do-work/site-search-head.mjs';

const meta = {
  title: 'Cedar Field Lab',
  description: 'Notes on cedar.',
  canonical: 'https://cedar.invalid/articles',
  feeds: [{ title: 'Cedar Field Lab articles', href: 'https://cedar.invalid/articles/rss.xml' }],
};

test('each feed is written as an RSS alternate link with its title', () => {
  const markup = searchHeadMarkup(meta);
  assert.match(markup, /<link rel="alternate" type="application\/rss\+xml" title="Cedar Field Lab articles" href="https:\/\/cedar\.invalid\/articles\/rss\.xml"\/>/);
});

test('no feed link is written when the meta names none', () => {
  const { feeds, ...without } = meta;
  assert.doesNotMatch(searchHeadMarkup(without), /rel="alternate"/);
});

test('a page keeps one feed link: an old one is replaced, other alternates stay', () => {
  const page = '<html><head><link rel="alternate" type="application/rss+xml" title="old" href="https://cedar.invalid/old.xml"/><link rel="alternate" hreflang="fr" href="https://cedar.invalid/fr"/></head><body></body></html>';
  const html = withSearchHead(page, meta);
  assert.equal(html.match(/type="application\/rss\+xml"/g).length, 1);
  assert.doesNotMatch(html, /old\.xml/);
  assert.match(html, /hreflang="fr"/);
});

test('a feed with no https address or no title is refused', () => {
  assert.equal(searchMetaProblems({ ...meta, feeds: [{ title: 'x', href: 'http://cedar.invalid/rss.xml' }] }).length, 1);
  assert.equal(searchMetaProblems({ ...meta, feeds: [{ title: '', href: 'https://cedar.invalid/rss.xml' }] }).length, 1);
  assert.equal(searchMetaProblems({ ...meta, feeds: 'https://cedar.invalid/rss.xml' }).length, 1);
  assert.throws(() => searchHeadMarkup({ ...meta, feeds: [{ href: 'https://cedar.invalid/rss.xml' }] }), /feeds\[0\]\.title/);
});
