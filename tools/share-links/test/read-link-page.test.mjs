// The old codebase test/catalogue-screen-link-page.test.mjs (at commit b6ae0ebf815f): the facts
// assertions, run through the join in do-work/read-link-page.mjs (the owner's read, then the screen's facts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readLinkPage } from '../do-work/read-link-page.mjs';
import settings from '../web/src/link-page.json' with { type: 'json' };

const origin = () => 'https://app.example';
const namesWords = { not_here: 'Names are not available on this account.' };
const posts = [
  { post_id: 'post:one', status: 'posted', caption: 'Published   words', link: 'https://shop.example/post?ref=1', destinations: [{ platform: 'place-one' }] },
  { post_id: 'post:draft', status: 'draft', link: 'https://shop.example/draft' },
];
const page = { on: true, code: 'k7x2m9qa', name: 'Ana', title: 'Ana Shop', about: 'Shoes', links: [{ link_id: 'link-shop', label: 'Shop', url: 'https://shop.example' }] };
const at = () => new Date('2026-10-01T12:00:00Z');
let counter = 0;
const random = n => new Uint8Array(n).fill(++counter);
const read = extra => readLinkPage({ page, posts, settings, origin, namesWords, now: at, random, ...extra });

test('the facts answer the page the owner reads: on, title, its link and its posts, with nothing counted yet', () => {
  const facts = read({});
  assert.equal(facts.on, true);
  assert.equal(facts.title, 'Ana Shop');
  assert.deepEqual(facts.links.map(link => [link.link_id, link.label]), [['link-shop', 'Shop']]);
  assert.equal(facts.no_links, false);
  assert.deepEqual(facts.posts.map(post => post.id), ['post:one'], 'the draft is not listed');
  assert.equal(facts.counts.counted, false, 'nothing counted until someone came');
  assert.equal(facts.address, 'https://app.example/l/Ana');
});

test('a page that is off has no link to share, and its facts say so', () => {
  const facts = read({ page: { ...page, on: false } });
  assert.equal(facts.on, false);
});

test('an empty page lists no links and no posts rather than a made-up one', () => {
  const facts = readLinkPage({ page: { on: true, links: [] }, posts: [], settings, origin, namesWords, now: at, random });
  assert.equal(facts.no_links, true);
  assert.equal(facts.no_posts, true);
});
