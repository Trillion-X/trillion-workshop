import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRss, readFeed } from '../do-work/rss.ts';

const channel = { title: 'T & Co', description: 'D', origin: 'https://example.com' };
const card = { slug: 'a b', title: '<b>Hi</b>', description: 'x "y"', category: 'c', published_at: '2026-01-02T00:00:00Z' };

test('the feed is RSS 2.0, escapes every value and links each article by slug', () => {
  const xml = buildRss(channel, [card]);
  assert.match(xml, /<rss version="2.0">/);
  assert.match(xml, /<title>T &amp; Co<\/title>/);
  assert.match(xml, /<title>&lt;b&gt;Hi&lt;\/b&gt;<\/title>/);
  assert.match(xml, /<link>https:\/\/example.com\/articles\/a%20b<\/link>/);
  assert.match(xml, /<pubDate>Fri, 02 Jan 2026 00:00:00 GMT<\/pubDate>/);
  assert.doesNotMatch(xml, /<b>/);
});

test('an origin with a path or without https is refused', () => {
  assert.throws(() => buildRss({ ...channel, origin: 'http://example.com' }, []), TypeError);
  assert.throws(() => buildRss({ ...channel, origin: 'https://example.com/x' }, []), TypeError);
});

test('readFeed reads published cards and answers xml', async () => {
  const { xml } = await readFeed({ database: 'd', channel }, async () => [{ slug: 'a', title: 'A', description: '', category: '', published_at: null }]);
  assert.match(xml, /<item><title>A<\/title>/);
});
