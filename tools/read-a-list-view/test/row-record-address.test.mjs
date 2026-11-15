import test from 'node:test';
import assert from 'node:assert/strict';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';

const names = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const definition = { row_type: 'logical-entry', row_records: { type: 'entry', prefix: 'entry:project:' },
  title_field: 'title', fields: [{ id: 'title', kind: 'text' }] };

function owner(list = definition) {
  const rows = new Map([['entry:project:b', { title: 'B' }], ['entry:project:a', { title: 'A' }], ['entry:other:c', { title: 'Other' }]]);
  const listed = [], written = [];
  let failSource = false;
  const door = {
    read: async (_type, id) => id === 'list:items' ? list : rows.get(id) ?? null,
    list: async request => {
      listed.push(request);
      const ids = [...rows.keys()].filter(id => id.startsWith(request.prefix ?? `${request.type}:`) && (!request.after || id < request.after)).sort().reverse();
      const shown = ids.slice(0, request.limit);
      return { records: shown.map(id => ({ id, type: request.type, value: rows.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
    },
    run: async () => {
      if (failSource) throw new Error('Source unavailable');
      return { rows: [{ id: '/one.md', values: { title: 'One' } }], next: null };
    },
    write: async records => { written.push(...records); for (const r of records) r.value === null ? rows.delete(r.id) : rows.set(r.id, r.value); },
  };
  return { rows, listed, written, door, fail: () => { failSource = true; } };
}

test('a declared native address reads real rows, pages within its prefix and keeps local ids', async () => {
  const o = owner();
  const first = await readListView({ list: 'items', names, limit: 1 }, o.door);
  const second = await readListView({ list: 'items', names, limit: 1, after: first.next }, o.door);
  assert.deepEqual([...first.rows, ...second.rows].map(r => r.id), ['b', 'a']);
  assert.equal(second.next, null);
  assert.ok(o.listed.every(r => r.type === 'entry' && r.prefix === 'entry:project:'));
});

test('full and changed-document refreshes write only the declared physical address', async () => {
  const o = owner({ ...definition, row_sources: [{ id: 'docs', source: 'documents', of: '/docs' }] });
  const full = await refreshRowSources({ list: 'items', names }, o.door);
  assert.equal(full.sources[0].written, 1);
  assert.ok(o.rows.has('entry:project:docs~%2Fone.md'));
  assert.equal(o.rows.has('record:logical-entry:docs~%2Fone.md'), false);
  const before = o.written.length;
  await refreshRowSources({ list: 'items', names, changes: { docs: { paths: ['/one.md'], removed: [] } } }, o.door);
  assert.equal(o.written.length, before, 'equal values are not rewritten');
  o.fail();
  await assert.rejects(refreshRowSources({ list: 'items', names }, o.door), /Source unavailable/);
  assert.ok(o.rows.has('entry:project:docs~%2Fone.md'), 'a failed source does not erase kept rows');
  assert.ok(o.rows.has('entry:other:c'), 'another prefix remains untouched');
});

test('invalid declarations and denied reads fail visibly instead of returning an empty list', async () => {
  const invalid = owner({ ...definition, row_records: { type: 'entry' } });
  await assert.rejects(readListView({ list: 'items', names }, invalid.door), /row_records.prefix/);
  assert.equal(invalid.listed.length, 0);
  const denied = owner();
  denied.door.list = async () => { throw new Error('Scope denied'); };
  await assert.rejects(readListView({ list: 'items', names }, denied.door), /Scope denied/);
});
