// The brand list is handed in as rows; each write comes back as keep with the value it expected. The store (played here
// by a Map) applies a keep only when the record still holds what the run expected, so a moved record is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import looks from '../../choose-and-publish-screen-looks/src/workspace/looks.json' with { type: 'json' };
import { runBrandKit } from '../read-data/brand-asset-actions.mjs';

const look = id => looks.themes.find(row => row.payload.id === id).payload;
const LIST = 'list:brand-assets';
const ROW = id => `record:brand-assets:${id}`;

// The caller's store: records by id as { type, value }. stored() reads what a run needs; apply() keeps its writes.
function storeOf(held) {
  const stored = (extra = {}) => ({
    list: held.get(LIST)?.value ?? null,
    rows: [...held].filter(([, record]) => record.type === 'record:brand-assets')
      .map(([id, record]) => ({ id: id.slice('record:brand-assets:'.length), values: structuredClone(record.value) })),
    worn: 'trillion', look: look('trillion'), mayDelete: true, ...extra,
  });
  const apply = result => {
    for (const { id, type, value, expected } of result.keep) {
      assert.deepEqual(held.get(id) ? { type: held.get(id).type, value: held.get(id).value } : null, expected, `${id} moved since the run read it`);
      value === null ? held.delete(id) : held.set(id, { type, value: structuredClone(value) });
    }
    return result;
  };
  return {
    run: (input, extra) => apply(runBrandKit({ ...input, stored: stored(extra) })),
    stored,
    apply,
  };
}

test('brand edits keep the list and its rows; deleting the list keeps its asset records', () => {
  const held = new Map();
  const store = storeOf(held);
  store.run({ action: 'create' });
  assert.equal(held.get(LIST).type, 'list');
  store.run({ action: 'save', row_id: 'active', values: { family: 'one', role: 'wordmark', note: 'keep' } });
  store.run({ action: 'edit', row_id: 'active', values: { name: 'Logo' } });
  assert.equal(held.get(ROW('active')).value.note, 'keep', 'an edit merges into the row');
  store.run({ action: 'select', family: 'one' });
  assert.throws(() => store.run({ action: 'remove', row_id: 'active' }), /Select another/);
  store.run({ action: 'save', row_id: 'spare', values: { family: 'two', role: 'mark' } });
  store.run({ action: 'remove', row_id: 'spare' });
  assert.equal(held.has(ROW('spare')), false);
  store.run({ action: 'delete' });
  assert.equal(held.has(LIST), false);
  assert.equal(held.has(ROW('active')), true);
  store.run({ action: 'create' });
  assert.equal(held.has(LIST), true);
});

test('a write whose record moved after the run read it is refused by the store', () => {
  const held = new Map([[LIST, { type: 'list', value: { row_type: 'brand-assets', label: 'Brand assets' } }]]);
  const store = storeOf(held);
  const result = runBrandKit({ action: 'save', row_id: 'active', values: { family: 'one', role: 'wordmark' }, stored: store.stored() });
  held.set(ROW('active'), { type: 'record:brand-assets', value: { family: 'other', role: 'mark' } });
  assert.deepEqual(result.keep, [{ id: ROW('active'), type: 'record:brand-assets', value: { family: 'one', role: 'wordmark' }, expected: null }]);
  assert.throws(() => store.apply(result), /moved since the run read it/);
});

test('a call that is not handed what it needs keeps nothing and names the need', () => {
  const held = new Map([[LIST, { type: 'list', value: { row_type: 'brand-assets' } }]]);
  const store = storeOf(held);
  const read = runBrandKit({ action: 'read', stored: { list: held.get(LIST).value } });
  assert.deepEqual(read, { needs: ['rows', 'worn', 'look'], keep: [], complete: false });
  const save = runBrandKit({ action: 'save', row_id: 'x', values: { family: 'one' }, stored: { list: null } });
  assert.deepEqual(save, { needs: ['rows'], keep: [], complete: false });
  const remove = runBrandKit({ action: 'delete', stored: { list: held.get(LIST).value } });
  assert.deepEqual(remove, { needs: ['mayDelete'], keep: [], complete: false }, 'leaving out the in-use flag refuses the delete');
  assert.equal(held.has(LIST), true);
  assert.throws(() => store.run({ action: 'delete' }, { mayDelete: false }), /in use/);
  assert.equal(held.has(LIST), true);
});

test('create keeps nothing when the list is already there, and writes the list only when it is absent', () => {
  const held = new Map();
  const store = storeOf(held);
  const first = store.run({ action: 'create' });
  assert.equal(first.keep.length, 1);
  const again = store.run({ action: 'create' });
  assert.deepEqual(again.keep, []);
  assert.equal(again.rows.length, 0, 'retrying create keeps one list');
});

test('builders import, resolve, export and remove brand rows from the rows they are handed', () => {
  const rows = family => [
    { id: 'brand', values: { role: 'selection', family } },
    ...['old', 'new'].flatMap(name => ['black', 'white'].flatMap(colour => ['svg', 'png'].map(format => ({
      id: `${name}-${colour}-${format}`, values: { family: name, role: 'wordmark', format,
        background: `${colour} on transparent`, url: `https://example.com/${name}-${colour}.${format}` },
    })))),
  ];
  const held = new Map([[LIST, { type: 'list', value: { row_type: 'brand-assets' } }]]);
  const store = storeOf(held);
  store.run({ action: 'import', rows: rows('new').slice(1) });
  store.run({ action: 'import', rows: rows('new').slice(1) });
  assert.equal(store.run({ action: 'read' }).rows.length, rows('new').length - 1, 'retrying import upserts the same rows');
  store.run({ action: 'edit', row_id: 'new-black-svg', values: { url: 'https://example.com/new-black.svg' } });
  store.run({ action: 'select', family: 'new' });
  assert.equal(store.run({ action: 'export' }).rows.length, rows('new').length);
  assert.equal(store.run({ action: 'resolve', role: 'wordmark', format: 'svg' }).asset.url, 'https://example.com/new-black.svg');
  assert.throws(() => store.run({ action: 'remove', row_id: 'brand' }), /Select another/);
  store.run({ action: 'save', row_id: 'spare', values: { family: 'spare', role: 'mark' } });
  store.run({ action: 'remove', row_id: 'spare' });
  assert.equal(store.run({ action: 'read' }).rows.length, rows('new').length, 'the spare row is gone and the selection row is still there');
  assert.throws(() => store.run({ action: 'import', rows: [{ id: 'bad', values: { url: 'http://example.com/a.svg' } }] }), /HTTPS/);
  assert.throws(() => runBrandKit({ action: 'publish', stored: store.stored() }), /not publish/);
});

test('a read with no worn look is refused rather than drawn without one', () => {
  const held = new Map([[LIST, { type: 'list', value: { row_type: 'brand-assets' } }]]);
  assert.throws(() => storeOf(held).run({ action: 'read' }, { worn: null, look: null }), /No Screen look is worn/);
});
