// Scoped EEAF operations keep long sibling data in place and log only the change made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { createEeafTables, eeafStore, RecordTooLarge } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';

const opened = (bounds = { rows: 200, bytes: 500 }) => {
  const { sql, transaction } = sqliteHost(':memory:');
  const make = options => eeafStore(sql, { transaction, hash: text => `members:${text}`, bounds: options ?? bounds });
  const store = make();
  const rows = (query, ...params) => sql.exec(query, ...params).toArray();
  return { sql, store, make, rows };
};

test('record bounds are safe integer limits before they enter bounded SQL', () => {
  const { sql, transaction } = sqliteHost(':memory:');
  assert.throws(() => eeafStore(sql, { transaction, hash: value => value,
    bounds: { rows: '1; DROP TABLE entity', bytes: 50 } }), /positive safe integers/);
  assert.throws(() => eeafStore(sql, { transaction, hash: value => value,
    bounds: { rows: 10, bytes: 0 } }), /positive safe integers/);
});

test('opening an older EEAF store retires unused audit indexes without changing its log', () => {
  const { sql, store, rows } = opened();
  store.write([{ id: 'case:capacity', type: 'case', value: { label: 'kept' } }]);
  const before = rows('SELECT * FROM bitemporal_facts ORDER BY id');
  for (const [name, column] of [
    ['idx_bitemporal_table', 'table_name'],
    ['idx_bitemporal_app_time', 'application_time'],
    ['idx_bitemporal_sys_time', 'system_time'],
  ]) sql.exec(`CREATE INDEX ${name} ON bitemporal_facts(${column})`);
  sql.exec('CREATE INDEX idx_attribute_fact_subject ON attribute_fact(subject_id)');
  sql.exec('CREATE INDEX idx_entity_types_entity ON entity_types(entity_id)');
  sql.exec('CREATE INDEX idx_set_members_set ON interaction_set_members(set_id)');
  createEeafTables(sql);
  const indexes = sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bitemporal_facts' ORDER BY name").toArray().map(row => row.name);
  // The log keeps no index: each one made every logged change cost another row written, and the log is only read back
  // in the order it was written.
  assert.deepEqual(indexes, []);
  assert.ok(!indexes.includes('idx_bitemporal_table'));
  assert.ok(!indexes.includes('idx_bitemporal_app_time'));
  assert.ok(!indexes.includes('idx_bitemporal_sys_time'));
  const attributeIndexes = rows("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attribute_fact'").map(row => row.name);
  assert.ok(attributeIndexes.includes('sqlite_autoindex_attribute_fact_1'));
  assert.ok(!attributeIndexes.includes('idx_attribute_fact_subject'));
  const subjectPlan = rows("EXPLAIN QUERY PLAN SELECT * FROM attribute_fact WHERE subject_id = 'case:capacity'");
  assert.match(subjectPlan[0].detail, /sqlite_autoindex_attribute_fact_1/);
  for (const [table, index, column] of [
    ['entity_types', 'idx_entity_types_entity', 'entity_id'],
    ['interaction_set_members', 'idx_set_members_set', 'set_id'],
  ]) {
    const names = rows(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`).map(row => row.name);
    assert.ok(!names.includes(index));
    assert.ok(names.includes(`sqlite_autoindex_${table}_1`));
    const plan = rows(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE ${column} = 'case:capacity'`);
    assert.match(plan[0].detail, /INDEX/);
  }
  assert.ok(before.length > 0);
  assert.deepEqual(rows('SELECT * FROM bitemporal_facts ORDER BY id'), before);
});

