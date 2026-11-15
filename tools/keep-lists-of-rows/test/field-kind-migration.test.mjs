// tools/keep-lists-of-rows/test/field-kind-migration.test.mjs
//
// Synthetic data only: no person's titles, values or paths appear here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigration, applyMigration } from '../do-work/field-kind-migration.mjs';

const primitives = {
  kinds: {
    text: { primitive: 'text' },
    number: { primitive: 'number' },
    boolean: { primitive: 'boolean' },
    date: { primitive: 'date' },
    tags: { primitive: 'list-of', of: 'text', separator: ', ' },
    button: { primitive: 'display', action: 'bound' },
  },
};

const lists = [
  {
    id: 'list-a',
    label: 'Synthetic list A',
    fields: [
      { id: 'f-text', kind: 'text' },
      { id: 'f-number', kind: 'number' },
      { id: 'f-tags', kind: 'tags' },
      { id: 'f-flag', kind: 'boolean' },
    ],
  },
];

const rows = [
  { id: 'row-1', list_id: 'list-a', values: { 'f-text': 'first', 'f-number': 2, 'f-tags': 'x, y', 'f-flag': true } },
  { id: 'row-2', list_id: 'list-a', values: { 'f-text': null, 'f-number': 0, 'f-tags': '', 'f-flag': false } },
];

test('a dry run names each field with its old kind, primitive and display settings, and writes nothing', () => {
  const plan = planMigration({ lists, rows, primitives });
  const fields = plan.fields;
  assert.deepEqual(
    fields.map(f => [f.field_id, f.old_kind, f.primitive]),
    [
      ['f-text', 'text', 'text'],
      ['f-number', 'number', 'number'],
      ['f-tags', 'tags', 'list-of'],
      ['f-flag', 'boolean', 'boolean'],
    ],
  );
  assert.equal(fields.find(f => f.field_id === 'f-tags').display.separator, ', ');
  assert.equal(plan.writes_made, 0);
});

test('every row projects each value, and the dry run carries the same projection apply would write', () => {
  const plan = planMigration({ lists, rows, primitives });
  assert.deepEqual(plan.rows[0].projected, { 'f-text': 'first', 'f-number': 2, 'f-tags': ['x', 'y'], 'f-flag': true });
  assert.deepEqual(plan.rows[1].projected, { 'f-text': null, 'f-number': 0, 'f-tags': [], 'f-flag': false });
});

test('a field whose kind has no mapping refuses by naming the kind, and nothing is guessed', () => {
  const unknown = [{ id: 'list-b', label: 'Synthetic list B', fields: [{ id: 'f-odd', kind: 'not-in-the-map' }] }];
  assert.throws(() => planMigration({ lists: unknown, rows: [], primitives }), /not-in-the-map/);
});

test('a list value that does not split back to its own text is refused, so no value is lost', () => {
  const bad = [{ id: 'row-x', list_id: 'list-a', values: { 'f-tags': 'x,,y' } }];
  assert.throws(() => planMigration({ lists, rows: bad, primitives }), /f-tags/);
});

test('an id or rule value is kept exactly, and a display field refuses any stored value', () => {
  const kinds = {
    kinds: {
      link: { primitive: 'id' },
      'shown-when': { primitive: 'rule' },
      button: { primitive: 'display', action: 'bound' },
    },
  };
  const shapes = [{ id: 'list-c', label: 'Synthetic list C', fields: [
    { id: 'f-link', kind: 'link' },
    { id: 'f-rule', kind: 'shown-when' },
    { id: 'f-button', kind: 'button' },
  ] }];
  const kept = [{ id: 'row-z', list_id: 'list-c', values: { 'f-link': 'row-9', 'f-rule': { op: 'eq', field: 'f-link' }, 'f-button': null } }];
  const plan = planMigration({ lists: shapes, rows: kept, primitives: kinds });
  assert.deepEqual(plan.rows[0].projected, { 'f-link': 'row-9', 'f-rule': { op: 'eq', field: 'f-link' }, 'f-button': null });
  const many = [{ id: 'row-v', list_id: 'list-c', values: { 'f-link': ['row-9', 'row-10'] } }];
  assert.deepEqual(planMigration({ lists: shapes, rows: many, primitives: kinds }).rows[0].projected, { 'f-link': ['row-9', 'row-10'] });
  const stored = [{ id: 'row-w', list_id: 'list-c', values: { 'f-button': 'clicked' } }];
  assert.throws(() => planMigration({ lists: shapes, rows: stored, primitives: kinds }), /f-button/);
});

test('a number field refuses a value that is not a number', () => {
  const bad = [{ id: 'row-y', list_id: 'list-a', values: { 'f-number': 'two' } }];
  assert.throws(() => planMigration({ lists, rows: bad, primitives }), /f-number/);
});

test('apply writes each projected row through the door, reads it back, and compares it', async () => {
  const store = new Map(rows.map(r => [r.id, structuredClone(r.values)]));
  const door = {
    write: async (id, values) => { store.set(id, structuredClone(values)); },
    read: async id => structuredClone(store.get(id)),
  };
  const plan = planMigration({ lists, rows, primitives });
  const result = await applyMigration({ plan, door });
  assert.equal(result.matched, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.mismatches, []);
});

test('apply reports a row whose readback differs, and does not call it matched', async () => {
  const door = {
    write: async () => {},
    read: async () => ({ 'f-text': 'changed by someone else' }),
  };
  const plan = planMigration({ lists, rows, primitives });
  const result = await applyMigration({ plan, door });
  assert.equal(result.matched, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(result.mismatches.map(m => m.row_id), ['row-1', 'row-2']);
});
