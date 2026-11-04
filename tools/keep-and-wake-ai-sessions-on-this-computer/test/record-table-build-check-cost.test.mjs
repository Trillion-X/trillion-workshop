import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const definition = {
  value_kinds: { text: { is: 'string' }, number: { is: 'number' }, objects: { list_of: 'object' } },
  kinds: [{ type: 'list', properties: { row_type: 'text', fields: 'objects' } }],
  declared_by: [{ type: 'list', kind: { path: ['row_type'], prefix: 'record:' }, properties: { path: ['fields'], name: ['id'], kind: ['kind'] } }],
};
const list = (type = 'items', kind = 'text') => ({ id: 'list:items', type: 'list', value: { row_type: type, fields: [{ id: 'title', kind }] } });
const row = (id, title, type = 'items') => ({ id: `record:${type}:${id}`, type: `record:${type}`, value: { title } });
const finish = store => { for (let n = 0; store.backfillTables({ limit: 1 }).more; n++) assert.ok(n < 100); };

test('slice readiness follows edits, removals, rename, rollback and cold reopen', () => {
  const host = sqliteHost(':memory:');
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, model: definition });
  try {
    let store = open();
    store.write([list(), row('a', 'A'), row('b', 'B')]);
    store.checkpoint();
    assert.equal(store.backfillTables({ limit: 1 }).more, true);
    store.write([row('a', 'Edited'), { id: row('b', '').id, value: null }, row('c', 'C')]);
    store.checkpoint(); store = open(); finish(store);
    assert.deepEqual(store.tableRows('record:items').rows.map(item => [item.id, item.value.title]), [['record:items:a', 'Edited'], ['record:items:c', 'C']]);
    assert.throws(() => host.transaction(() => { store.write([list('items', 'number')]); throw Error('rollback declaration'); }), /rollback declaration/);
    store.forgetCached(); finish(store);
    assert.equal(store.tableSchema('record:items').schema.fields.find(field => field.field === 'title').value_type, 'text');
    store.write([list('items', 'number'), row('a', 3), row('c', 4)]); finish(store);
    assert.equal(store.tableSchema('record:items').schema.fields.find(field => field.field === 'title').value_type, 'number');
    store.write([list('renamed'), row('d', 'New kind', 'renamed')]); store.checkpoint();
    store = open(); finish(store);
    assert.deepEqual(store.tableRows('record:renamed').rows.map(item => item.value.title), ['New kind']);
    store.write([{ id: 'list:items', value: null }]); store.checkpoint();
    store = open(); assert.equal(store.backfillTables({ limit: 1 }).more, false);
    store.write([list(), row('fresh', 'Recreated')]); store.checkpoint();
    store = open(); finish(store);
    assert.ok(store.tableRows('record:items').rows.some(item => item.value.title === 'Recreated'));
  } finally { host.db.close(); }
});

test('a failed cursor write discards slice checks and retries from durable state', () => {
  const host = sqliteHost(':memory:');
  let armed = false;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    if (armed && /^INSERT INTO record_keys_meta/.test(query) && String(params[0]).startsWith('customer_table_build:')) throw Error('cursor refused');
    return exec(query, ...params);
  };
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, model: definition });
  try {
    const store = open(); store.write([list(), row('a', 'Kept'), row('b', 'Also kept')]); store.checkpoint();
    const before = host.db.prepare("SELECT value FROM record_keys_meta WHERE key = 'customer_table_build:record:items'").get();
    armed = true; assert.throws(() => store.backfillTables({ limit: 1 }), /cursor refused/); armed = false;
    assert.deepEqual(host.db.prepare("SELECT value FROM record_keys_meta WHERE key = 'customer_table_build:record:items'").get(), before);
    finish(store); finish(open());
    assert.deepEqual(store.tableRows('record:items').rows.map(item => item.value.title), ['Kept', 'Also kept']);
  } finally { host.db.close(); }
});

