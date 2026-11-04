import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns, KeptRangeBudgetExceeded } from '../parts/record-log/do-work/kept-runs.mjs';

const beforeURL = new URL('./fixtures/kept-runs-before-cache-successor.mjs', import.meta.url);
const beforeSha256 = 'fec1cf69340e6508f9fe0663973123c4e62964ba0f624863dd425be10b45379e';

// Each requested gap is inside the run but has no key. Its predecessor and
// successor are distinct one-entry pages, so other windows cannot warm them.
// Seven probes use the recursive seek; eight use the shared batch seek.
function gapSample(owner, sql, transaction, count, meter = () => {}, readOptions = {}, warm = false) {
  const options = { prefix: 'limited_bracket', transaction, page_bytes: 128,
    cache_bytes: warm ? 128 * 1024 : 0, filter_bytes: 0, max_runs: 1000 };
  let space = owner(sql, options);
  const expected = [];
  for (let n = 0; n < 96; n += 1) {
    const key = 'k' + String(n).padStart(4, '0') + '~'.repeat(96), value = { n, text: 'x'.repeat(256) };
    expected.push([key, value]); space.put(key, value);
  }
  space.flush(); space = owner(sql, options);
  const run = space.held().runs[0];
  const rows = sql.exec(`SELECT page, first FROM limited_bracket_run_${run.run} WHERE page >= 0 ORDER BY page LIMIT 128`).toArray();
  if (rows.length !== 96 || run.pages !== 96 || rows.some((row, at) => row.page !== at)) {
    throw new Error('The witness requires 96 actual one-entry pages.');
  }
  const bounds = Array.from({ length: count }, (_, at) => {
    const page = 3 + at * 2;
    return { lo: JSON.parse(rows[page].first) + '\u0000', hi: JSON.parse(rows[page + 1].first) };
  });
  const oracle = expected.filter(([key]) => bounds.some(({ lo, hi }) => key >= lo && key < hi));
  const read = () => space.ranges(bounds, { limit_per_range: 32, ...readOptions });
  if (warm) read();
  meter(true); let answer;
  try { answer = read(); } finally { meter(false); }
  return { answer, oracle, bounds, successorPages: bounds.map((_, at) => 4 + at * 2), pages: run.pages };
}

test('finite multi-ranges reject already-verified successors on both small and batched seeks', () => {
  for (const count of [1, 7, 8, 12]) {
    const host = sqliteHost(':memory:');
    let measuring = false;
    const queries = [], exec = host.sql.exec.bind(host.sql);
    host.sql.exec = (query, ...params) => {
      if (measuring) queries.push({ query, params });
      return exec(query, ...params);
    };
    try {
      const result = gapSample(keptRuns, host.sql, host.transaction, count, value => { measuring = value; });
      assert.deepEqual(result.answer, result.oracle); assert.deepEqual(result.answer, []);
      const pointBodies = queries.filter(({ query }) => /^SELECT body FROM limited_bracket_run_\d+ WHERE page = \?$/.test(query));
      assert.deepEqual(pointBodies, [], `no successor body for ${count} unresolved probes`);
      const seeks = queries.filter(({ query }) => /SELECT page, first FROM limited_bracket_run_\d+ WHERE page IN/.test(query));
      assert.equal(seeks.length > 0, count >= 8, 'fixture crosses the real shared-batch seek boundary');
    } finally { host.db.close(); }
  }
});

