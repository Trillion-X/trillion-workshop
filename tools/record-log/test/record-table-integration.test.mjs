import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { recordModel } from '../do-work/record-model.mjs';
import { openRecords, setRecordEngine } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { handleModelRequest } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-model-tools.mjs';

const list = fields => ({ id: 'list:items', type: 'list', value: { label: 'Items', row_type: 'items', fields } });
const fields = [{ id: 'title', label: 'Title', kind: 'text' }, { id: 'amount', label: 'Amount', kind: 'number' }];
const typedRow = (type, id, value) => ({ id: `record:${type}:${id}`, type: `record:${type}`, value });
const row = (id, value) => typedRow('items', id, value);
const strictCustomerModel = {
  value_kinds: { text: { is: 'string' }, number: { is: 'number' }, objects: { list_of: 'object' } },
  kinds: [{ type: 'list', properties: { row_type: 'text', fields: 'objects' } }],
  declared_by: [{ type: 'list', kind: { path: ['row_type'], prefix: 'record:' }, properties: { path: ['fields'], name: ['id'], kind: ['kind'] }, kind_values: { text: 'text', number: 'number' } }],
};
const customerList = (rowType, fieldKind = 'text', id = 'list:items') => ({ id, type: 'list', value: { row_type: rowType, fields: [{ id: 'title', kind: fieldKind }] } });

test('record model forks copy declaration maps without sharing mutations', () => {
  const original = recordModel(strictCustomerModel);
  original.declare('list', 'list:items', customerList('items').value);
  const fork = original.fork();
  fork.forget('list:items');
  assert.equal(original.kindOf('record:items').properties.title, 'text');
  assert.equal(fork.kindOf('record:items'), null);
  fork.declare('list', 'list:items', customerList('items', 'number').value);
  assert.equal(fork.kindOf('record:items').properties.title, 'number');
  assert.equal(original.kindOf('record:items').properties.title, 'text');
});

test('strict writes validate rows against same-batch declarations in either order', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([{ id: 'record:items:a', type: 'record:items', value: { title: 'First' } }, customerList('items')]);
  assert.equal(records.tableRows('record:items').rows[0].value.title, 'First');
  host.db.close();
});

test('strict duplicate declarations use the schema from the last applied declaration', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  assert.throws(() => records.write([
    customerList('items', 'number', 'list:first'),
    customerList('items', 'text', 'list:second'),
    customerList('items', 'number', 'list:first'),
    row('bad', { title: 'The final schema requires a number' }),
  ]), error => error.code === 'model_refused' && error.expected === 'number');
  host.db.close();
});

test('strict duplicate declaration preflight ignores a later no-op envelope', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([customerList('items', 'text', 'list:first'), customerList('items', 'text', 'list:second')]);
  assert.throws(() => records.write([
    customerList('items', 'number', 'list:second'),
    customerList('items', 'text', 'list:first'),
    row('bad', { title: 'The last applied declaration requires a number' }),
  ]), error => error.code === 'model_refused' && error.expected === 'number');
  host.db.close();
});

test('strict declaration preflight overlays generated partial deltas in write order', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([customerList('items', 'text')]);
  // Both envelopes are generated against the original declaration: the first changes row_type, the second changes
  // fields. Applying them in order leaves row_type=contacts and title:number.
  records.write([
    customerList('contacts', 'text'),
    customerList('items', 'number'),
    typedRow('contacts', 'valid', { title: 3 }),
  ]);
  assert.equal(records.read('record:contacts:valid').title, 3);
  assert.throws(() => records.write([typedRow('contacts', 'invalid', { title: 'The sequentially applied declaration requires a number' })]),
    error => error.code === 'model_refused' && error.expected === 'number');
  assert.throws(() => records.write([typedRow('items', 'undeclared', { title: 'The final declaration moved to contacts' })]),
    error => error.code === 'model_undeclared');
  host.db.close();
});

test('strict declarations validate their values and failed batches do not leak model changes', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  assert.throws(() => records.write([customerList('items', 'number'), row('bad', { title: 'text' })]), error => error.code === 'model_refused');
  assert.throws(() => records.write([customerList('items'), row('bad', { title: 7 })]), error => error.code === 'model_refused');
  assert.throws(() => records.write([row('later', { title: 'still undeclared' })]), error => error.code === 'model_undeclared');
  host.db.close();
});