test('a completed cursor is invalidated when an old rowid layout rebuilds after reopen', () => {
  const host = sqliteHost(':memory:');
  const model = { kinds: [{ type: 'item', table: true, properties: { title: 'text' } }], value_kinds: { text: { is: 'string' } } };
  const open = () => recordLogStore(host.sql, { transaction: host.transaction, model });
  try {
    let store = open(); store.write([{ id: 'i-a', type: 'item', value: { title: 'A' } }, { id: 'i-b', type: 'item', value: { title: 'B' } }]);
    finish(store); store.checkpoint();
    const table = store.tableSchema('item').schema.table;
    const columns = host.db.prepare(`PRAGMA table_info("${table}")`).all();
    host.db.exec(`CREATE TABLE held AS SELECT * FROM "${table}"; DROP TABLE "${table}"`);
    host.db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" ${column.type}${column.name === '_id' ? ' PRIMARY KEY' : ''}`).join(', ')}); INSERT INTO "${table}" SELECT * FROM held; DROP TABLE held`);
    store = open(); store.write([{ id: 'i-c', type: 'item', value: { title: 'C' } }]);
    assert.equal(store.backfillTables({ limit: 1 }).more, true);
    finish(store); store = open();
    assert.deepEqual(store.tableRows('item').rows.map(item => item.value.title), ['A', 'B', 'C']);
    assert.match(host.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql, /WITHOUT ROWID$/);
  } finally { host.db.close(); }
});

test('a schema commit invalidates a sibling table already checked ready in this slice', () => {
  const host = sqliteHost(':memory:');
  const schemaKind = { type: 'table-schema-change', table: true, properties: { kind: 'text', event: 'text', field: 'text', old_type: 'text', new_type: 'text', changed_at: 'text' } };
  // A kind laid out here earlier (its one record since removed) whose declaration then gains a field: building it again
  // commits a schema change, which rebuilds the sibling. A kind never laid out and never written commits nothing.
  const laidOut = { type: 'a-new', table: true, properties: { title: 'text' } };
  const model = { kinds: [laidOut, schemaKind], value_kinds: { text: { is: 'string' } } };
  const changed = { ...model, kinds: [{ ...laidOut, properties: { title: 'text', note: 'text' } }, schemaKind] };
  const open = definition => recordLogStore(host.sql, { transaction: host.transaction, model: definition });
  try {
    let store = open(model);
    store.write([{ id: 'schema-seed', type: schemaKind.type, value: { kind: 'seed', event: 'kind_added', changed_at: '2026-10-12T00:00:00.000Z' } }, { id: 'a-new-gone', type: laidOut.type, value: { title: 'Gone' } }]);
    store.write([{ id: 'a-new-gone', value: null }]);
    finish(store); store.checkpoint();
    const table = store.tableSchema(schemaKind.type).schema.table;
    const retained = store.ids(schemaKind.type).sort();
    assert.ok(retained.length > 1, 'genuine retained schema history predates sibling build');
    // Authentic older rowid layout, with the otherwise current done cursor unchanged.
    const columns = host.db.prepare(`PRAGMA table_info("${table}")`).all();
    host.db.exec(`CREATE TABLE held AS SELECT * FROM "${table}"; DROP TABLE "${table}"`);
    host.db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" ${column.type}${column.name === '_id' ? ' PRIMARY KEY' : ''}`).join(', ')}); INSERT INTO "${table}" SELECT * FROM held; DROP TABLE held`);
    store = open(changed);
    const first = store.backfillTables({ limit: 1 });
    assert.equal(first.type, schemaKind.type, 'the changed kind\'s schema commit rebuilt the sibling, so it must be admitted');
    assert.equal(first.more, true, 'one copied history row cannot certify the whole rebuilt sibling');
    assert.equal(first.walked, 1, 'same row budget remains in force');
    finish(store);
    const physical = store.tableRows(schemaKind.type).rows.map(row => row.id).sort();
    assert.deepEqual(physical, store.ids(schemaKind.type).sort(), 'every retained schema record is present after bounded backfill');
    assert.ok(retained.every(id => physical.includes(id)));
  } finally { host.db.close(); }
});