test('finite windows retain JS Unicode order, half-open bounds, newest winners and tombstones after reopen', () => {
  const host = sqliteHost(':memory:');
  const options = { prefix: 'limited_semantic', transaction: host.transaction,
    page_bytes: 128, cache_bytes: 2048, filter_bytes: 0, max_runs: 1000, big_bytes: 256 };
  const model = new Map();
  let space = keptRuns(host.sql, options);
  const names = [...new Set([
    ...Array.from({ length: 32 }, (_, n) => 'a' + String(n).padStart(3, '0')),
    ...Array.from({ length: 16 }, (_, n) => 'k' + String(n).padStart(4, '0')),
    'a000\u0000tail', 'a0000', 'b', 'b0', 'c', 'i\u0000message', 'm', 'x',
    'x\u{1f600}', 'x\u{1f601}', 'x\ue000', 'x\uffff', 'z', 'zz',
  ])].sort();
  const put = (key, value) => { space.put(key, value); model.set(key, value); };
  const remove = key => { space.remove(key); model.delete(key); };
  const oracle = (bounds, limit) => {
    const ordered = [...model].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return [...new Map(bounds.filter(({ lo, hi }) => lo < hi).flatMap(({ lo, hi }) =>
      ordered.filter(([key]) => key >= lo && key < hi).slice(0, limit)))].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  };
  const windows = [
    ['a000\u0000', 'a001'], ['a', 'a003'], ['a004', 'a009'], ['a009\u0000', 'a010'],
    ['b', 'c'], ['i\u0000', 'j'], ['k0003\u0000', 'k0004'], ['m', 'w'],
    ['x\u{1f600}', 'x\ue000'], ['x\ue000', 'y'], ['z', '{'], ['n', 'n'],
  ].map(([lo, hi]) => ({ lo, hi }));
  try {
    for (const [n, key] of names.entries()) put(key, { n, old: 'x'.repeat(600) });
    space.flush();
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [n, key] of names.entries()) {
        if ((n + pass) % 5 === 0) remove(key);
        else if ((n + pass) % 3 === 0) put(key, { n, pass });
      }
      space.flush();
    }
    for (const count of [1, 7, 8, 12]) for (const limit of [0, 1, 2, 32]) {
      space = keptRuns(host.sql, options);
      const bounds = windows.slice(0, count);
      assert.deepEqual(space.ranges(bounds, { limit_per_range: limit }), oracle(bounds, limit));
      assert.deepEqual(space.ranges(bounds, { limit_per_range: limit }), oracle(bounds, limit), 'warm repeated read');
      space.reloadCatalog();
      assert.deepEqual(space.ranges(bounds, { limit_per_range: limit }), oracle(bounds, limit), 'catalog recovery discards read proof');
    }
    put('x\u{1f600}', { newest: true }); remove('x\ue000'); put('a000\u0000new', { newest: true });
    assert.deepEqual(space.ranges(windows, { limit_per_range: 2 }), oracle(windows, 2), 'pending memtable winners');
    space.flush(); space = keptRuns(host.sql, options);
    assert.deepEqual(space.ranges(windows, { limit_per_range: 2 }), oracle(windows, 2), 'durable winners after reopen');
  } finally { host.db.close(); }
});

test('only admitted page bodies consume the finite-range page budget; empty gaps need no value or entry budget', () => {
  for (const count of [1, 8]) {
    const host = sqliteHost(':memory:');
    const page_budget = { remaining: count }, value_budget = { remaining: 0 }, entry_budget = { remaining: 0 };
    try {
      const result = gapSample(keptRuns, host.sql, host.transaction, count, () => {}, { page_budget, value_budget, entry_budget });
      assert.deepEqual(result.answer, []);
      assert.equal(page_budget.remaining, 0, 'only the selected predecessor pages are admitted');
      assert.equal(value_budget.remaining, 0); assert.equal(entry_budget.remaining, 0);
    } finally { host.db.close(); }
  }
  const host = sqliteHost(':memory:');
  let measuring = false;
  const queries = [], exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    if (measuring) queries.push(query);
    return exec(query, ...params);
  };
  try {
    assert.throws(() => gapSample(keptRuns, host.sql, host.transaction, 8,
      value => { measuring = value; }, { page_budget: { remaining: 0 } }), KeptRangeBudgetExceeded);
    assert.equal(queries.some(query => /SELECT (?:page, )?body FROM limited_bracket_run_/.test(query)), false,
      'a refused initial page is not fetched before its budget check');
  } finally { host.db.close(); }
});

test('finite windows charge only live winners and never open superseded or removed large values', () => {
  const host = sqliteHost(':memory:');
  const parsed = [], queries = [];
  const exec = host.sql.exec.bind(host.sql);
  let measuring = false;
  host.sql.exec = (query, ...params) => {
    if (measuring) queries.push(query);
    return exec(query, ...params);
  };
  const options = { prefix: 'limited_winner', transaction: host.transaction, page_bytes: 128,
    cache_bytes: 0, filter_bytes: 0, big_bytes: 256, max_runs: 1000,
    parseJson(text, context) { if (measuring) parsed.push(context); return JSON.parse(text); } };
  try {
    let space = keptRuns(host.sql, options);
    space.put('a', { old: 'a'.repeat(20000) }); space.put('b', { old: 'b'.repeat(20000) }); space.flush();
    space.remove('a'); const winner = { current: 'b' }; space.put('b', winner); space.flush();
    space = keptRuns(host.sql, options);
    const value_budget = { remaining: JSON.stringify(winner).length }, entry_budget = { remaining: 2 };
    measuring = true;
    assert.deepEqual(space.ranges([{ lo: 'a', hi: 'c' }], { limit_per_range: 1, value_budget, entry_budget }), [['b', winner]]);
    measuring = false;
    assert.equal(value_budget.remaining, 0); assert.equal(entry_budget.remaining, 0);
    assert.equal(queries.some(query => query.includes('SELECT body FROM limited_winner_big')), false);
    assert.equal(parsed.some(context => context.kind === 'big'), false);
    assert.throws(() => space.ranges([{ lo: 'b', hi: 'c' }], {
      limit_per_range: 1, value_budget: { remaining: 0 },
    }), KeptRangeBudgetExceeded, 'a live winner retains its value admission');
  } finally { host.db.close(); }
});

