// Checks the list page limits (src/share-collection-store.mjs in the old source repo: PAGE_ITEMS 32, PAGE_BYTES 128 KB)
// as the list page reader applies them: a page over either limit is cut to the rows that fit, and the next cursor
// returns the rest. The old share cover caps (src/share-image-cover.mjs: 256 KB original and preview) are checked too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import limits from '../web/src/workspace/space-target-page.json' with { type: 'json' };
import { readSpaceListPage } from '../web/src/workspace/space-target-page.mjs';
import { MAX_ORIGINAL_COVER_BYTES, MAX_PREVIEW_COVER_BYTES, rasterImageTypeFor, savedImageCover } from '../web/src/share-image-cover.mjs';

const row = n => ({ item_id: `item-${n}`, kind: 'file', provenance: { added_at: '2026-11-20T00:00:00Z' } });
const pageOf = (count, extra = '') => ({ items: Array.from({ length: count }, (_, n) => row(n)), next_before: null, pad: extra });
const serve = page => async () => page;
const encodedBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const keyOf = item => `${item.provenance.added_at}${item.item_id}`;

// A stand-in for the items endpoint: rows newest first, filtered by kind, read strictly below `before`, up to `limit`.
function listing(rows) {
  return async url => {
    const query = new URL(url, 'http://items.test').searchParams;
    const kind = query.get('kind');
    const before = query.get('before');
    const limit = Number(query.get('limit') ?? 30);
    const visible = rows.filter(item => (!kind || item.kind === kind) && (!before || keyOf(item) < before));
    const items = visible.slice(0, limit);
    return { items, next_before: visible.length > limit ? keyOf(items.at(-1)) : null };
  };
}

// Newest first, with fixed-width keys so string order is time order.
const timed = (n, kind, pad = '') => ({
  item_id: `${kind}-${String(n).padStart(2, '0')}`,
  kind,
  provenance: { added_at: `2026-11-20T00:00:${String(n).padStart(2, '0')}Z` },
  pad,
});

// Pages through a list with next_before until it ends, and returns every row in the order they came.
async function readAll(address, read, options) {
  const seen = [];
  let before;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await readSpaceListPage(address, read, { ...options, before });
    assert.ok(page.items.length > 0, 'a page never comes back empty while more rows remain');
    seen.push(...page.items.map(item => item.item_id));
    before = page.next_before;
    if (!before) return seen;
  }
  throw new Error('the list did not end');
}

test('the old page limits are DATA with the old values', () => {
  assert.equal(limits.max_items, 32);
  assert.equal(limits.max_page_bytes, 128 * 1024);
  assert.equal(limits.default_limit, 30);
});

test('a page of 32 items is accepted and a page of 33 items is cut to 32 with a next cursor', async () => {
  const at32 = await readSpaceListPage('/a', serve(pageOf(32)), { limit: 32 });
  assert.equal(at32.items.length, 32);
  assert.equal(at32.next_before, null);
  const over = await readSpaceListPage('/a', serve(pageOf(33)), { limit: 32 });
  assert.equal(over.items.length, 32);
  assert.ok(over.next_before);
});

test('a page request above 32 rows is refused, as the old bounded-range check did', async () => {
  await assert.rejects(readSpaceListPage('/a', serve(pageOf(1)), { limit: 33 }), /invalid page size/);
  await assert.rejects(readSpaceListPage('/a', serve(pageOf(1)), { limit: 0 }), /invalid page size/);
});

test('a page of exactly 128 KB is kept whole, and one byte more is cut to the rows that fit', async () => {
  const exact = pageOf(2, '');
  exact.pad = 'x'.repeat(128 * 1024 - encodedBytes(exact));
  assert.equal(encodedBytes(exact), 128 * 1024);
  const kept = await readSpaceListPage('/a', serve(exact), { limit: 2 });
  assert.equal(kept.items.length, 2);
  assert.equal(kept.next_before, null);
  const over = pageOf(2, '');
  over.pad = 'x'.repeat(128 * 1024 - encodedBytes(over) + 1);
  const cut = await readSpaceListPage('/a', serve(over), { limit: 2 });
  assert.equal(cut.items.length, 1);
  assert.equal(cut.items[0].item_id, 'item-0');
  assert.equal(cut.next_before, keyOf(row(0)));
});

test('one row over the byte cap is still returned alone, so the caller can page on', async () => {
  const huge = pageOf(1, 'x'.repeat(128 * 1024));
  const page = await readSpaceListPage('/a', serve(huge), { limit: 1 });
  assert.equal(page.items.length, 1);
});

test('30 large rows that cannot fit one page: the first page is non-empty and short, and the cursor returns the rest in order', async () => {
  // Each row is a little over the byte cap divided by 30, so 30 rows would be over 128 KB.
  const pad = 'x'.repeat(Math.ceil(limits.max_page_bytes / 30) + 1);
  const rows = Array.from({ length: 30 }, (_, n) => timed(n, 'file', pad)).reverse();
  const server = listing(rows);
  const first = await readSpaceListPage('/a', server, { kinds: ['file'] });
  assert.ok(first.items.length > 0, 'the first page is not empty');
  assert.ok(first.items.length < 30, 'the first page is cut short');
  assert.ok(first.next_before, 'the first page names a next cursor');
  assert.ok(encodedBytes({ ...first, items: first.items }) <= limits.max_page_bytes);
  assert.deepEqual(await readAll('/a', server, { kinds: ['file'] }), rows.map(item => item.item_id));
});

test('two kinds whose merged page is too large: every row comes back once, in order', async () => {
  const pad = 'x'.repeat(Math.ceil(limits.max_page_bytes / 30) + 1);
  const files = Array.from({ length: 30 }, (_, n) => timed(n, 'file', pad));
  const notes = [2, 10, 20, 27].map(n => timed(n, 'note', 'small'));
  const rows = [...files, ...notes].sort((a, b) => keyOf(a) < keyOf(b) ? 1 : keyOf(a) > keyOf(b) ? -1 : 0);
  const server = listing(rows);
  const seen = await readAll('/a', server, { kinds: ['file', 'note'] });
  assert.deepEqual(seen, rows.map(item => item.item_id));
});

test('several kinds share one page limit: a large kind page is cut, and the merged page still returns', async () => {
  const over = pageOf(1, 'x'.repeat(128 * 1024));
  const cut = await readSpaceListPage('/a', serve(over), { kinds: ['file', 'note'], limit: 5 });
  assert.equal(cut.items.length, 1);
  const merged = await readSpaceListPage('/a', serve(pageOf(3)), { kinds: ['file', 'note'], limit: 5 });
  assert.ok(merged.items.length <= 5);
});

test('the old 256 KB cover caps and the preview refusal are unchanged', () => {
  assert.equal(MAX_ORIGINAL_COVER_BYTES, 256 * 1024);
  assert.equal(MAX_PREVIEW_COVER_BYTES, 256 * 1024);
  const poster = bytes => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;
  assert.equal(savedImageCover({ poster: poster(MAX_PREVIEW_COVER_BYTES) })?.bytes.length, MAX_PREVIEW_COVER_BYTES);
  assert.equal(savedImageCover({ poster: poster(MAX_PREVIEW_COVER_BYTES + 1) }), null);
  assert.equal(rasterImageTypeFor('image/jpeg'), 'image/jpeg');
  assert.equal(rasterImageTypeFor('application/octet-stream', 'shot.PNG'), 'image/png');
  assert.equal(rasterImageTypeFor('text/html', 'x.png'), null);
});
