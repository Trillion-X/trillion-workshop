import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createLinkPageTable, makeLinkPage, linkPageOverDoor, placeOf, handleLinkPageRequest } from '../read-data/link-page.mjs';

const settings = {
  record_id: 'link-page:yours', record_type: 'link-page', kv_prefix: 'link-page:',
  unknown_place: 'direct', place_param: 'from', post_statuses: ['posted', 'partial'],
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
function world(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...binds) { const stmt = db.prepare(query); const rows = /^\s*select/i.test(query) ? stmt.all(...binds) : (stmt.run(...binds), []); return { toArray: () => rows }; } };
  createLinkPageTable(sql);
  const records = new Map(), codes = new Map();
  const writes = [];
  const eeaf = { read: id => records.get(id) ?? null, write: rows => { writes.push(rows); for (const row of rows) records.set(row.id, structuredClone(row.value)); } };
  let at = Date.parse('2026-10-01T12:00:00Z'), sequence = 0;
  const deps = { sql, eeaf, settings, posts: () => posts, kv: { put: async (key, value) => codes.set(key, value), delete: async key => codes.delete(key) }, storeId: 'selected-account', origin: () => 'https://app.example', now: () => new Date(at), random: n => Uint8Array.from({ length: n }, () => ++sequence % 256), namesWords: { not_here: 'Names unavailable' }, ...overrides };
  return { owner: makeLinkPage(deps), deps, records, codes, writes, db, later: days => { at += days * 86400000; } };
}

test('on/off reuses one code, lists only published HTTPS posts, and exposes no private counts', async t => {
  const w = world(); t.after(() => w.db.close());
  assert.equal(w.owner.visit('place-one'), null);
  const on = await w.owner.change({ title: 'Owner', links: [{ label: 'Site', url: 'https://site.example' }] });
  assert.match(on.code_address, /\/l\/[0-9a-f]{20}$/);
  assert.deepEqual(on.posts.map(p => p.post_id), ['post:one']);
  const visit = w.owner.visit('place-one');
  assert.deepEqual(visit.posts, [{ item: 'post:one', label: 'Published words' }]);
  assert.equal(Object.hasOwn(visit, 'counts'), false);
  await w.owner.change({ on: false });
  assert.equal(w.codes.size, 0);
  assert.equal(w.owner.open('post:one', 'place-one'), null);
  assert.equal((await w.owner.change({ on: true })).address, on.address);
  assert.equal(w.codes.size, 1);
});

test('counts retain totals and recent windows; opens are limited to listed items and tagged', async t => {
  const w = world(); t.after(() => w.db.close());
  const { links } = await w.owner.change({ add_link: { label: 'Site', url: 'https://site.example' } });
  w.owner.visit('place-one'); w.owner.visit(placeOf('invalid place!', settings));
  const url = new URL(w.owner.open('post:one', 'place-one'));
  assert.equal(url.searchParams.get('ref'), '1');
  assert.equal(url.searchParams.get('utm_content'), 'post:one');
  assert.equal(url.searchParams.get('utm_source'), 'place-one');
  w.later(40); w.owner.open(links[0].link_id, 'place-two');
  assert.equal(w.owner.open('post:draft', 'place-one'), null);
  w.owner.visit('place-one', { counted: false });
  w.owner.open('post:one', 'place-one', { counted: false });
  const { counts } = w.owner.read();
  assert.equal(counts.visits, 2); assert.equal(counts.visits_recent, 0);
  assert.equal(counts.opens, 2); assert.equal(counts.opens_recent, 1);
  assert.deepEqual(counts.by_place['place-one'], { visits: 1, opens: 1 });
});

test('invalid links, duplicate ids and absent removals are refused', async t => {
  const w = world(); t.after(() => w.db.close());
  for (const url of ['http://a.example', 'https://user:@a.example', 'javascript:alert(1)']) await assert.rejects(w.owner.change({ add_link: { label: 'A', url } }), /https/);
  await assert.rejects(w.owner.change({ links: [{ link_id: 'same', label: 'A', url: 'https://a.example' }, { link_id: 'same', label: 'B', url: 'https://b.example' }] }), /same link_id/);
  await assert.rejects(w.owner.change({ remove_link: 'absent' }), /no link/);
});

test('interrupted commit keeps pending code and retry does not leave a second public pointer', async t => {
  let fail = true;
  const w = world({ commit: async change => { if (fail) throw Error('interrupted'); await change(); } }); t.after(() => w.db.close());
  await assert.rejects(w.owner.change({ on: true }), /interrupted/);
  const pending = w.records.get(settings.record_id).pending_code;
  assert.equal(w.owner.read().on, false);
  fail = false;
  const on = await w.owner.change({ on: true });
  assert.equal(on.code_address, `https://app.example/l/${pending}`);
  assert.deepEqual([...w.codes.keys()], [`link-page:${pending}`]);
});

test('name authority points only while on and releases replaced aliases', async t => {
  const calls = [];
  const names = { claim: async (name, code) => { calls.push(['claim', name, code]); return name; }, point: async (name, code) => calls.push(['point', name, code]), release: async name => calls.push(['release', name]) };
  const w = world({ names }); t.after(() => w.db.close());
  const on = await w.owner.change({ on: true, name: 'first-name' });
  assert.equal(on.address, 'https://app.example/l/first-name');
  assert.equal(calls[0][2], on.code_address.split('/').pop());
  await w.owner.change({ on: false });
  assert.deepEqual(calls[1], ['point', 'first-name', null]);
  await w.owner.change({ name: 'next-name' });
  assert.deepEqual(calls.slice(-2), [['claim', 'next-name', null], ['release', 'first-name']]);
});

test('record bridge waits for conditional writes and rejects a stale account snapshot', async t => {
  const w = world(); t.after(() => w.db.close());
  let held = null;
  const writes = [];
  const door = { readRecord: async () => held, write: async rows => {
    const [row] = rows; writes.push(row);
    assert.deepEqual(row.expected, held);
    await new Promise(resolve => setTimeout(resolve, 1));
    held = { type: row.type, value: structuredClone(row.value) };
  } };
  const owner = await linkPageOverDoor({ ...w.deps, door });
  await owner.change({ on: true });
  assert.equal(held.value.on, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].expected, null);
  assert.equal(writes[1].expected.value.on, false);
  const stale = await linkPageOverDoor({ ...w.deps, door });
  await owner.change({ title: 'Newer' });
  await assert.rejects(stale.change({ title: 'Stale' }), /Expected values/);
  assert.equal(held.value.title, 'Newer');
});

test('HTTP adapter preserves the shared failure owner and input error statuses', async () => {
  const busy = Error('busy');
  const failureOf = error => ({ tries_again_later: error === busy });
  await assert.rejects(handleLinkPageRequest({ read() { throw busy; } }, new Request('https://app.example'), { failureOf }), error => error === busy);
  const response = await handleLinkPageRequest({}, new Request('https://app.example', { method: 'POST', body: '{' }), { failureOf });
  assert.equal(response.status, 400);
});