test('strict batch updates and removals apply their final declaration before validating rows', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([customerList('items'), row('old', { title: 'Old kind' })]);
  records.write([typedRow('contacts', 'new', { title: 'New kind' }), customerList('contacts')]);
  assert.throws(() => records.write([row('stale', { title: 'Old declaration removed' })]), error => error.code === 'model_undeclared');
  records.write([{ id: 'list:items', type: 'list', value: null }]);
  assert.throws(() => records.write([typedRow('contacts', 'removed', { title: 'Removed declaration' })]), error => error.code === 'model_undeclared');
  host.db.close();
});

test('live writes validate a same-batch declaration before accepting its row', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel });
  assert.throws(() => records.write([row('bad', { title: 7 }), customerList('items')]), error => error.code === 'model_refused');
  records.write([row('good', { title: 'Accepted' }), customerList('items')]);
  assert.equal(records.read('record:items:good').title, 'Accepted');
  host.db.close();
});

test('a rolled-back declaration disappears after the store rebuilds its model', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel });
  assert.throws(() => host.transaction(() => { records.write([customerList('items')]); throw new Error('rollback'); }));
  records.forgetCached();
  assert.equal(records.model().kinds.some(kind => kind.type === 'record:items'), false);
  host.db.close();
});

test('ordinary saved rows and real SQL cells commit together, preserving unknown fields and nulls', async () => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  records.write([list(fields), row('a', { title: 'First', amount: 3, extra: { x: true }, absent: null })]);
  const schema = records.tableSchema('record:items').schema;
  assert.ok(schema.table);
  const actual = host.sql.exec(`SELECT * FROM "${schema.table}"`).toArray()[0];
  assert.ok(Object.values(actual).includes(3));
  assert.deepEqual(records.tableRows('record:items').rows[0].value, records.read('record:items:a'));
  const beforeLog = records.lastLogId();
  records.write([row('a', records.read('record:items:a'))]);
  assert.equal(records.lastLogId(), beforeLog);
  const response = await handleModelRequest(records, new Request('https://local/records/model?table=record:items'));
  assert.equal((await response.json()).rows.length, 1);
  host.db.close();
});

test('rollback/reopen, remove, purge and type movement never leave a ghost table row', () => {
  const host = sqliteHost(':memory:');
  let records = openRecords(host.sql, { transaction: host.transaction });
  records.write([list(fields), row('a', { title: 'First', amount: 3 })]);
  assert.throws(() => host.transaction(() => { records.write([row('a', { title: 'Lost', amount: 9 })]); throw new Error('rollback'); }));
  records.forgetCached();
  assert.equal(records.tableRows('record:items').rows[0].value.title, 'First');
  records = openRecords(host.sql, { transaction: host.transaction });
  records.takeRecords([{ id: 'record:items:a', type: 'message', value: { text: 'Moved' } }]);
  assert.equal(records.tableRows('record:items').rows.length, 0);
  records.write([row('b', { title: 'Second' })]);
  records.takeRecords([{ id: 'record:items:b', value: null }]);
  assert.equal(records.tableRows('record:items').rows.length, 0);
  records.write([row('c', { title: 'Third' })]);
  records.write([{ id: 'record:items:c', value: null }]);
  assert.equal(records.tableRows('record:items').rows.length, 0);
  host.db.close();
});

