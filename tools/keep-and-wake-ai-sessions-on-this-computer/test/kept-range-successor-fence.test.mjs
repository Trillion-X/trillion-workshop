import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

function sample(keptRuns, sql, transaction = fn => fn(), meter = () => {}) {
  const options = { prefix: 'bracket', transaction, page_bytes: 128, cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
  let space = keptRuns(sql, options);
  const expected = [];
  for (let n = 0; n < 32; n++) {
    const key = 'k' + String(n).padStart(3, '0'), value = { n, text: 'x'.repeat(40) };
    expected.push([key, value]); space.put(key, value);
  }
  space.flush(); space = keptRuns(sql, options);
  const run = space.held().runs[0];
  const rows = sql.exec(`SELECT page, first FROM bracket_run_${run.run} WHERE page >= 0 ORDER BY page LIMIT 64`).toArray();
  if (rows.length !== run.pages || rows.length < 8) throw Error('fixture needs bounded multiple page fences');
  const from = JSON.parse(rows[3].first), hi = JSON.parse(rows[4].first), lo = from + '\u0000';
  meter(true); const answer = space.range(lo, hi); meter(false);
  const oracle = expected.filter(([key]) => key >= lo && key < hi);
  return { answer, oracle, from, lo, hi, successorPage: rows[4].page, pages: run.pages };
}

test('an empty bounded gap rejects its already-bracketed successor without reading its body', () => {
  const host = sqliteHost(':memory:');
  let measuring = false, queries = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { if (measuring) queries.push({ query, params }); return exec(query, ...params); };
  try {
    const result = sample(keptRuns, host.sql, host.transaction, value => { measuring = value; });
    assert.deepEqual(result.answer, result.oracle); assert.deepEqual(result.answer, []);
    assert.equal(queries.some(({ query, params }) => /^SELECT body FROM bracket_run_\d+ WHERE page = \?$/.test(query) && params[0] === result.successorPage), false);
  } finally { host.db.close(); }
});

test('ranges retain half-open bounds, newest tombstones, JS Unicode ordering, reverse and reused group seeks', () => {
  const host = sqliteHost(':memory:');
  const options = { prefix: 'semantic', transaction: host.transaction, page_bytes: 128, cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
  try {
    let space = keptRuns(host.sql, options);
    const model = new Map();
    const names = ['a', 'a0', 'a00', 'a1', 'b', 'b0', 'b9', 'c', 'm', 'x', 'x\u{1f600}', 'x\u{1f601}', 'x\ue000', 'x\uffff', 'z'];
    for (const [n, key] of names.entries()) { const value = { n, text: 'x'.repeat(40) }; space.put(key, value); model.set(key, value); }
    space.flush();
    for (const key of ['a', 'b0', 'x\u{1f600}']) { space.remove(key); model.delete(key); }
    space.put('b1', { n: 99 }); model.set('b1', { n: 99 }); space.flush();
    const oracle = (lo, hi, reverse = false) => {
      const values = [...model].filter(([key]) => key >= lo && key < hi).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return reverse ? values.reverse() : values;
    };
    for (const [lo, hi] of [['a\u0000', 'b'], ['b0\u0000', 'b1'], ['b0', 'c'], ['x\u{1f600}', 'x\ue000'], ['x\ue000', 'z'], ['n', 'w']]) {
      assert.deepEqual(space.range(lo, hi), oracle(lo, hi));
      assert.deepEqual(space.range(lo, hi, { reverse: true }), oracle(lo, hi, true));
      assert.deepEqual(space.range(lo, hi, { limit: 1 }), oracle(lo, hi).slice(0, 1));
    }
    const groups = ['a', 'b', 'c', 'm', 'x', 'z'];
    const expected = groups.flatMap(group => oracle(group, group + '\uffff\uffff').slice(-1));
    assert.deepEqual(space.groupHeads('a', '{', { groupEnd: key => key[0] + '\uffff\uffff' }), expected);
    space.reloadCatalog(); space = keptRuns(host.sql, options);
    assert.deepEqual(space.range('a', 'zz'), oracle('a', 'zz'));
    assert.deepEqual(space.groupHeads('a', '{', { groupEnd: key => key[0] + '\uffff\uffff' }), expected);
  } finally { host.db.close(); }
});

test('real Workerd successor rejection removes exactly the unnecessary body read with equal answers', { timeout: 120000 }, async () => {
  const source = readFileSync(new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url), 'utf8');
  // The correction is the successor check alone; the page the walk moves to (nextPage, sparse or dense) is the same before it.
  const correction = "        if (!reverse && nextFences.has(nextPage) && nextFences.get(nextPage) >= hi) {\n          // The immutable next page begins outside this range. Keep this\n          // value-free proof for a later seek that changes the group bounds.\n          head = null; headAt = index;\n          return;\n        }\n";
  assert.equal(source.split(correction).length, 2, 'unique actual corrected range boundary');
  const before = source.replace(correction, '');
  const modules = {};
  for (const [kind, contents] of [['before', before], ['after', source]]) {
    const bundle = await build({ stdin: { contents, resolveDir: new URL('../parts/record-log/do-work/', import.meta.url).pathname, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' });
    modules[kind + '.mjs'] = { type: 'esm', contents: bundle.outputFiles[0].text };
  }
  const worker = `
import {DurableObject} from 'cloudflare:workers';
import {keptRuns as before} from './before.mjs';
import {keptRuns as after} from './after.mjs';
const sample=${sample.toString()};
export class Probe extends DurableObject {
 fetch(request){const raw=this.ctx.storage.sql;let measuring=false,cost={statements:0,rows_read:0,rows_written:0,body_pages:[]};
  const sql={exec(query,...params){const cursor=raw.exec(query,...params),rows=cursor.toArray();
   if(measuring){cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;
    if(/^SELECT body FROM bracket_run_\\d+ WHERE page = \\?$/.test(query))cost.body_pages.push(params[0]);}
   return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}};
  const result=sample(new URL(request.url).searchParams.get('kind')==='before'?before:after,sql,fn=>this.ctx.storage.transactionSync(fn),value=>{measuring=value;});return Response.json({result,cost});}
}
export default{fetch(request,env){const kind=new URL(request.url).searchParams.get('kind');return env.PROBE.get(env.PROBE.idFromName(kind)).fetch(request);}};`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'range-successor-fence', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { ...modules, 'worker.mjs': { type: 'esm', contents: worker } } },
    env: { PROBE: { type: 'durable-object', worker: 'range-successor-fence', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const read = async kind => { const response = await runtime.dispatchFetch('http://cost/range?kind=' + kind); assert.equal(response.status, 200); return response.json(); };
    const old = await read('before'), next = await read('after');
    assert.deepEqual(next.result, old.result); assert.deepEqual(next.result.answer, next.result.oracle);
    assert.ok(old.cost.body_pages.includes(old.result.successorPage));
    assert.ok(!next.cost.body_pages.includes(next.result.successorPage));
    assert.equal(old.cost.statements - next.cost.statements, 1); assert.equal(old.cost.rows_read - next.cost.rows_read, 1);
    assert.equal(old.cost.rows_written, 0); assert.equal(next.cost.rows_written, 0);
    console.log(JSON.stringify({ runtime: 'workerd', source_only: true, before: old.cost, after: next.cost, successor: next.result.successorPage }));
  } finally { await runtime.dispose(); }
});
