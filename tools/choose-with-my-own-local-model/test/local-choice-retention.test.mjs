import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { localChoiceObservations } from '../src/local-choice-observations.mjs';
import { localChoiceObservations as beforeOwner } from './fixtures/local-choice-observations-before.mjs';

const observation = n => ({ task: 'classify', surface: 'worker', outcome: 'answered', elapsed_ms: n });
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...params) {
    if (!params.length && /^CREATE\b/.test(query)) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    const rows = /^SELECT\b/.test(query) ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows };
  } };
  const rows = () => db.prepare('SELECT seq, elapsed_ms FROM local_choice_observations ORDER BY seq').all();
  const count = () => db.prepare('SELECT retained FROM local_choice_observation_window WHERE id = 1').get().retained;
  return { db, sql, rows, count };
}

test('retains the exact newest rows across legacy gaps, reopen, deletion and changed limits', () => {
  const { db, sql, rows, count } = fixture();
  try {
    const before = beforeOwner(sql, { limit: 20 });
    for (let n = 1; n <= 12; n++) before.observe(observation(n));
    db.exec('DELETE FROM local_choice_observations WHERE seq IN (3, 5, 8, 11)');
    const owner = localChoiceObservations(sql, { limit: 5 });
    assert.deepEqual(rows().map(row => row.seq), [6, 7, 9, 10, 12]);
    assert.equal(count(), 5);
    owner.observe(observation(13));
    assert.deepEqual(rows().map(row => row.seq), [7, 9, 10, 12, 13]);
    const reopened = localChoiceObservations(sql, { limit: 5 });
    reopened.observe(observation(14));
    assert.deepEqual(rows().map(row => row.seq), [9, 10, 12, 13, 14]);
    assert.equal(count(), 5);
    db.exec('DELETE FROM local_choice_observations WHERE seq = 12');
    assert.equal(count(), 4);
    owner.observe(observation(15));
    assert.deepEqual(rows().map(row => row.seq), [9, 10, 13, 14, 15]);
    assert.equal(count(), 5);
    localChoiceObservations(sql, { limit: 3 });
    assert.deepEqual(rows().map(row => row.seq), [13, 14, 15]);
    const expanded = localChoiceObservations(sql, { limit: 5 });
    expanded.observe(observation(16)); expanded.observe(observation(17));
    assert.deepEqual(rows().map(row => row.seq), [13, 14, 15, 16, 17]);
    assert.equal(count(), 5);
  } finally { db.close(); }
});

test('failed insert and outer rollback preserve history/count, then retry succeeds', () => {
  const { db, sql, rows, count } = fixture();
  try {
    const owner = localChoiceObservations(sql, { limit: 3 });
    for (let n = 1; n <= 3; n++) owner.observe(observation(n));
    const original = rows();
    db.exec(`CREATE TRIGGER injected_retention_failure BEFORE DELETE ON local_choice_observations
      BEGIN SELECT RAISE(ABORT, 'injected retention failure'); END`);
    assert.throws(() => owner.observe(observation(4)), /injected retention failure/);
    assert.deepEqual(rows(), original); assert.equal(count(), 3);
    db.exec('DROP TRIGGER injected_retention_failure');
    db.exec('BEGIN'); owner.observe(observation(4)); db.exec('ROLLBACK');
    assert.deepEqual(rows(), original); assert.equal(count(), 3);
    localChoiceObservations(sql, { limit: 3 }).observe(observation(4));
    assert.deepEqual(rows().map(row => row.elapsed_ms), [2, 3, 4]); assert.equal(count(), 3);
    const empty = localChoiceObservations(sql, { limit: 0 });
    empty.observe(observation(5)); assert.deepEqual(rows(), []); assert.equal(count(), 0);
  } finally { db.close(); }
});

test('retention owners remain independent across person databases', () => {
  const a = fixture(), b = fixture();
  try {
    const ownerA = localChoiceObservations(a.sql, { limit: 2 });
    const ownerB = localChoiceObservations(b.sql, { limit: 4 });
    for (let n = 1; n <= 5; n++) { ownerA.observe(observation(n)); ownerB.observe(observation(n)); }
    assert.deepEqual(a.rows().map(row => row.elapsed_ms), [4, 5]);
    assert.deepEqual(b.rows().map(row => row.elapsed_ms), [2, 3, 4, 5]);
    assert.equal(a.count(), 2); assert.equal(b.count(), 4);
  } finally { a.db.close(); b.db.close(); }
});