test('retained rows backfill in bounded durable pages; schema history and evolved fields survive a restart', () => {
  const host = sqliteHost(':memory:');
  const old = recordLogStore(host.sql, { transaction: host.transaction });
  old.write([list(fields), ...Array.from({ length: 7 }, (_, i) => row(String(i), { title: `Row ${i}`, amount: i }))]);
  old.checkpoint();
  let records = openRecords(host.sql, { transaction: host.transaction });
  assert.equal(records.tableSchema('record:items').complete, false);
  assert.equal(records.backfillTables({ limit: 2 }).walked, 2);
  records = openRecords(host.sql, { transaction: host.transaction });
  assert.equal(records.backfillTables({ limit: 2 }).walked, 2);
  for (let n = 0; records.backfillTables({ limit: 2 }).more; n++) assert.ok(n < 10);
  assert.equal(records.tableRows('record:items').complete, true);
  assert.equal(records.tableRows('record:items').rows.length, 7);
  records.write([list([{ id: 'title', kind: 'text' }, { id: 'amount', kind: 'text' }, { id: 'enabled', kind: 'text' }])]);
  assert.equal(records.tableSchema('record:items').complete, false);
  records.write([row('0', { title: 'Row 0', amount: 'zero', enabled: 'yes' })]);
  assert.equal(records.tableRows('record:items').rows[0].value.amount, 'zero');
  assert.ok(records.tableHistory({ type: 'record:items' }).some(item => item.event === 'field_type_changed' && item.field === 'amount'));
  for (let n = 0; records.backfillTables({ limit: 2 }).more; n++) assert.ok(n < 10);
  assert.equal(records.tableRows('record:items').complete, true);
  assert.equal(typeof records.tableRows('record:items').rows[1].value.amount, 'number', 'a changed declaration preserves historical values exactly');
  host.db.close();
});

test('83 table kinds add one SQL row per save, while the same machine kinds add none', () => {
  for (const table of [true, false]) {
    const host = sqliteHost(':memory:');
    const kinds = Array.from({ length: 83 }, (_, i) => ({ type: `kind:${i}`, table, properties: { title: 'text', n: 'number' } }));
    const records = recordLogStore(host.sql, { transaction: host.transaction, model: { kinds, value_kinds: { text: { is: 'string' }, number: { is: 'number' } } }, runs: { memtable_bytes: 1 << 24, tail_rows: 1000 } });
    const sample = number => kinds.forEach(({ type }, i) => records.write([{ id: `r${i}`, type, value: { title: `Item ${i}`, n: number } }]));
    sample(0);
    const before = host.db.prepare('SELECT total_changes() AS n').get().n;
    sample(1);
    const changed = host.db.prepare('SELECT total_changes() AS n').get().n - before;
    assert.equal(changed, 83 * (table ? 2 : 1), `${table ? 'customer table' : 'machine'} row writes, including the authoritative log`);
    host.db.close();
  }
});

