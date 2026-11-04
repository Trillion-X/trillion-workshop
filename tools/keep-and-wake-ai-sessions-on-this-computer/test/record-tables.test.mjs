import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordTables, RecordTableSchemaError } from '../parts/record-log/do-work/record-tables.mjs';

function setup() {
  const host = sqliteHost(':memory:');
  let kind = { type: `row:odd\"; DROP TABLE x;--`, declared_by: 'list:one', properties: { 'x\"; DROP TABLE x;--': 'text', count: 'number', enabled: 'boolean', tags: 'list', data: 'object' }, indexes: [{ name: 'by_count', fields: ['count'] }] };
  const tables = recordTables({ sql: host.sql, kindOf: type => type === kind.type ? kind : type === 'machine' ? { type, properties: { name: 'text' } } : null });
  return { host, tables, get kind() { return kind; }, set kind(value) { kind = value; } };
}

test('hosted column limits allow ongoing type edits by compacting retired generations and preserving values', () => {
  const host = sqliteHost(':memory:');
  let kind = { type: 'customer', table: true, properties: { value: 'number' }, indexes: [{ name: 'value', fields: ['value'] }] };
  const tables = recordTables({ sql: host.sql, kindOf: () => kind });
  host.transaction(() => tables.put({ id: 'one', type: 'customer', value: { value: 7, extra: 'kept' } }));
  for (let i = 0; i < 100; i++) {
    kind = { ...kind, properties: { value: i % 2 ? 'number' : 'text' } };
    host.transaction(() => tables.ensure('customer'));
    const schema = tables.schema('customer');
    assert.ok(host.sql.exec(`PRAGMA table_info("${schema.table}")`).toArray().length <= 100);
    assert.equal(host.sql.exec(`PRAGMA index_list("${schema.table}")`).toArray().filter(index => index.name.startsWith('rti_')).length, 1);
    assert.deepEqual(tables.read('one', 'customer').value, { value: 7, extra: 'kept' });
  }
  kind = { ...kind, properties: Object.fromEntries(Array.from({ length: 95 }, (_, i) => [`field${i}`, 'text'])), indexes: [] };
  assert.throws(() => host.transaction(() => tables.ensure('customer')), error => error.limit === 93);
  host.db.close();
});