test('actual Workerd retention avoids a whole-window scan per answer at 500 and 2000 rows', { timeout: 120000 }, async () => {
  const before = readFileSync(new URL('./fixtures/local-choice-observations-before.mjs', import.meta.url));
  const blob = createHash('sha1').update(`blob ${before.length}\0`).update(before).digest('hex');
  assert.equal(blob, '5adcd642e9692c6ac045c23928577003234badf5', 'authentic immutable before owner');
  const after = readFileSync(new URL('../src/local-choice-observations.mjs', import.meta.url), 'utf8');
  const worker = String.raw`
import { DurableObject } from 'cloudflare:workers';
import { localChoiceObservations as before } from './before.mjs';
import { localChoiceObservations as after } from './after.mjs';
const zero=()=>({statements:0,rows_read:0,rows_written:0});
export class Probe extends DurableObject {
  async fetch(request) {
    const url=new URL(request.url), n=Number(url.searchParams.get('n')), kind=url.searchParams.get('kind');
    const raw=this.ctx.storage.sql; let cost=zero();
    const sql={exec(query,...params){const cursor=raw.exec(query,...params),rows=cursor.toArray();
      cost.statements++;cost.rows_read+=cursor.rowsRead;cost.rows_written+=cursor.rowsWritten;
      return{toArray:()=>rows};}};
    before(sql,{limit:n});
    raw.exec('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?) '
      + 'INSERT INTO local_choice_observations (seq,at,task,surface,outcome,elapsed_ms) '
      + 'SELECT x*3,\'2026-10-11T00:00:00Z\',\'classify\',\'worker\',\'answered\',x FROM n',n);
    const source=kind==='before'?before:after;
    let owner=source(sql,{limit:n});
    cost=zero();
    for(let k=1;k<=3;k++)owner.observe({task:'classify',surface:'worker',outcome:'answered',elapsed_ms:n+k});
    const warm=cost;
    cost=zero();owner=source(sql,{limit:n});const reopen=cost;
    const values=raw.exec('SELECT seq,elapsed_ms FROM local_choice_observations ORDER BY seq').toArray();
    return Response.json({warm,reopen,values});
  }
}
export default {fetch(request,env){const url=new URL(request.url);return env.PROBE.get(env.PROBE.idFromName(url.search)).fetch(request);}};`;
  const mf = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'local-choice-retention-cost', compatibilityDate: '2026-10-01',
    manifest: { mainModule: 'worker.mjs', modules: {
      'worker.mjs': { type: 'esm', contents: worker },
      'before.mjs': { type: 'esm', contents: before.toString('utf8') },
      'after.mjs': { type: 'esm', contents: after },
    } },
    env: { PROBE: { type: 'durable-object', worker: 'local-choice-retention-cost', exportName: 'Probe' } },
    exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    for (const n of [500, 2000]) {
      const baseline = await (await mf.dispatchFetch(`http://guard/retention?n=${n}&kind=before`)).json();
      const result = await (await mf.dispatchFetch(`http://guard/retention?n=${n}&kind=after`)).json();
      assert.deepEqual(result.values, baseline.values, 'exact retained seq/history across gaps');
      assert.equal(result.values.length, n);
      assert.deepEqual(result.values.slice(-3).map(row => row.elapsed_ms), [n + 1, n + 2, n + 3]);
      assert.ok(baseline.warm.rows_read >= n * 3, 'original owner genuinely scans its retained window');
      assert.ok(result.warm.rows_read <= 100, JSON.stringify({n, warm:result.warm}));
      assert.ok(result.warm.rows_read <= baseline.warm.rows_read / 20, 'at least 95% lower physical reads');
      assert.ok(result.warm.rows_written <= 20, 'count/trim writes remain bounded');
      assert.ok(result.reopen.rows_read <= 40, 'restart reuses durable count instead of scanning the window');
      console.log(JSON.stringify({ n, before: baseline.warm, after: result.warm, reopen: result.reopen }));
    }
  } finally { await mf.dispose(); }
});