test('resetting a partial engine move clears typed rows, schema and history through the owned inventory', () => {
  const host = sqliteHost(':memory:');
  setRecordEngine(host.sql, 'eeaf');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  host.sql.exec('CREATE TABLE rt_unrelated_owner (id TEXT PRIMARY KEY)');
  const partial = records.logStore();
  partial.write([list(fields), row('a', { title: 'Partial', amount: 1 })]);
  const owned = partial.tables();
  const typedTable = partial.tableSchema('record:items').schema.table;
  assert.ok(owned.includes(typedTable));
  for (const name of ['_record_tables_kinds', '_record_tables_fields', '_record_tables_history', '_record_tables_indexes']) assert.ok(owned.includes(name), name);
  assert.ok(!owned.includes('rt_unrelated_owner'));
  records.clearLogStore();
  assert.equal(host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", typedTable).toArray().length, 0);
  assert.equal(host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_record_tables_history'").toArray().length, 0);
  assert.equal(host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rt_unrelated_owner'").toArray().length, 1);
  const reopened = records.logStore();
  reopened.write([list([{ id: 'new', kind: 'number' }]), row('b', { new: 7 })]);
  assert.deepEqual(reopened.tableSchema('record:items').schema.fields.map(field => field.field), ['new']);
  assert.equal(reopened.tableRows('record:items').rows[0].id, 'record:items:b');
  host.db.close();
});

test('strict batch validation accepts declarations in either order and discards refused schemas', () => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  records.write([row('a', { title: 'First', amount: 1, retained: { x: true } }), list(fields)]);
  assert.equal(records.tableRows('record:items').rows[0].value.retained.x, true);
  assert.throws(() => records.write([list([{ id: 'amount', kind: 'text' }]), row('b', { amount: 2 })]));
  assert.equal(records.read('record:items:b'), null);
  records.write([row('b', { amount: 2 })]);
  assert.equal(records.tableSchema('record:items').schema.fields.find(f => f.field === 'amount').value_type, 'number');
  host.db.close();
});


test('customer list indexes are physical, dated and atomic through list save and row writes', async t => {
  const { makeLists } = await import('../../keep-lists-of-rows/lists.mjs');
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  const records = openRecords(host.sql, { transaction: host.transaction });
  const lists = makeLists({ eeaf: records });
  await lists.save({ id: 'indexed-items', label: 'Indexed items', fields, indexes: [{ name: 'by_amount', fields: ['amount'] }] });
  await lists.putRows('indexed-items', { rows: [{ id: 'a', values: { title: 'First', amount: 3 } }] });
  const schema = records.tableSchema('record:indexed-items').schema;
  assert.deepEqual(schema.indexes.map(index => ({ name: index.name, fields: index.fields })), [{ name: 'by_amount', fields: ['amount'] }]);
  const physical = host.sql.exec('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name LIKE ?', 'index', schema.table, 'rti_%').toArray()[0].name;
  assert.ok(host.sql.exec('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', 'index', physical).toArray()[0].sql.includes('CREATE INDEX'));
  const events = records.tableHistory({ type: 'record:indexed-items' });
  assert.ok(events.some(event => event.event === 'index_added' && event.field === 'by_amount' && event.transaction_id));
  await lists.save({ id: 'indexed-items', label: 'Renamed items' });
  assert.equal(records.tableSchema('record:indexed-items').schema.indexes.length, 1, 'rename retains requested indexes');
  await assert.rejects(async () => await lists.save({ id: 'indexed-items', indexes: [{ name: 'bad', fields: ['missing'] }] }), /declared/);
  assert.equal(records.tableSchema('record:indexed-items').schema.indexes.length, 1, 'invalid edit preserves current schema');
  assert.throws(() => host.transaction(() => { lists.save({ id: 'indexed-items', indexes: [] }); throw new Error('rollback'); }), /rollback/);
  records.forgetCached();
  assert.equal(records.tableSchema('record:indexed-items').schema.indexes.length, 1, 'rollback restores both declaration and physical index');
  await lists.save({ id: 'indexed-items', indexes: [] });
  assert.deepEqual(records.tableSchema('record:indexed-items').schema.indexes, []);
  assert.deepEqual(host.sql.exec('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'index', physical).toArray(), []);
  assert.equal(records.tableRows('record:indexed-items').rows[0].value.amount, 3);
});

test('customer-declared indexes survive cold model reopen and cannot replace shipped indexes', () => {
  const definition = { ...strictCustomerModel, declared_by: strictCustomerModel.declared_by.map(rule => ({ ...rule, indexes: { path: ['indexes'] } })),
    kinds: [...strictCustomerModel.kinds, { type: 'record:items', properties: { title: 'text' }, table: true, indexes: [{ name: 'by_title', fields: ['title'] }] }] };
  const model = recordModel(definition);
  model.declare('list', 'list:items', { row_type: 'items', fields: [{ id: 'title', kind: 'text' }, { id: 'amount', kind: 'number' }], indexes: [{ name: 'by_amount', fields: ['amount'] }, { name: 'by_title', fields: ['amount'] }] });
  assert.deepEqual(model.kindOf('record:items').indexes, [{ name: 'by_title', fields: ['title'] }, { name: 'by_amount', fields: ['amount'] }]);
  assert.deepEqual(model.fork().kindOf('record:items').indexes, model.kindOf('record:items').indexes);
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction, model: definition });
  store.write([{ ...customerList('items'), value: { ...customerList('items').value, indexes: [{ name: 'by_title', fields: ['title'] }] } }, row('a', { title: 'Kept' })]);
  store.checkpoint();
  const reopened = recordLogStore(host.sql, { transaction: host.transaction, model: definition });
  assert.deepEqual(reopened.tableSchema('record:items').schema.indexes.map(index => index.name), ['by_title']);
  host.db.close();
});

test('every schema change of a table is a dated record of the log, written in the transaction that made it', () => {
  const host = sqliteHost(':memory:');
  const model = { ...strictCustomerModel, kinds: [...strictCustomerModel.kinds, { type: 'table-schema-change', properties: { kind: 'text', event: 'text', field: 'text', old_type: 'text', new_type: 'text', changed_at: 'text' } }] };
  const records = recordLogStore(host.sql, { transaction: host.transaction, model, strict_model: true });
  const changes = () => records.ids('table-schema-change', { limit: 100 }).map(id => records.read(id)).map(change => [change.kind, change.event, change.field]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const { transaction_id: made } = records.write([customerList('items')], { actor: { by: 'person' } });
  assert.deepEqual(changes(), [['record:items', 'field_added', 'title'], ['record:items', 'kind_added', null]]);
  // Adding a field: its column and its dated change land with the list's own write, in one log row.
  const { transaction_id: added } = records.write([{ id: 'list:items', type: 'list', value: { row_type: 'items', fields: [{ id: 'title', kind: 'text' }, { id: 'amount', kind: 'number' }] } }], { actor: { by: 'person' } });
  assert.deepEqual(records.tableSchema('record:items').schema.fields.map(field => field.field).sort(), ['amount', 'title']);
  const amount = records.ids('table-schema-change', { limit: 100 }).find(id => records.read(id).field === 'amount');
  assert.equal(records.read(amount).new_type, 'number');
  const rows = host.sql.exec('SELECT transaction_id, envelopes FROM record_log').toArray().filter(row => row.envelopes.includes(amount));
  assert.deepEqual(rows.map(row => row.transaction_id), [added], 'the change is in the very log row that added the field');
  assert.notEqual(made, added);
  host.db.close();
});

test('a shipped kind marked as a table is a table: a relation is read back from its own typed table', async () => {
  const shipped = (await import('../../keep-and-wake-ai-sessions-on-this-computer/src/record-model.json', { with: { type: 'json' } })).default;
  for (const type of ['relation', 'organisation', 'group', 'place', 'ai', 'device', 'customer-database']) assert.equal(shipped.kinds.find(kind => kind.type === type)?.table, true, `${type} is a table`);
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction });
  records.write([{ id: 'organisation:uab-theta-chi', type: 'organisation', value: { name: 'UAB Theta Chi' } }, { id: 'relation:r1', type: 'relation', value: { subject: 'record:trillion-crm:a', role: 'member', object: 'organisation:uab-theta-chi' } }]);
  assert.deepEqual(records.tableRows('relation').rows.map(row => [row.id, row.value.role]), [['relation:r1', 'member']]);
  assert.deepEqual(records.tableSchema('organisation').schema.fields.map(field => field.field), ['name']);
  host.db.close();
});

test('schema changes kept before they were logged are copied into the log once, at idle, never twice', async () => {
  const { recordTables } = await import('../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-tables.mjs');
  const host = sqliteHost(':memory:');
  // As a store from before this rule left it: the table history holds the changes and the log holds none of them.
  recordTables({ sql: host.sql, kindOf: () => ({ declared_by: 'list:items', properties: { title: 'text' } }) }).ensure('record:items');
  const model = { ...strictCustomerModel, kinds: [...strictCustomerModel.kinds, { type: 'table-schema-change', properties: { kind: 'text', event: 'text', field: 'text', old_type: 'text', new_type: 'text', changed_at: 'text' } }] };
  const records = recordLogStore(host.sql, { transaction: host.transaction, model });
  const logged = () => records.ids('table-schema-change', { limit: 100 }).map(id => records.read(id)).map(change => `${change.event}:${change.field ?? ''}`).sort();
  for (let n = 0; n < 10; n++) records.maintain({ max_pages: 64 });
  assert.deepEqual(logged(), ['field_added:title', 'kind_added:']);
  records.write([{ id: 'list:items', type: 'list', value: { row_type: 'items', fields: [{ id: 'title', kind: 'text' }, { id: 'note', kind: 'text' }] } }]);
  for (let n = 0; n < 10; n++) records.maintain({ max_pages: 64 });
  assert.deepEqual(logged(), ['field_added:note', 'field_added:title', 'kind_added:'], 'the field added now is logged once, by its own write');
  host.db.close();
});

test('a typed table is WITHOUT ROWID, and one made before as a rowid table is made again and filled from the log', () => {
  const host = sqliteHost(':memory:');
  let records = openRecords(host.sql, { transaction: host.transaction });
  records.write([list(fields), row('a', { title: 'First', amount: 1 }), row('b', { title: 'Second', amount: 2 })]);
  const table = records.tableSchema('record:items').schema.table;
  const madeAs = () => host.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
  assert.match(madeAs(), /WITHOUT ROWID$/);
  // As a store made before the layout holds it: a rowid table, its rows a build of an older signature.
  const columns = host.db.prepare(`PRAGMA table_info("${table}")`).all();
  host.db.exec(`CREATE TABLE old_layout AS SELECT * FROM "${table}"; DROP TABLE "${table}"`);
  host.db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" ${column.type}${column.name === '_id' ? ' PRIMARY KEY' : ''}`).join(', ')}); INSERT INTO "${table}" SELECT * FROM old_layout; DROP TABLE old_layout`);
  records = openRecords(host.sql, { transaction: host.transaction });
  records.write([row('c', { title: 'Third', amount: 3 })]);
  for (let n = 0; records.backfillTables({ limit: 1 }).more; n++) assert.ok(n < 10);
  assert.match(madeAs(), /WITHOUT ROWID$/, 'the rowid table was made again WITHOUT ROWID');
  assert.deepEqual(records.tableRows('record:items').rows.map(item => item.value.amount), [1, 2, 3], 'its rows were filled again from the log');
  assert.ok(records.tableHistory({ type: 'record:items' }).some(item => item.event === 'table_rebuilt'), 'the rebuild is a dated schema change');
  host.db.close();
});

// A write of many rows of one kind ensures that kind's table once, not once a row (about nine statements each: on the
// founder's own records a tool run that kept 176 rows spent 1,584 statements so, 2026-10-20), and every row is kept.
test('a write of many rows of one kind ensures its table once and keeps every row', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([customerList('items')]);
  records.write([row('first', { title: 'First' })]);
  const exec = host.sql.exec.bind(host.sql);
  let ensures = 0;
  host.sql.exec = (query, ...params) => { if (/CREATE TABLE IF NOT EXISTS "_record_tables_kinds"/.test(query)) ensures += 1; return exec(query, ...params); };
  records.write(Array.from({ length: 50 }, (_, at) => row(`r${at}`, { title: `Row ${at}` })));
  host.sql.exec = exec;
  assert.equal(ensures, 1, `the kind's table was ensured ${ensures} times for one write`);
  const kept = records.tableRows('record:items', { limit: 100 }).rows;
  assert.equal(kept.length, 51);
  assert.equal(kept.find(item => item.id === 'record:items:r49').value.title, 'Row 49');
  host.db.close();
});

