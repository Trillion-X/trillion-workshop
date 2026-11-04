import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

// The real owner accepts a synchronous decoder. A decoder of the first selected
// value can itself read the remaining selected pages, while the outer grouped
// read still has those pages in its precomputed missing list. Both reads must
// count their one resident page once and leave the correctly sized LRU warm.
// This is an extension-boundary regression, not a claim about a live allocator.
function exercise(keptRuns, host, meter = () => {}) {
  const { sql, transaction } = host;
  const settings = { prefix: 'seed', transaction, page_bytes: 512, cache_bytes: 0, filter_bytes: 0, max_runs: 1000 };
  let space = keptRuns(sql, settings);
  const expected = Array.from({ length: 48 }, (_, index) => [
    `k${String(index).padStart(3, '0')}`, { index, text: 'value-' + String(index).padStart(3, '0') + '-'.repeat(32) },
  ]);
  for (const [key, value] of expected) space.put(key, value);
  space.flush();
  const run = space.held().runs[0];
  const rows = sql.exec(`SELECT page, first, body FROM seed_run_${run.run} WHERE page >= 0 ORDER BY page LIMIT 64`).toArray();
  if (rows.length !== run.pages || rows.length < 4) throw Error('fixture needs a bounded multi-page run');
  // Keys in a page's header: its suffixes follow the offsets' JSON after \u0002 (kept-runs.mjs), or an earlier page's s array.
  const keysInHeader = body => {
    const end = body.indexOf('\n'), sep = body.indexOf('\u0002');
    return sep < 0 || sep > end ? JSON.parse(body.slice(0, end)).s.length : body.slice(sep + 1, end).split('\u0003').length;
  };
  const bytes = rows.map(row => 64 + row.body.length * 2 + keysInHeader(row.body) * 16);
  const totalBytes = bytes.reduce((a, b) => a + b, 0);
  const capacity = Math.max(totalBytes, 4 * Math.max(...bytes));
  const firstKeys = rows.map(row => JSON.parse(row.first));
  let armed = true, reentries = 0;
  const parseJson = (text, context) => {
    if (armed && context?.kind === 'value' && context.key === firstKeys[0]) {
      armed = false; reentries++;
      for (const key of firstKeys.slice(1)) space.get(key);
    }
    return JSON.parse(text);
  };
  const open = decoder => keptRuns(sql, { ...settings, cache_bytes: capacity, parseJson: decoder });
  space = open(parseJson);
  const grouped = space.ranges([{ lo: 'k', hi: 'l' }]);
  const seededBytes = space.held().cache_bytes;
  meter(true);
  const warm = firstKeys.map(key => [key, space.get(key)]);
  meter(false);
  const warmBytes = space.held().cache_bytes;
  // Durable pages and their answers survive both reopening and catalog reset.
  space = open(JSON.parse);
  const reopened = space.ranges([{ lo: 'k', hi: 'l' }]);
  const reopenedBytes = space.held().cache_bytes;
  let rolledBack = false;
  try {
    transaction(() => { space.put('rollback-only', { index: -1 }); space.flush(); throw Error('rollback seed'); });
  } catch (error) { if (error.message !== 'rollback seed') throw error; rolledBack = true; }
  space.clearMemtable(); space.reloadCatalog();
  const resetBytes = space.held().cache_bytes;
  const rollbackValue = space.get('rollback-only');
  const recovered = space.ranges([{ lo: 'k', hi: 'l' }]);
  // A new run can reuse the rolled-back number without a stale seeded answer.
  space.put('new-after-rollback', { index: 99 }); space.flush();
  const afterRollback = space.get('new-after-rollback');
  return { pages: rows.length, totalBytes, capacity, reentries, grouped, expected, warm,
    seededBytes, warmBytes, reopened, reopenedBytes, rolledBack, resetBytes,
    rollbackAbsent: rollbackValue === undefined, recovered, afterRollback };
}

function exerciseInvalidation(keptRuns, host, textLength = 600) {
  const space = keptRuns(host.sql, { transaction: host.transaction, prefix: 'erasable',
    page_bytes: 512, cache_bytes: 4 * 1024 * 1024, filter_bytes: 0 });
  const original = { text: 'a'.repeat(textLength) }, changed = { text: 'b'.repeat(800) };
  space.put('a', original); space.put('b', { keep: true }); space.flush();
  space.reloadCatalog();
  const initial = space.get('a'), initialBytes = space.held().cache_bytes;
  const rewritten = space.rewriteKey('a', () => changed), rewrittenBytes = space.held().cache_bytes;
  const current = space.get('a');
  const dropped = space.dropKey('a'), droppedBytes = space.held().cache_bytes;
  const removed = space.get('a') === undefined, sibling = space.get('b');
  return { initialMatches: JSON.stringify(initial) === JSON.stringify(original), initialBytes,
    rewritten, rewrittenBytes, current, changed, dropped, droppedBytes, removed, sibling };
}

