import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { decomposedRecords, openRecords, RECORD_MODEL } from '../src/record-engine.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

async function fresh() {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  const lists = makeLists({ eeaf: records });
  await lists.save({
    id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
    fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'order', label: 'Order', kind: 'text' }],
    indexes: [{ name: 'manual_order', fields: ['order'] }],
  });
  await lists.putRows('tasks', { rows: [
    { id: 'c', values: { name: 'C', order: 'c' } },
    { id: 'a', values: { name: 'A', order: 'a' } },
    { id: 'b', values: { name: 'B', order: 'b' } },
  ] });
  return { host, records, lists };
}

function buildTables(records) {
  for (let page = 0; page < 100 && !records.indexReady('record:ordered-task', 'manual_order'); page += 1) {
    records.backfillTables({ limit: 2 });
  }
  assert.equal(records.indexReady('record:ordered-task', 'manual_order'), true);
}

const ids = entries => entries.map(entry => entry.id.slice('record:ordered-task:'.length));

test('list-authored indexes read typed SQL pages with value and id tuple bounds', async () => {
  const { host, records } = await fresh();
  try {
    assert.equal(records.indexDeclared('record:ordered-task', 'manual_order'), true);
    assert.equal(records.indexReady('record:ordered-task', 'manual_order'), false);
    assert.throws(() => records.scan('record:ordered-task', 'manual_order', { limit: 2 }), error => error.code === 'index_not_ready');
    buildTables(records);

    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { limit: 2 })), ['a', 'b']);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { after: 'a', after_id: 'record:ordered-task:a', limit: 2 })), ['b', 'c']);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { from: 'b', to: 'c', reverse: true, limit: 2 })), ['c', 'b']);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { equal: ['b'], limit: 1 })), ['b']);
    const reopened = openRecords(host.sql, { transaction: host.transaction });
    assert.equal(reopened.indexReady('record:ordered-task', 'manual_order'), true);
    assert.deepEqual(ids(reopened.scan('record:ordered-task', 'manual_order', { limit: 3 })), ['a', 'b', 'c']);
  } finally { host.db.close(); }
});

test('typed dynamic indexes retain packed JSON tuple order for numbers and lists', async () => {
  const host = sqliteHost(':memory:');
  try {
    const records = openRecords(host.sql, { transaction: host.transaction });
    const lists = makeLists({ eeaf: records });
    const rows = [
      { id: 'n2', values: { score: 2, tags: ['z'], note: 'a\n' } },
      { id: 'n2b', values: { score: 2, tags: ['z'], note: 'a\n' } },
      { id: 'n10', values: { score: 10, tags: ['a', 'b'], note: 'a"x' } },
      { id: 'n1', values: { score: 1, tags: ['a'], note: '☃' } },
    ];
    await lists.save({ id: 'sorts', label: 'Sorts', row_type: 'sort-record', title_field: 'score',
      fields: [{ id: 'score', kind: 'number' }, { id: 'tags', kind: 'tags' }, { id: 'note', kind: 'text' }],
      indexes: [{ name: 'by_score', fields: ['score'] }, { name: 'by_tags', fields: ['tags'] }, { name: 'by_note', fields: ['note'] }] });
    await lists.putRows('sorts', { rows });
    for (let page = 0; page < 100 && (!records.indexReady('record:sort-record', 'by_score') || !records.indexReady('record:sort-record', 'by_tags') || !records.indexReady('record:sort-record', 'by_note')); page += 1) {
      records.backfillTables({ limit: 2 });
    }
    const ids = (index, bounds = {}) => records.scan('record:sort-record', index, { limit: 10, ...bounds }).map(entry => entry.id);
    const packedOrder = field => rows.slice().sort((left, right) => {
      const a = JSON.stringify(left.values[field]), b = JSON.stringify(right.values[field]);
      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
    }).map(row => `record:sort-record:${row.id}`);
    assert.deepEqual(ids('by_score'), packedOrder('score'));
    assert.deepEqual(ids('by_tags'), packedOrder('tags'));
    assert.deepEqual(ids('by_note'), packedOrder('note'));
    assert.deepEqual(ids('by_score', { reverse: true }), packedOrder('score').reverse());
    assert.deepEqual(ids('by_score', { after: 1, after_id: 'record:sort-record:n1' }), packedOrder('score').slice(1));
    assert.deepEqual(ids('by_score', { after: 2, after_id: 'record:sort-record:n2' }), ['record:sort-record:n2b']);
  } finally { host.db.close(); }
});

test('changing a list index definition makes its previous table build unready', async () => {
  const { host, records, lists } = await fresh();
  try {
    buildTables(records);
    await lists.save({
      id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
      fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'order', label: 'Order', kind: 'text' }],
      indexes: [{ name: 'manual_order', fields: ['name'] }],
    });
    assert.equal(records.indexReady('record:ordered-task', 'manual_order'), false);
    buildTables(records);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { limit: 3 })), ['a', 'b', 'c']);
    assert.throws(() => host.transaction(() => {
      lists.save({
        id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
        fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'order', label: 'Order', kind: 'text' }],
        indexes: [{ name: 'manual_order', fields: ['order'] }],
      });
      throw new Error('rollback');
    }), /rollback/);
    // The host rolled SQL back outside the store's own transaction wrapper;
    // rebuild its in-memory declaration projection from the committed log.
    records.forgetCached();
    assert.equal(records.indexReady('record:ordered-task', 'manual_order'), true);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { limit: 3 })), ['a', 'b', 'c']);
  } finally { host.db.close(); }
});

test('decomposed scans resolve the owning list declaration by exact record id', async () => {
  const host = sqliteHost(':memory:');
  try {
    const legacy = eeafStore(host.sql, { transaction: host.transaction, hash: identityOf });
    const lists = makeLists({ eeaf: legacy });
    await lists.save({ id: 'tasks', label: 'Tasks', row_type: 'ordered-task', title_field: 'name',
      fields: [{ id: 'name', label: 'Name', kind: 'text' }, { id: 'order', label: 'Order', kind: 'text' }],
      indexes: [{ name: 'manual_order', fields: ['order'] }] });
    await lists.putRows('tasks', { rows: [
      { id: 'b', values: { name: 'B', order: 'b' } },
      { id: 'a', values: { name: 'A', order: 'a' } },
    ] });
    const records = decomposedRecords(host.sql, { transaction: host.transaction, hash: identityOf, model: RECORD_MODEL });
    assert.equal(records.indexDeclared('record:ordered-task', 'manual_order'), true);
    assert.deepEqual(ids(records.scan('record:ordered-task', 'manual_order', { limit: 2 })), ['a', 'b']);
  } finally { host.db.close(); }
});