// A write's rows of one kind go to its table 64 a statement (record-tables putMany), not one a row: on the founder's own
// records (2026-10-20) one tool run wrote 522 rows one statement each. They are kept as rows written one by one are,
// a changed row is changed and an unchanged one keeps its stamp.
test('a write of many rows of one kind puts them in its table together, as rows written one by one', () => {
  const host = sqliteHost(':memory:');
  const records = recordLogStore(host.sql, { transaction: host.transaction, model: strictCustomerModel, strict_model: true });
  records.write([customerList('items')]);
  records.write([row('first', { title: 'First' })]);
  const exec = host.sql.exec.bind(host.sql);
  let puts = 0;
  host.sql.exec = (query, ...params) => { if (/^WITH source\(id, doc,.*INSERT INTO "rt_/.test(query)) puts += 1; return exec(query, ...params); };
  records.write(Array.from({ length: 150 }, (_, at) => row(`r${at}`, { title: `Row ${at}` })));
  assert.equal(puts, 3, `150 rows went to the table in ${puts} statements`);
  const first = new Map(records.tableRows('record:items', { limit: 200 }).rows.map(item => [item.id, item.changed_at]));
  puts = 0;
  records.write(Array.from({ length: 150 }, (_, at) => row(`r${at}`, { title: at % 15 ? `Row ${at}` : `Changed ${at}` })));
  host.sql.exec = exec;
  assert.equal(puts, 1, 'the ten changed rows went to the table in one statement, the unchanged ones not at all');
  const kept = new Map(records.tableRows('record:items', { limit: 200 }).rows.map(item => [item.id, item]));
  assert.equal(kept.size, 151);
  for (let at = 0; at < 150; at += 1) {
    const one = kept.get(`record:items:r${at}`);
    assert.equal(one.value.title, at % 15 ? `Row ${at}` : `Changed ${at}`);
    if (at % 15) assert.equal(one.changed_at, first.get(one.id), `r${at}, unchanged, keeps the stamp of its first write`);
  }
  host.db.close();
});