test('customer kinds create typed columns safely, become visible in the same transaction, and preserve complete values', () => {
  const { host, tables, kind } = setup();
  assert.deepEqual(tables.schemaHistory(), []);
  assert.equal(host.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").one().n, 0, 'schema reads do not create storage');
  assert.throws(() => tables.ensure('machine'), RecordTableSchemaError, 'shipped machine kinds do not qualify');
  assert.throws(() => tables.put({ id: 'bad-1', type: kind.type, value: { count: 'three' } }), RecordTableSchemaError, 'declared values are validated before SQL projection');
  host.transaction(() => {
    tables.put({ id: 'id-1', type: kind.type, value: { 'x\"; DROP TABLE x;--': 'hello', count: 3, enabled: true, tags: ['a'], data: { ok: 1 }, extra: 'kept' } }, { at: '2026-10-10T10:00:00Z', transaction_id: 'tx-1', actor: { by: 'tester' } });
    assert.equal(host.sql.exec('SELECT changes() AS n').one().n, 1, 'one inserted projection row represents the save');
    tables.put({ id: 'id-1', type: kind.type, value: { 'x\"; DROP TABLE x;--': 'hello', count: 3, enabled: true, tags: ['a'], data: { ok: 1 }, extra: 'kept' } }, { at: '2026-10-10T11:00:00Z', transaction_id: 'tx-2' });
    assert.equal(host.sql.exec('SELECT changes() AS n').one().n, 0, 'an unchanged value does not rewrite its row or metadata');
    assert.deepEqual(tables.read('id-1', kind.type).value, { 'x\"; DROP TABLE x;--': 'hello', count: 3, enabled: true, tags: ['a'], data: { ok: 1 }, extra: 'kept' });
    assert.equal(host.sql.exec(`SELECT count(*) AS n FROM \"${tables.schema(kind.type).table}\" WHERE _deleted = 0`).one().n, 1, 'one save does not add a separate registry row');
    assert.deepEqual(tables.rows(kind.type).map(row => row.id), ['id-1']);
  });
  const physical = tables.schema(kind.type);
  assert.match(physical.table, /^rt_[0-9a-f]+$/);
  assert.ok(physical.fields.some(field => field.field === 'count' && field.value_type === 'number'));
  assert.equal(host.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'x'").one().n, 0, 'injection-shaped identifiers remain data');
  const indexes = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'rti_%'").toArray();
  assert.equal(indexes.length, 1);
  assert.deepEqual(tables.schemaHistory({ type: kind.type }).map(row => row.event), ['kind_added', 'field_added', 'field_added', 'field_added', 'field_added', 'field_added', 'index_added']);
  host.db.close();
});

test('schema edits add fields, remove them without dropping data, and unchanged declarations add no history', () => {
  const state = setup();
  const { host, tables } = state;
  const type = state.kind.type;
  state.kind = { ...state.kind, properties: { count: 'number', retired: 'text' }, indexes: [] };
  host.transaction(() => tables.put({ id: 'id-1', type, value: { count: 2, retired: 'retained' } }));
  const before = tables.schemaHistory({ type }).length;
  state.kind = { ...state.kind, properties: { 'x\"; DROP TABLE x;--': 'text', count: 'number', enabled: 'boolean', tags: 'list', data: 'object' } };
  assert.equal(tables.schema(type).fields.length, 5);
  assert.equal(tables.schemaHistory({ type }).length, before, 'schema reads do not mutate history');
  host.transaction(() => tables.ensure(type));
  assert.equal(tables.schemaHistory({ type }).length, before + 5, 'ensure adds missing fields and records the removed declaration');
  const stable = tables.schemaHistory({ type }).length;
  host.transaction(() => tables.ensure(type));
  assert.equal(tables.schemaHistory({ type }).length, stable);
  assert.equal(tables.read('id-1', type).value.retired, 'retained');
  assert.ok(tables.schema(type).fields.some(field => field.field === 'retired' && field.column === null) === false);
  state.kind = { ...state.kind, properties: { count: 'number' } };
  host.transaction(() => tables.ensure(type));
  assert.equal(tables.read('id-1', type).value.retired, 'retained');
  assert.ok(tables.schemaHistory({ type }).some(row => row.event === 'field_removed'));
  host.db.close();
});

test('type changes retain original values and add a new typed generation without a whole-table migration', () => {
  const state = setup();
  const { host, tables } = state;
  const type = state.kind.type;
  host.transaction(() => tables.put({ id: 'id-1', type, value: { count: 42 } }));
  state.kind = { ...state.kind, properties: { ...state.kind.properties, count: 'text' } };
  host.transaction(() => tables.ensure(type));
  assert.equal(tables.read('id-1', type).value.count, 42, 'historical JSON preserves the original value while typed backfill remains bounded');
  const countFields = tables.schema(type).fields.filter(field => field.field === 'count');
  assert.equal(countFields.length, 1);
  assert.equal(countFields[0].value_type, 'text');
  host.transaction(() => tables.put({ id: 'id-1', type, value: { count: 'forty-two' } }));
  assert.equal(tables.read('id-1', type).value.count, 'forty-two');
  host.db.close();
});

test('removal is a tombstone, type transitions do not duplicate live rows, and caller rollback covers schema and records', () => {
  const state = setup();
  const { host, tables } = state;
  const type = state.kind.type;
  host.transaction(() => tables.put({ id: 'id-1', type, value: { count: 1 } }));
  const other = 'customer:other';
  state.kind = { ...state.kind, type: other, declared_by: 'list:two', properties: { name: 'text' }, indexes: [] };
  host.transaction(() => assert.equal(tables.remove('id-1', type), true));
  host.transaction(() => tables.put({ id: 'id-1', type: other, value: { name: 'new' } }));
  assert.equal(tables.read('id-1', type), null);
  assert.equal(tables.rows(type).length, 0);
  assert.equal(tables.read('id-1', other).value.name, 'new');
  assert.equal(tables.remove('id-1', other), true);
  assert.equal(tables.read('id-1', other), null);
  assert.equal(tables.remove('id-1', other), false);
  assert.throws(() => host.transaction(() => { tables.put({ id: 'id-2', type: other, value: { name: 'rollback' } }); throw new Error('rollback'); }), /rollback/);
  assert.equal(tables.read('id-2', other), null);
  host.db.close();
});


test('a new kind declares its initial fields in one table creation and keeps every schema event', () => {
  const host = sqliteHost(':memory:');
  const fields = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, 'text']));
  let kind = { type: 'initial-wide-kind', customer_declared: true, properties: fields };
  const queries = [], events = [];
  const sql = { exec(query, ...params) { queries.push(query); return host.sql.exec(query, ...params); } };
  const tables = recordTables({ sql, kindOf: () => kind, onSchemaChange: event => events.push(event) });
  try {
    host.transaction(() => tables.put({ id: 'one', type: kind.type, value: { field0: 'first', field31: 'last' } }));
    assert.equal(queries.filter(query => /^ALTER TABLE/.test(query)).length, 0, 'initial fields must not each trigger a catalog scan');
    const schema = tables.schema(kind.type);
    assert.equal(host.sql.exec(`PRAGMA table_info("${schema.table}")`).toArray().length, 39);
    assert.equal(schema.fields.length, 32);
    assert.deepEqual(tables.read('one', kind.type).value, { field0: 'first', field31: 'last' });
    assert.deepEqual(events.map(event => event.event), ['kind_added', ...Array(32).fill('field_added')]);
    assert.equal(tables.schemaHistory({ type: kind.type }).length, 33);
    kind = { ...kind, properties: { ...fields, later: 'number' } };
    host.transaction(() => tables.ensure(kind.type));
    assert.equal(queries.filter(query => /^ALTER TABLE/.test(query)).length, 1, 'an existing kind still evolves by its original additive path');
    assert.equal(tables.schemaHistory({ type: kind.type }).at(-1).field, 'later');
  } finally { host.db.close(); }
});

