import test from 'node:test';
import assert from 'node:assert/strict';
import { brandOwnersOverDoor } from '../read-data/brand-owners-over-door.mjs';
import { runBrandKit, readBrandPresentationWithin } from '../read-data/brand-asset-actions.mjs';

test('brand edits use the current list identities and conditional door writes; deleting preserves asset records', async () => {
  const held = new Map();
  const writes = [];
  const door = {
    async read(type, id) { const row = held.get(id); return row?.type === type ? structuredClone(row.value) : null; },
    async *list({ type }) { for (const [id, row] of held) if (row.type === type) yield { id, ...structuredClone(row) }; },
    async write(records, { key }) {
      assert.ok(key);
      for (const record of records) assert.deepEqual(held.get(record.id) ?? null, record.expected);
      writes.push(structuredClone(records));
      for (const { id, type, value } of records) value === null ? held.delete(id) : held.set(id, { type, value: structuredClone(value) });
    },
  };
  const owner = brandOwnersOverDoor(door, { looks: {} });
  await runBrandKit(owner, { action: 'create' });
  await runBrandKit(owner, { action: 'save', row_id: 'active', values: { family: 'one', role: 'wordmark', note: 'keep' } });
  await runBrandKit(owner, { action: 'edit', row_id: 'active', values: { name: 'Logo' } });
  assert.equal(held.get('record:brand-assets:active').value.note, 'keep');
  await runBrandKit(owner, { action: 'select', family: 'one' });
  await assert.rejects(runBrandKit(owner, { action: 'remove', row_id: 'active' }), /Select another/);
  await runBrandKit(owner, { action: 'save', row_id: 'spare', values: { family: 'two', role: 'mark' } });
  await runBrandKit(owner, { action: 'remove', row_id: 'spare' });
  assert.equal(held.has('record:brand-assets:spare'), false);
  await runBrandKit(owner, { action: 'delete' });
  assert.equal(held.has('list:brand-assets'), false);
  assert.equal(held.has('record:brand-assets:active'), true);
  await runBrandKit(owner, { action: 'create' });
  assert.equal(held.has('list:brand-assets'), true);
  assert.ok(writes.length >= 7);
  let published = null;
  const publication = { async serviceRecord(label) { assert.equal(label, 'brand-presentation'); return published; } };
  assert.equal(await readBrandPresentationWithin(publication), null);
  published = { tone: 'dark' };
  assert.deepEqual(await readBrandPresentationWithin(publication), published);
});

test('brand create propagates read errors and never replaces an existing list', async () => {
  let saved = false;
  const unavailable = new Error('temporarily unavailable');
  await assert.rejects(runBrandKit({ lists: {
    async read() { throw unavailable; }, async find() { throw unavailable; }, async save() { saved = true; },
  } }, { action: 'create' }), error => error === unavailable);
  assert.equal(saved, false);
});
