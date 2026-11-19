import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLinkPage, placeOf, handleLinkPageRequest } from '../read-data/link-page.mjs';

// The page is values: the caller keeps the steps `change` answers, and the count rows `visit` and `open` answer.
const settings = {
  kv_prefix: 'link-page:', unknown_place: 'direct', place_param: 'from', post_statuses: ['posted', 'partial'],
  max_posts: 20, max_links: 30, max_title_characters: 80, max_about_characters: 300,
  max_label_characters: 80, caption_characters: 140, recent_days: 30,
  link_tags: [{ param: 'utm_source', from: 'place' }, { param: 'utm_medium', value: 'link_in_bio' }, { param: 'utm_content', from: 'item' }],
  words: { post_without_words: 'A post' },
};
const posts = [
  { post_id: 'post:one', status: 'posted', caption: 'Published   words', link: 'https://shop.example/post?ref=1', destinations: [{ platform: 'place-one' }] },
  { post_id: 'post:draft', status: 'draft', link: 'https://shop.example/draft' },
  { post_id: 'post:unsafe', status: 'posted', link: 'http://shop.example/unsafe' },
];
const origin = () => 'https://app.example';
const namesWords = { not_here: 'Names are not available on this account.' };
let counter = 0;
const random = n => new Uint8Array(n).fill(++counter);

// A small host for the tests: it keeps the steps `change` answers, the page and the count rows, as the recipe does.
function host({ names = null, now = '2026-10-01T12:00:00Z' } = {}) {
  let at = Date.parse(now);
  const state = { page: null, counts: [], kv: new Map() };
  const clock = () => new Date(at);
  const owner = () => makeLinkPage({ page: state.page, counts: state.counts, posts, settings, origin, names, namesWords, now: clock, random });
  async function apply(steps) {
    for (const step of steps) {
      if (step.keep) state.page = structuredClone(step.keep);
      else if (step.kv_put) state.kv.set(step.kv_put, 'selected-account');
      else if (step.kv_delete) state.kv.delete(step.kv_delete);
      else if (step.release) state.releases.push(step.release);
    }
  }
  const keepCount = row => { if (row) { const hit = state.counts.find(r => r.what === row.what && r.item === row.item && r.place === row.place && r.day === row.day); if (hit) hit.count += 1; else state.counts.push({ ...row, count: 1 }); } };
  return {
    state,
    read: () => owner().read(),
    async change(input) { const answer = await owner().change(input); await apply(answer.steps); return owner().read(); },
    visit(place, opts) { const v = owner().visit(place, opts); if (v) keepCount(v.count); return v; },
    open(item, place, opts) { const o = owner().open(item, place, opts); if (o) keepCount(o.count); return o; },
    later: days => { at += days * 86400000; },
  };
}

test('on and off keep one code, list only published HTTPS posts, and expose no counts', async () => {
  const w = host();
  assert.equal(w.visit('place-one'), null);
  const on = await w.change({ title: 'Owner', links: [{ link_id: 'site', label: 'Site', url: 'https://site.example' }] });
  assert.match(on.code_address, /\/l\/[0-9a-f]{20}$/);
  assert.deepEqual(on.posts.map(p => p.post_id), ['post:one']);
  const visit = w.visit('place-one');
  assert.deepEqual(visit.view.posts, [{ item: 'post:one', label: 'Published words' }]);
  assert.equal(Object.hasOwn(visit.view, 'counts'), false);
  const code = w.state.page.code;
  await w.change({ on: false });
  assert.equal(w.state.kv.size, 0);
  assert.equal(w.open('post:one', 'place-one'), null);
  assert.equal((await w.change({ on: true })).code_address, on.code_address);
  assert.equal(w.state.page.code, code);
});

