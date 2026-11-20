// Replays the old share collection store's limit assertions (the old source repo, src/share-collection-store.mjs:
// PAGE_ITEMS 32, PAGE_BYTES 128 KB, a page over either refused) and the old share cover caps
// (src/share-image-cover.mjs: 256 KB original and preview) against the current owners.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import limits from '../web/src/workspace/space-target-page.json' with { type: 'json' };
import { readSpaceListPage } from '../web/src/workspace/space-target-page.mjs';
import { MAX_ORIGINAL_COVER_BYTES, MAX_PREVIEW_COVER_BYTES, rasterImageTypeFor, savedImageCover } from '../web/src/share-image-cover.mjs';

const row = n => ({ item_id: `item-${n}`, kind: 'file', provenance: { added_at: '2026-11-20T00:00:00Z' } });
const pageOf = (count, extra = '') => ({ items: Array.from({ length: count }, (_, n) => row(n)), next_before: null, pad: extra });
const serve = page => async () => page;
const encodedBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('the old page limits are DATA with the old values', () => {
  assert.equal(limits.max_items, 32);
  assert.equal(limits.max_page_bytes, 128 * 1024);
  assert.equal(limits.default_limit, 30);
});

test('a page of 32 items is accepted and a page of 33 items is refused', async () => {
  const at32 = await readSpaceListPage('/a', serve(pageOf(32)), { limit: 32 });
  assert.equal(at32.items.length, 32);
  await assert.rejects(readSpaceListPage('/a', serve(pageOf(33)), { limit: 32 }), /too many items/);
});

test('a page request above 32 rows is refused, as the old bounded-range check did', async () => {
  await assert.rejects(readSpaceListPage('/a', serve(pageOf(1)), { limit: 33 }), /invalid page size/);
  await assert.rejects(readSpaceListPage('/a', serve(pageOf(1)), { limit: 0 }), /invalid page size/);
});

test('a page of exactly 128 KB is accepted and one byte more is refused', async () => {
  const base = encodedBytes(pageOf(1, ''));
  const exact = pageOf(1, 'x'.repeat(128 * 1024 - base));
  assert.equal(encodedBytes(exact), 128 * 1024);
  assert.equal((await readSpaceListPage('/a', serve(exact), { limit: 1 })).items.length, 1);
  const over = pageOf(1, 'x'.repeat(128 * 1024 - base + 1));
  await assert.rejects(readSpaceListPage('/a', serve(over), { limit: 1 }), /too large to show/);
});

test('several kinds share one page limit: each kind page is checked', async () => {
  const over = pageOf(1, 'x'.repeat(128 * 1024));
  await assert.rejects(readSpaceListPage('/a', serve(over), { kinds: ['file', 'note'], limit: 5 }), /too large to show/);
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