test('ordinary big-value rewrites and erasures release their cache charges', () => {
  // Equal part counts take rewriteKey's fast path. Shrinking a multipart value
  // rewrites its page reference; neither road may leave the retired value charged.
  for (const length of [600, 1024 * 1024 + 20]) {
    const host = sqliteHost(':memory:');
    try {
      const result = exerciseInvalidation(keptRuns, host, length);
      assert.equal(result.initialMatches, true); assert.ok(result.initialBytes > length * 3);
      assert.equal(result.rewritten, 1); assert.equal(result.rewrittenBytes, 0);
      assert.deepEqual(result.current, result.changed);
      assert.equal(result.dropped, 1); assert.equal(result.droppedBytes, 0);
      assert.equal(result.removed, true); assert.deepEqual(result.sibling, { keep: true });
    } finally { host.db.close(); }
  }
});

test('reentrant legacy page decoding replaces the cached entry without phantom bytes', () => {
  const host = sqliteHost(':memory:');
  const options = { prefix: 'legacy', transaction: host.transaction, page_bytes: 512, cache_bytes: 8192, filter_bytes: 0 };
  try {
    let space = keptRuns(host.sql, options); space.put('a', { n: 1 }); space.flush();
    const run = space.held().runs[0].run, body = JSON.stringify([['a', { n: 1 }]]);
    host.sql.exec(`UPDATE legacy_run_${run} SET body = ? WHERE page = 0`, body);
    let armed = true, reentries = 0;
    const parseJson = (text, context) => {
      if (armed && context?.kind === 'page') { armed = false; reentries++; space.get('a'); }
      return JSON.parse(text);
    };
    space = keptRuns(host.sql, { ...options, parseJson });
    assert.deepEqual(space.get('a'), { n: 1 }); assert.equal(reentries, 1);
    assert.equal(space.held().cache_bytes, 64 + body.length * 3, 'one decoded legacy page is resident');
    space.reloadCatalog(); assert.equal(space.held().cache_bytes, 0);
    assert.deepEqual(space.get('a'), { n: 1 });
  } finally { host.db.close(); }
});

test('reentrant grouped seeding counts replacement bytes once and preserves a warm cache across recovery', () => {
  const host = sqliteHost(':memory:');
  const exec = host.sql.exec.bind(host.sql);
  let measuring = false, bodyReads = 0;
  host.sql.exec = (query, ...params) => {
    if (measuring && /^SELECT body FROM seed_run_\d+ WHERE page = \?$/.test(query)) bodyReads++;
    return exec(query, ...params);
  };
  try {
    const result = exercise(keptRuns, host, value => { measuring = value; });
    assert.equal(result.reentries, 1);
    assert.deepEqual(result.grouped, result.expected);
    assert.equal(result.seededBytes, result.totalBytes);
    assert.equal(result.warmBytes, result.totalBytes);
    assert.equal(bodyReads, 0, 'all selected pages fit; repeated seeding must not evict them');
    assert.deepEqual(result.warm, result.expected.filter(([key]) => result.warm.some(([selected]) => selected === key)));
    assert.deepEqual(result.reopened, result.expected);
    assert.equal(result.reopenedBytes, result.totalBytes);
    assert.equal(result.rolledBack, true);
    assert.equal(result.resetBytes, 0);
    assert.equal(result.rollbackAbsent, true);
    assert.deepEqual(result.recovered, result.expected);
    assert.deepEqual(result.afterRollback, { index: 99 });
  } finally { host.db.close(); }
});