test('real Workerd small and batched finite-range reads avoid only the unnecessary successor bodies', { timeout: 120000 }, async () => {
  const before = readFileSync(beforeURL, 'utf8');
  assert.equal(createHash('sha256').update(before).digest('hex'), beforeSha256,
    'byte-identical owner from immutable 4706541941942bb201b8dcc5ceb5317f50fcc40f');
  const after = readFileSync(new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url), 'utf8');
  const modules = {};
  for (const [kind, contents] of [['before', before], ['after', after]]) {
    const bundle = await build({ stdin: { contents, loader: 'js', resolveDir: fileURLToPath(new URL('../parts/record-log/do-work/', import.meta.url)) }, bundle: true, write: false,
      format: 'esm', platform: 'browser', logLevel: 'error' });
    modules[kind + '.mjs'] = { type: 'esm', contents: bundle.outputFiles[0].text };
  }
  const worker = `
import {DurableObject} from 'cloudflare:workers';
import {keptRuns as before} from './before.mjs';
import {keptRuns as after} from './after.mjs';
const gapSample=${gapSample.toString()};
export class Probe extends DurableObject {
 fetch(request){const url=new URL(request.url),raw=this.ctx.storage.sql;
  let measuring=false,cost={statements:0,rows_read:0,rows_written:0,point_body_pages:[],seek_queries:[]};
  const sql={exec(query,...params){const cursor=raw.exec(query,...params),rows=cursor.toArray();
   if(measuring){cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;
    if(/^SELECT body FROM limited_bracket_run_\\d+ WHERE page = \\?$/.test(query))cost.point_body_pages.push(params[0]);
    if(/(?:WITH RECURSIVE halving|SELECT page, first FROM limited_bracket_run_)/.test(query))cost.seek_queries.push({query,params});}
   return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};}};
  const result=gapSample(url.searchParams.get('kind')==='before'?before:after,sql,
   fn=>this.ctx.storage.transactionSync(fn),Number(url.searchParams.get('count')),value=>{measuring=value;},{},url.searchParams.get('warm')==='1');
  return Response.json({result,cost});}
}
export default{fetch(request,env){const url=new URL(request.url);return env.PROBE.get(env.PROBE.idFromName(url.search)).fetch(request);}};`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'limited-range-successor', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { ...modules, 'worker.mjs': { type: 'esm', contents: worker } } },
    env: { PROBE: { type: 'durable-object', worker: 'limited-range-successor', exportName: 'Probe' } },
    exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    for (const count of [1, 7, 8, 12]) for (const warm of [false, true]) {
      const read = async kind => {
        const response = await runtime.dispatchFetch('http://cost/limited?kind=' + kind + '&count=' + count + '&warm=' + Number(warm));
        assert.equal(response.status, 200); return response.json();
      };
      const old = await read('before'), next = await read('after');
      assert.deepEqual(next.result, old.result); assert.deepEqual(next.result.answer, next.result.oracle);
      assert.equal(old.cost.rows_written, 0); assert.equal(next.cost.rows_written, 0);
      if (!warm) {
        assert.deepEqual(next.cost.seek_queries, old.cost.seek_queries, 'no added or changed cold seek SQL/probes');
        assert.deepEqual(old.cost.point_body_pages, old.result.successorPages, 'actual old successor body reads');
        assert.deepEqual(next.cost.point_body_pages, []);
        assert.equal(old.cost.statements - next.cost.statements, count);
        assert.equal(old.cost.rows_read - next.cost.rows_read, count);
      } else {
        // A charged successor proof belongs to the resident predecessor page.
        // Repeating these gaps must preserve the authentic prior zero-SQL path.
        assert.deepEqual(old.cost.point_body_pages, []);
        assert.deepEqual(next.cost.point_body_pages, []);
        assert.equal(old.cost.statements, 0); assert.equal(old.cost.rows_read, 0);
        assert.equal(next.cost.statements, 0); assert.equal(next.cost.rows_read, 0);
        assert.deepEqual(next.cost.seek_queries, old.cost.seek_queries);
      }
      console.log(JSON.stringify({ runtime: 'workerd', source_only: true, count, warm, before: old.cost, after: next.cost }));
    }
  } finally { await runtime.dispose(); }
});