test('a new kind still refuses more than the hosted physical column limit', () => {
  const host = sqliteHost(':memory:');
  const kind = { type: 'too-wide-initial-kind', table: true, properties: Object.fromEntries(Array.from({ length: 94 }, (_, i) => [`field${i}`, 'text'])) };
  const tables = recordTables({ sql: host.sql, kindOf: () => kind });
  try {
    assert.throws(() => host.transaction(() => tables.ensure(kind.type)), RecordTableSchemaError);
    tables.forgetReady();
    assert.deepEqual(tables.schemaHistory(), [], 'a refused declaration does not commit partial history');
  } finally { host.db.close(); }
});

test('the maximum fresh schema fits and a rolled-back initial declaration retries with identical field history', () => {
  const host = sqliteHost(':memory:');
  const kind = { type: 'full-initial-kind', table: true, properties: Object.fromEntries(Array.from({ length: 93 }, (_, i) => [`field${i}`, 'text'])) };
  const tables = recordTables({ sql: host.sql, kindOf: () => kind });
  try {
    assert.throws(() => host.transaction(() => { tables.ensure(kind.type); throw new Error('rollback the complete initial schema'); }), /rollback the complete/);
    tables.forgetReady();
    assert.deepEqual(tables.schemaHistory(), []);
    host.transaction(() => tables.put({ id: 'one', type: kind.type, value: { field0: 'first', field92: 'last' } }));
    const schema = tables.schema(kind.type);
    assert.equal(host.sql.exec(`PRAGMA table_info("${schema.table}")`).toArray().length, 100);
    assert.equal(schema.fields.length, 93);
    assert.deepEqual(tables.read('one', kind.type).value, { field0: 'first', field92: 'last' });
    assert.equal(tables.schemaHistory({ type: kind.type }).length, 94);
  } finally { host.db.close(); }
});