test('a nested sibling rebuild invalidates the enclosing maintenance slice too', () => {
  const host = sqliteHost(':memory:');
  const schemaKind = { type: 'table-schema-change', table: true, properties: { kind: 'text', event: 'text', field: 'text', old_type: 'text', new_type: 'text', changed_at: 'text' } };
  // A kind laid out here earlier (its one record since removed) whose declaration then gains a field: building it again
  // commits a schema change, which rebuilds the sibling. A kind never laid out and never written commits nothing.
  const laidOut = { type: 'a-new', table: true, properties: { title: 'text' } };
  const model = { kinds: [laidOut, schemaKind], value_kinds: { text: { is: 'string' } } };
  const changed = { ...model, kinds: [{ ...laidOut, properties: { title: 'text', note: 'text' } }, schemaKind] };
  const open = model => recordLogStore(host.sql, { transaction: host.transaction, model, runs: { max_runs: 1000, fan_in: 1000 } });
  try {
    let store = open(model);
    store.write([{ id: 'schema-seed', type: schemaKind.type, value: { kind: 'seed', event: 'kind_added', changed_at: '2026-10-12T00:00:00.000Z' } }, { id: 'a-new-gone', type: laidOut.type, value: { title: 'Gone' } }]);
    store.write([{ id: 'a-new-gone', value: null }]);
    finish(store); store.checkpoint();
    const table = store.tableSchema(schemaKind.type).schema.table;
    const columns = host.db.prepare(`PRAGMA table_info("${table}")`).all();
    host.db.exec(`CREATE TABLE held AS SELECT * FROM "${table}"; DROP TABLE "${table}"`);
    host.db.exec(`CREATE TABLE "${table}" (${columns.map(column => `"${column.name}" ${column.type}${column.name === '_id' ? ' PRIMARY KEY' : ''}`).join(', ')}); INSERT INTO "${table}" SELECT * FROM held; DROP TABLE held`);
    store = open(changed);
    let statusReads = 0, entered = false, nested;
    const exec = host.sql.exec.bind(host.sql);
    host.sql.exec = (query, ...params) => {
      if (query === 'SELECT value FROM record_keys_meta WHERE key = ?' && params[0] === 'customer_table_build:table-schema-change') statusReads++;
      return exec(query, ...params);
    };
    // The first schema-table probe is task admission; the second is the active
    // builder's exact-signature inventory. Reenter only once that frame exists.
    const step = store.maintain({ max_pages: 1, left: () => {
      if (!entered && statusReads >= 2) { entered = true; nested = store.backfillTables({ limit: 1 }); }
      return 1;
    } });
    host.sql.exec = exec;
    assert.equal(entered, true);
    assert.equal(nested.type, schemaKind.type);
    assert.equal(nested.more, true);
    assert.equal(step.diagnostics.table_walk.type, schemaKind.type, 'enclosing cached-ready status was also invalidated');
    assert.ok(step.diagnostics.table_walk.walked > 0);
    finish(store);
    assert.deepEqual(store.tableRows(schemaKind.type).rows.map(row => row.id).sort(), store.ids(schemaKind.type).sort());
  } finally { host.db.close(); }
});