test('a first on keeps the pending code, points the public code, then keeps the page on', async () => {
  const answer = await makeLinkPage({ page: null, counts: [], posts, settings, origin, namesWords, random }).change({ on: true });
  assert.deepEqual(answer.steps.map(step => Object.keys(step)[0]), ['keep', 'kv_put', 'keep']);
  assert.equal(answer.steps[0].keep.on, false);
  assert.equal(answer.steps[0].keep.pending_code, answer.page.code);
  assert.equal(answer.steps[1].kv_put, `link-page:${answer.page.code}`);
  assert.equal(answer.steps[2].keep.on, true);
});

test('a retry after an interrupted first on reuses the pending code', async () => {
  const kept = { on: false, code: null, pending_code: 'abcdef0123456789abcd', links: [] };
  const answer = await makeLinkPage({ page: kept, counts: [], posts, settings, origin, namesWords, random }).change({ on: true });
  assert.equal(answer.page.code, 'abcdef0123456789abcd');
  assert.equal(Object.hasOwn(answer.page, 'pending_code'), false);
});

test('counts are sums of day rows; opens are limited to listed items and tagged', async () => {
  const w = host();
  await w.change({ add_link: { link_id: 'site', label: 'Site', url: 'https://site.example' } });
  w.visit('place-one'); w.visit(placeOf('invalid place!', settings));
  const url = new URL(w.open('post:one', 'place-one').url);
  assert.equal(url.searchParams.get('ref'), '1');
  assert.equal(url.searchParams.get('utm_content'), 'post:one');
  assert.equal(url.searchParams.get('utm_source'), 'place-one');
  w.later(40); w.open('site', 'place-two');
  assert.equal(w.open('post:draft', 'place-one'), null);
  w.visit('place-one', { counted: false });
  const { counts } = w.read();
  assert.equal(counts.visits, 2); assert.equal(counts.visits_recent, 0);
  assert.equal(counts.opens, 2); assert.equal(counts.opens_recent, 1);
  assert.deepEqual(counts.by_place['place-one'], { visits: 1, opens: 1 });
});

test('a visit to an off page is refused: nothing is shown or counted', async () => {
  const w = host();
  assert.equal(w.visit('place-one'), null);
  assert.equal(w.state.counts.length, 0);
});

test('invalid links, duplicate ids and absent removals are refused', async () => {
  const w = host();
  const owner = makeLinkPage({ page: null, counts: [], posts, settings, origin, namesWords, random });
  for (const url of ['http://a.example', 'https://user:@a.example', 'javascript:alert(1)']) await assert.rejects(owner.change({ add_link: { label: 'A', url } }), /https/);
  await assert.rejects(owner.change({ links: [{ link_id: 'same', label: 'A', url: 'https://a.example' }, { link_id: 'same', label: 'B', url: 'https://b.example' }] }), /same link_id/);
  await assert.rejects(owner.change({ remove_link: 'absent' }), /no link/);
  assert.equal(w.state.page, null);
});

test('name authority points only while on and releases replaced aliases', async () => {
  const calls = [];
  const names = {
    claim: async (name, code) => { calls.push(['claim', name, code]); return name; },
    point: async (name, code) => { calls.push(['point', name, code]); },
    release: async name => { calls.push(['release', name]); },
  };
  const w = host({ names });
  const on = await w.change({ on: true, name: 'first-name' });
  assert.equal(on.address, 'https://app.example/l/first-name');
  assert.equal(calls[0][2], on.code_address.split('/').pop());
  await w.change({ on: false });
  assert.deepEqual(calls[1], ['point', 'first-name', null]);
  await w.change({ name: 'next-name' });
  assert.deepEqual(calls.slice(-2), [['claim', 'next-name', null], ['release', 'first-name']]);
});

test('HTTP adapter preserves the shared failure owner and input error statuses', async () => {
  const busy = Error('busy');
  const failureOf = error => ({ tries_again_later: error === busy });
  await assert.rejects(handleLinkPageRequest({ read() { throw busy; } }, new Request('https://app.example'), { failureOf }), error => error === busy);
  const response = await handleLinkPageRequest({ change: async () => { throw new Error('x'); } }, new Request('https://app.example', { method: 'POST', body: '{' }), { failureOf });
  assert.equal(response.status, 400);
});
