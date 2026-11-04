import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const model = n => ({ kinds: Array.from({ length: n }, (_, i) => ({ type: 'table-' + String(i).padStart(3, '0'), table: true, properties: { title: 'text' } })), value_kinds: { text: { is: 'string' } } });
const rows = [{ id: 'a', type: 'table-000', value: { title: 'A' } }, { id: 'b', type: 'table-000', value: { title: 'B' } }];
test('first unfinished table admits one row without inspecting unrelated kind cursors', () => {
  const host = sqliteHost(':memory:');
  try {
    const store = recordLogStore(host.sql, { transaction: host.transaction, model: model(64) });
    store.write(rows); store.checkpoint();
    let reads = [];
    const exec = host.sql.exec.bind(host.sql);
    host.sql.exec = (query, ...params) => { if (query === 'SELECT value FROM record_keys_meta WHERE key = ?' && String(params[0]).startsWith('customer_table_build:')) reads.push(params[0]); return exec(query, ...params); };
    const first = store.backfillTables({ limit: 1 });
    assert.deepEqual(first, { type: 'table-000', walked: 1, more: true });
    assert.deepEqual([...new Set(reads)], ['customer_table_build:table-000']);
    // Admission's read, the builder's read, and the read the cursor's own write makes first (kept-runs.mjs meta.set
    // writes nothing when the value is already kept). The 63 declared kinds never written are not read at all.
    assert.equal(reads.length, 3);
    for (let i = 0; store.backfillTables({ limit: 1 }).more; i++) assert.ok(i < 100);
    assert.deepEqual(store.tableRows('table-000').rows.map(row => row.value.title), ['A', 'B']);
    store.checkpoint();
    const reopened = recordLogStore(host.sql, { transaction: host.transaction, model: model(64) });
    assert.deepEqual(reopened.backfillTables({ limit: 1 }), { type: null, walked: 0, more: false });
    assert.deepEqual(reopened.tableRows('table-000').rows.map(row => row.value.title), ['A', 'B']);
  } finally { host.db.close(); }
});

test('Workerd pending-table admission stays constant while unrelated declarations grow', { timeout: 120000 }, async () => {
  const root = new URL('..', import.meta.url).pathname;
  const source = readFileSync(new URL('../parts/record-log/do-work/record-log-store.mjs', import.meta.url), 'utf8');
  const after = '  // Admission needs only the first unfinished table. Later kinds are checked when that table finishes.\n  const nextPendingTable = (checked = null) => allKinds().find(kind => (kind.declared_by || kind.table === true) && !tableComplete(kind.type, checked));';
  const before = '  const pendingTables = (checked = null) => allKinds().filter(kind => (kind.declared_by || kind.table === true) && !tableComplete(kind.type, checked));';
  assert.equal(source.split(after).length, 2, 'unique actual changed admission owner');
  // Restore the authentic 95d9dd0 owner predicate and its five callers; every other source byte remains identical.
  let original = source.replace(after, before).replace('nextPendingTable(checked);', 'pendingTables(checked)[0];').replace('!!nextPendingTable(checked)', 'pendingTables(checked).length > 0').replaceAll('!!nextPendingTable()', 'pendingTables().length > 0');
  assert.equal(original.includes('nextPendingTable'), false);
  const bundles = {};
  for (const kind of ['before', 'after']) {
    const result = await build({ stdin: { contents: "export { recordLogStore } from './parts/record-log/do-work/record-log-store.mjs';", resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error', plugins: kind === 'before' ? [{ name: 'authentic-pending-table-before', setup(builder) {
      builder.onLoad({ filter: /\/parts\/record-log\/do-work\/record-log-store\.mjs$/ }, () => ({ contents: original, loader: 'js', resolveDir: root + 'parts/record-log/do-work' }));
    } }] : [] });
    bundles[kind] = result.outputFiles[0].text;
  }
  const worker = `
import {DurableObject} from 'cloudflare:workers';
import {recordLogStore as before} from './before.mjs';
import {recordLogStore as after} from './after.mjs';
const model=${model.toString()},seed=${JSON.stringify(rows)};
export class Probe extends DurableObject {
 fetch(request){const url=new URL(request.url),n=Number(url.searchParams.get('n')),raw=this.ctx.storage.sql;let armed=false,cost={statements:0,rows_read:0,rows_written:0},checks={statements:0,rows_read:0};
 const sql={exec(query,...params){const cursor=raw.exec(query,...params),rows=cursor.toArray();if(armed){cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;if(query==='SELECT value FROM record_keys_meta WHERE key = ?'&&String(params[0]).startsWith('customer_table_build:')){checks.statements++;checks.rows_read+=cursor.rowsRead;}}return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}};
 const store=(url.searchParams.get('kind')==='before'?before:after)(sql,{transaction:fn=>this.ctx.storage.transactionSync(fn),model:model(n)});store.write(seed);store.checkpoint();armed=true;const result=store.backfillTables({limit:1});armed=false;
 const progress=raw.exec("SELECT key,value FROM record_keys_meta WHERE key LIKE 'customer_table_build:%' ORDER BY key").toArray();return Response.json({result,cost,checks,progress});}
}
export default{fetch(request,env){const url=new URL(request.url);return env.PROBE.get(env.PROBE.idFromName(url.search)).fetch(request);}};`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'first-pending-table', compatibilityDate: '2026-10-01', manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: worker }, 'before.mjs': { type: 'esm', contents: bundles.before }, 'after.mjs': { type: 'esm', contents: bundles.after } } },
    env: { PROBE: { type: 'durable-object', worker: 'first-pending-table', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const costs = [];
    for (const n of [16, 64]) {
      const read = async kind => { const response = await runtime.dispatchFetch('http://cost/table?n=' + n + '&kind=' + kind); assert.equal(response.status, 200); return response.json(); };
      const before = await read('before'), after = await read('after');
      assert.deepEqual(after.result, before.result); assert.deepEqual(after.progress, before.progress);
      assert.deepEqual(after.result, { type: 'table-000', walked: 1, more: true });
      assert.equal(after.cost.rows_written, before.cost.rows_written, 'identical durable schema, history and cursor writes');
      // Declared kinds the store never wrote are complete before any build state is read (record-log-store.mjs
      // unusedKind), on both roads: only the one written kind's status is read, however many kinds are declared.
      assert.equal(before.checks.statements, 3); assert.equal(after.checks.statements, 3);
      assert.ok(after.cost.statements <= before.cost.statements);
      assert.ok(after.cost.rows_read <= before.cost.rows_read);
      costs.push(after.cost.statements);
      console.log(JSON.stringify({ runtime: 'workerd', source_only: true, n, before: before.cost, after: after.cost, before_checks: before.checks, after_checks: after.checks }));
    }
    assert.equal(new Set(costs).size, 1, `admission's statements do not grow with unrelated declarations: ${costs}`);
  } finally { await runtime.dispose(); }
});