test('actual Workerd replacement accounting avoids warm page reads with identical durable answers', { timeout: 120000 }, async () => {
  const source = readFileSync(new URL('../parts/record-log/do-work/kept-runs.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  // Replacement and invalidation release exactly the bytes owned by this entry.');
  const end = source.indexOf('  const pageOf = ', start);
  assert.ok(start >= 0 && end > start, 'exact cache owner source boundary');
  // Authentic original cache owner, frozen at 2f4b7e67 before this patch.
  const original = "  function cached(key, load, bytesOf) {\n    const hit = cache.get(key);\n    if (hit) { cache.delete(key); cache.set(key, hit); return hit.value; }\n    const value = load();\n    const bytes = bytesOf(value);\n    if (bytes > settings.cache_bytes) return value;\n    cache.set(key, { value, bytes });\n    cacheBytes += bytes;\n    while (cacheBytes > settings.cache_bytes && cache.size > 1) {\n      const [oldest, entry] = cache.entries().next().value;\n      cache.delete(oldest);\n      cacheBytes -= entry.bytes;\n    }\n    noteSpan(key, value);\n    return value;\n  }\n  function seed(key, value, bytes) {\n    if (bytes > settings.cache_bytes / 4) return;\n    cache.delete(key);\n    cache.set(key, { value, bytes });\n    cacheBytes += bytes;\n    while (cacheBytes > settings.cache_bytes && cache.size > 1) {\n      const [oldest, entry] = cache.entries().next().value;\n      cache.delete(oldest);\n      cacheBytes -= entry.bytes;\n    }\n    noteSpan(key, value);\n  }\n  const dropCached = run => {\n    spans.delete(run);\n    for (const key of [...cache.keys()]) if (key.startsWith(`${run}:`)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }\n  };\n";
  const before = (source.slice(0, start) + original + source.slice(end)).replaceAll('forgetCached(`big:${big[0]}`)', 'cache.delete(`big:${big[0]}`)');
  const modules = {};
  for (const [kind, contents] of [['before', before], ['after', source]]) {
    const bundle = await build({ stdin: { contents, resolveDir: new URL('../parts/record-log/do-work/', import.meta.url).pathname, loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'error' });
    modules[kind + '.mjs'] = { type: 'esm', contents: bundle.outputFiles[0].text };
  }
  const worker = `
import { DurableObject } from 'cloudflare:workers';
import { keptRuns as before } from './before.mjs';
import { keptRuns as after } from './after.mjs';
const exercise = ${exercise.toString()};
const exerciseInvalidation = ${exerciseInvalidation.toString()};
export class Probe extends DurableObject {
  fetch(request) {
    const raw=this.ctx.storage.sql,kind=new URL(request.url).searchParams.get('kind');
    let measuring=false, cost={statements:0,rows_read:0,rows_written:0,body_statements:0};
    const sql={get databaseSize(){return raw.databaseSize;},exec(query,...params){
      const cursor=raw.exec(query,...params),rows=cursor.toArray();
      if(measuring){cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;
        if(query.includes('body')&&query.includes('FROM seed_run_'))cost.body_statements++;}
      return{toArray:()=>rows,[Symbol.iterator]:()=>rows[Symbol.iterator]()};
    }};
    const result=exercise(kind==='before'?before:after,{sql,transaction:fn=>this.ctx.storage.transactionSync(fn)},value=>{measuring=value;});
    const invalidation=exerciseInvalidation(kind==='before'?before:after,{sql,transaction:fn=>this.ctx.storage.transactionSync(fn)});
    return Response.json({result,cost,invalidation});
  }
}
export default { fetch(request,env){const kind=new URL(request.url).searchParams.get('kind');return env.PROBE.get(env.PROBE.idFromName(kind)).fetch(request);} };`;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'kept-seed-accounting', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: { ...modules, 'worker.mjs': { type: 'esm', contents: worker } } },
    env: { PROBE: { type: 'durable-object', worker: 'kept-seed-accounting', exportName: 'Probe' } }, exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const read = async kind => { const response = await runtime.dispatchFetch('http://cost/seed?kind=' + kind); assert.equal(response.status, 200); return response.json(); };
    const old = await read('before'), next = await read('after');
    for (const key of ['grouped', 'expected', 'warm', 'reopened', 'recovered', 'afterRollback']) assert.deepEqual(next.result[key], old.result[key], key);
    assert.equal(next.result.seededBytes, next.result.totalBytes);
    assert.equal(next.result.warmBytes, next.result.totalBytes);
    assert.equal(next.result.resetBytes, 0); assert.equal(next.result.rollbackAbsent, true);
    assert.equal(next.cost.body_statements, 0);
    console.log(JSON.stringify({ physical_accounting_witness: true, before: old.cost, after: next.cost }));
    assert.ok(old.cost.body_statements > 0, 'authentic pre-fix bookkeeping wrongly evicted fitting pages');
    assert.ok(next.cost.rows_read < old.cost.rows_read);
    assert.equal(next.cost.rows_written, 0); assert.equal(old.cost.rows_written, 0);
    assert.equal(next.invalidation.initialMatches, true); assert.equal(old.invalidation.initialMatches, true);
    assert.deepEqual(next.invalidation.current, old.invalidation.current);
    assert.deepEqual(next.invalidation.sibling, old.invalidation.sibling);
    assert.equal(next.invalidation.rewrittenBytes, 0); assert.equal(next.invalidation.droppedBytes, 0);
    assert.ok(old.invalidation.rewrittenBytes > 0); assert.ok(old.invalidation.droppedBytes > 0);
    console.log(JSON.stringify({ runtime: 'workerd', source_only: true, pages: next.result.pages,
      totalBytes: next.result.totalBytes, capacity: next.result.capacity, before: old.cost, after: next.cost }));
  } finally { await runtime.dispose(); }
});