test('a scoped root read and write omit a large scalar and a large child list without changing either', () => {
  const { store, make } = opened();
  const calls = Array.from({ length: 40 }, (_, n) => ({ n, text: `call ${n}` }));
  store.write([{ id: 'case:one', type: 'case', value: { label: 'before', transcript: 'x'.repeat(1200), calls } }]);
  assert.throws(() => store.read('case:one'), RecordTooLarge);
  assert.deepEqual(store.readOwn('case:one', ['transcript', 'calls']), { label: 'before' });
  store.writeOwn('case:one', 'case', { label: 'after' }, ['transcript', 'calls']);
  assert.deepEqual(store.readOwn('case:one', ['transcript', 'calls']), { label: 'after' });
  assert.deepEqual(make({ rows: 1000, bytes: 10000 }).read('case:one'), { label: 'after', transcript: 'x'.repeat(1200), calls });
});

test('a cold bounded read loads its four row families without a size pre-scan and then stays cached', () => {
  const { sql, store } = opened({ rows: 40, bytes: 500 });
  const value = { label: 'ready', detail: { note: 'hello' }, calls: [{ text: 'first' }, { text: 'second' }] };
  store.write([{ id: 'case:cold', type: 'case', value }]);
  store.forgetCached();
  const queries = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { queries.push(query); return exec(query, ...params); };
  assert.deepEqual(store.read('case:cold'), value);
  assert.equal(queries.length, 4, 'one bounded query per row family');
  assert.ok(queries.every(query => / LIMIT \d+/.test(query)), 'every family is capped before materialization');
  assert.ok(queries.every(query => !query.includes('SELECT (SELECT COUNT(*) FROM entity')), 'no size pre-scan');
  assert.deepEqual(store.read('case:cold'), value);
  assert.equal(queries.length, 4, 'the unchanged record stays cached');
});

test('a cold scoped read omits oversized siblings without a full-record count', () => {
  const { sql, store } = opened({ rows: 20, bytes: 100 });
  store.write([{ id: 'case:scoped', type: 'case', value: {
    label: 'visible', transcript: 'x'.repeat(500), calls: Array.from({ length: 20 }, (_, index) => ({ index })),
  } }]);
  store.forgetCached();
  const queries = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { queries.push(query); return exec(query, ...params); };
  assert.deepEqual(store.readOwn('case:scoped', ['transcript', 'calls']), { label: 'visible' });
  assert.equal(queries.filter(query => query.includes('SELECT (SELECT COUNT(*) FROM entity')).length, 0);
  assert.ok(queries.some(query => query.includes('CASE WHEN length(value_json) <= ?')));
});

test('an oversized value never crosses the SQLite cursor and keeps exact refusal details', () => {
  const { sql, store } = opened({ rows: 40, bytes: 50 });
  store.write([{ id: 'case:large-value', type: 'case', value: { label: 'small', body: 'x'.repeat(500) } }]);
  store.forgetCached();
  let selectedFacts = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => {
    const cursor = exec(query, ...params);
    if (query.includes('CASE WHEN length(value_json) <= ?')) selectedFacts = cursor.toArray();
    return cursor;
  };
  assert.throws(() => store.read('case:large-value'), error => error instanceof RecordTooLarge
    && error.size.bytes > 50 && error.size.by_field.some(row => row.field === 'body'));
  assert.equal(selectedFacts.find(row => row.property_id === 'prop:case:body')?.value_json, null);
  assert.equal(store.readOwn('case:large-value', ['body']).label, 'small');
});

test('a multi-type entity at the join cap still reads every type without mistaking it for extra entities', () => {
  const { sql, store } = opened({ rows: 1, bytes: 50 });
  store.write([{ id: 'case:multi-type', type: 'case', value: {} }]);
  for (const type of ['other-a', 'other-b', 'other-c']) {
    sql.exec('INSERT INTO entity (id) VALUES (?)', `type:${type}`);
    sql.exec('INSERT INTO entity_types (entity_id, type_id) VALUES (?, ?)', 'case:multi-type', `type:${type}`);
  }
  store.forgetCached();
  assert.deepEqual(store.sizeOf('case:multi-type'), { rows: 1, bytes: 0, entities: 1, facts: 0, parts: 0, members: 0 });
  const pageSizes = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => {
    const cursor = exec(query, ...params);
    if (/ORDER BY e\.id, t\.type_id LIMIT \d+ OFFSET \?/.test(query)) pageSizes.push(cursor.toArray().length);
    return cursor;
  };
  assert.deepEqual(store.read('case:multi-type'), {});
  assert.deepEqual(pageSizes, [2, 2, 0], 'the exceptional join is read in bounded pages');
  assert.deepEqual(store.held().records, { records: 1, bytes: 96 + 'case:multi-type'.length + 'other-c'.length },
    'the paged type join keeps one entity, not four duplicate entities');
});