// A store that holds no record of its declared table kinds lays none of them out: the shared model is their schema
// (record-tables.mjs answers an unregistered kind from it), so the build writes nothing and reads no build state, at a
// cost that does not grow with the kinds declared. The authentic earlier owner laid every one out and reread them all.
test('real Workerd: declared kinds a store never wrote lay out nothing, at a cost independent of how many', { timeout: 120000 }, async () => {
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(new URL('../parts/record-log/do-work/record-log-store.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  const tableComplete = '), end = source.indexOf('  // Where the walk of records kept before the model stands:', start);
  assert.ok(start >= 0 && end > start, 'unique table-builder source boundary');
  assert.equal(source.indexOf('  const tableComplete = ', start + 1), -1);
  // Authentic previous owner region, captured before the candidate. Other source stays current for both roads.
  const original = "  const tableComplete = type => {\n    const state = keys.meta.get(tableKey(type));\n    return !!state?.done && state.signature === tableSignature(type);\n  };\n  const pendingTables = () => allKinds().filter(kind => (kind.declared_by || kind.table === true) && !tableComplete(kind.type));\n  function buildTables({ limit = 64, hasTime = () => true } = {}) {\n    inStep();\n    // One call walks up to `limit` records, going on to the next kind when one finishes (a kind with no records yet\n    // costs only its schema), so a store's empty table kinds never take a call each.\n    let walked = 0, type = null;\n    while (walked < limit) {\n      const kind = pendingTables()[0];\n      if (!kind || !hasTime()) break;\n      type = kind.type;\n      const signature = tableSignature(type);\n      let state = keys.meta.get(tableKey(type));\n      if (state?.signature !== signature) state = { signature, before: null, done: false };\n      schemaChanges = [];\n      try { typed.ensure(type); } finally {\n        const changes = schemaChanges;\n        schemaChanges = null;\n        markHistoryBoundary(changes.length);\n        if (changes.length) commit(schemaChangeEnvelopes(changes), contextOf({ actor: { by: 'table-schema' } }));\n      }\n      if (state.before !== null && !keys.meta.get(tableKey(type))) state = { signature, before: null, done: false };\n      const room = limit - walked;\n      const ids = idsOfType(type, { ...(state.before ? { before: state.before } : {}), limit: room + 1 });\n      let here = 0;\n      for (const id of ids.slice(0, room)) {\n        if (!hasTime()) break;\n        const found = kept(id);\n        if (found?.type === type) typed.put({ id, type, value: resolveRead(found.value, id) }, { actor: { by: 'table-backfill' }, validate: false });\n        state.before = id;\n        here += 1;\n      }\n      walked += here;\n      state.done = here === ids.length;\n      keys.meta.set(tableKey(type), state);\n      if (!state.done) break;\n    }\n    return { type, walked, more: pendingTables().length > 0 };\n  }\n";
  const beforeSource = source.slice(0, start) + original + source.slice(end);
  const bundles = {};
  for (const kind of ['before', 'after']) {
    const result = await build({ stdin: { contents: "export { recordLogStore } from './parts/record-log/do-work/record-log-store.mjs';", resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error', plugins: kind === 'before' ? [{ name: 'authentic-table-builder-before', setup(builder) {
      builder.onLoad({ filter: /\/parts\/record-log\/do-work\/record-log-store\.mjs$/ }, () => ({ contents: beforeSource, loader: 'js', resolveDir: root + 'parts/record-log/do-work' }));
    } }] : [] });
    bundles[kind] = result.outputFiles[0].text;
  }
  const worker = `
import {DurableObject} from 'cloudflare:workers';
import {recordLogStore as before} from './before.mjs';
import {recordLogStore as after} from './after.mjs';
const zero=()=>({statements:0,rows_read:0,rows_written:0});
export class Probe extends DurableObject {
  async fetch(request) {
    const url=new URL(request.url),n=Number(url.searchParams.get('n')),raw=this.ctx.storage.sql;
    let total=zero(),checks=zero();
    const sql={get databaseSize(){return raw.databaseSize;},exec(query,...params){
      const cursor=raw.exec(query,...params),rows=cursor.toArray();
      const charge=scope=>{scope.statements++;scope.rows_read+=cursor.rowsRead;scope.rows_written+=cursor.rowsWritten;};
      charge(total);if(query==='SELECT value FROM record_keys_meta WHERE key = ?'&&String(params[0]).startsWith('customer_table_build:'))charge(checks);
      return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
    }};
    const model={kinds:Array.from({length:n},(_,i)=>({type:'empty-'+String(i).padStart(4,'0'),table:true,properties:{title:'text'}})),value_kinds:{text:{is:'string'}}};
    const store=(url.searchParams.get('kind')==='before'?before:after)(sql,{transaction:fn=>this.ctx.storage.transactionSync(fn),model});
    total=zero();checks=zero();const result=store.backfillTables({limit:1}),first={total,checks};
    const progress=raw.exec("SELECT key,value FROM record_keys_meta WHERE key LIKE 'customer_table_build:%' ORDER BY key").toArray();
    total=zero();checks=zero();const repeat=store.backfillTables({limit:1}),second={total,checks};
    return Response.json({result,repeat,first,second,progress});
  }
}
export default{fetch(request,env){const url=new URL(request.url);return env.PROBE.get(env.PROBE.idFromName(url.search)).fetch(request);}};`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'table-build-linear-checks', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: worker }, 'before.mjs': { type: 'esm', contents: bundles.before }, 'after.mjs': { type: 'esm', contents: bundles.after } } },
    env: { PROBE: { type: 'durable-object', worker: 'table-build-linear-checks', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  const costs = [];
  try {
    for (const n of [16, 64]) {
      const read = async kind => { const response = await runtime.dispatchFetch('http://cost/table?n=' + n + '&kind=' + kind); assert.equal(response.status, 200); return response.json(); };
      const before = await read('before'), after = await read('after');
      assert.equal(before.progress.length, n, 'the earlier owner laid out every declared kind');
      assert.ok(before.first.total.rows_written > 0 && before.first.checks.statements >= n * n, 'and reread the whole table inventory per empty kind');
      assert.deepEqual(after.result, { type: null, walked: 0, more: false });
      assert.deepEqual(after.repeat, { type: null, walked: 0, more: false });
      assert.deepEqual(after.progress, [], 'no build state is kept for a kind with nothing to build');
      for (const step of [after.first, after.second]) {
        assert.equal(step.total.rows_written, 0, 'no table, registry, history or build state is written');
        assert.equal(step.checks.statements, 0, 'no build state is read');
      }
      costs.push(after.first.total.statements);
      console.log(JSON.stringify({ source_only: true, runtime: 'workerd', n, before: before.first, after: after.first, repeat: after.second }));
    }
    assert.equal(new Set(costs).size, 1, `the build's statements do not grow with the kinds declared: ${costs}`);
  } finally { await runtime.dispose(); }
});