test('an empty scalar list becomes a member set and fresh readers see append and replacement', () => {
  const { store, make, rows } = opened();
  store.write([{ id: 'case:two', type: 'case', value: { label: 'open', calls: [] } }]);
  const first = store.writeMember('case:two', 'case', 'calls', 0, { text: 'first' }, { actor: { by: 'proof' } });
  assert.equal(store.memberCount('case:two', 'calls'), 1);
  assert.deepEqual(store.readMember('case:two', 'calls', 0), { text: 'first' });
  assert.equal(store.ownFieldPresent('case:two', 'calls'), true);
  assert.equal(rows("SELECT value_json FROM attribute_fact WHERE subject_id = ? AND property_id = ?", 'case:two', 'prop:case:calls').length, 0);
  store.writeMember('case:two', 'case', 'calls', 1, { text: 'second' }, { actor: { by: 'proof' } });
  const replaced = store.writeMember('case:two', 'case', 'calls', 1, { text: 'changed' }, { actor: { by: 'proof' } });
  assert.deepEqual(make().read('case:two'), { label: 'open', calls: [{ text: 'first' }, { text: 'changed' }] });
  const firstLog = rows('SELECT table_name, actor_context FROM bitemporal_facts WHERE transaction_id = ?', first.transaction_id);
  assert.ok(firstLog.some(row => row.table_name === 'interaction_set_members'));
  assert.ok(firstLog.every(row => JSON.parse(row.actor_context).by === 'proof'));
  const replacementLog = rows('SELECT record_id, table_name, actor_context FROM bitemporal_facts WHERE transaction_id = ?', replaced.transaction_id);
  assert.ok(replacementLog.length > 0);
  assert.ok(replacementLog.every(row => row.table_name !== 'interaction_sets' && row.table_name !== 'interaction_set_members'));
  assert.ok(replacementLog.every(row => !row.record_id.includes('calls/0')));
  assert.ok(replacementLog.every(row => JSON.parse(row.actor_context).by === 'proof'));
});

test('append refuses an existing scalar or object field and an ordinal gap without writing history', () => {
  const { store, rows } = opened();
  store.write([{ id: 'case:scalar', type: 'case', value: { calls: 'keep me' } }]);
  store.write([{ id: 'case:object', type: 'case', value: { calls: { text: 'keep me' } } }]);
  store.write([{ id: 'case:list', type: 'case', value: { calls: [{ text: 'first' }] } }]);
  const before = rows('SELECT COUNT(*) AS n FROM bitemporal_facts')[0].n;
  assert.throws(() => store.writeMember('case:scalar', 'case', 'calls', 0, { text: 'bad' }), /not an empty list/);
  assert.throws(() => store.writeMember('case:object', 'case', 'calls', 0, { text: 'bad' }), /not this list/);
  assert.throws(() => store.writeMember('case:list', 'case', 'calls', 2, { text: 'bad' }), /cannot skip ordinal/);
  assert.equal(rows('SELECT COUNT(*) AS n FROM bitemporal_facts')[0].n, before);
  assert.equal(store.read('case:scalar').calls, 'keep me');
  assert.deepEqual(store.read('case:object').calls, { text: 'keep me' });
  assert.deepEqual(store.read('case:list').calls, [{ text: 'first' }]);
});
