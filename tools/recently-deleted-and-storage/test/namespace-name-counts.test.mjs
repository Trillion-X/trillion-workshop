// Ported from old trillion test/namespace-name-counts.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The owner, namespace-name-counts.mjs (and namespace-store.mjs for the Workerd
// listing), moved here byte for byte; only the imports and the Workerd probe's bundle directory changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { namespaceNameCounts } from '../namespace-name-counts.mjs';

const host = () => {
  const store = sqliteHost(':memory:');
  store.sql.exec(`CREATE TABLE namespace_names (
    name TEXT PRIMARY KEY, collection TEXT NOT NULL, identity TEXT,
    byte_length INTEGER, modified_at_ms INTEGER, named_at TEXT NOT NULL)`);
  store.sql.exec('CREATE INDEX namespace_names_identity ON namespace_names(identity)');
  return store;
};
const add = (sql, rowid, identity) => sql.exec(`INSERT INTO namespace_names
  (rowid, name, collection, identity, named_at) VALUES (?, ?, '/', ?, '2026-10-10')`, rowid, `/name-${rowid}`, identity);
const exact = sql => sql.exec(`SELECT identity, COUNT(*) AS names FROM namespace_names
  WHERE identity IS NOT NULL GROUP BY identity HAVING COUNT(*) > 1 ORDER BY identity`).toArray().map(row => ({ ...row }));
const summary = sql => sql.exec('SELECT identity, names FROM namespace_name_counts ORDER BY identity').toArray().map(row => ({ ...row }));
const fill = (store, owner) => {
  let pages = 0;
  while (!owner.ready()) {
    assert.ok(++pages < 100, 'migration must finish');
    const result = store.transaction(() => owner.fillStep.step());
    assert.ok(result.rows <= 256, 'each page is bounded before grouping');
  }
  assert.deepEqual(summary(store.sql), exact(store.sql));
};
const changes = sql => sql.exec('SELECT total_changes() AS changes').one().changes;

test('legacy pages remain exact through mutations above and below cursor and reopen', () => {
  const store = host(), { sql } = store;
  for (let id = 1; id <= 700; id++) add(sql, id, id % 9 === 0 ? null : `file-${id % 5}`);
  const queries = [];
  let owner = namespaceNameCounts({ exec(query, ...params) { queries.push(query); return sql.exec(query, ...params); } });
  assert.equal(owner.ready(), false);
  assert.ok(queries.every(query => !/COUNT\(|GROUP BY/.test(query)), 'construction never aggregates names');
  assert.equal(owner.fillStep.nextAt(), 0);
  assert.deepEqual(store.transaction(() => owner.fillStep.step()), { done: false, rows: 256 });
  assert.equal(sql.exec('SELECT after_rowid FROM namespace_name_count_state').one().after_rowid, 256);
  sql.exec("UPDATE namespace_names SET identity = 'changed' WHERE rowid IN (10, 600)");
  sql.exec('UPDATE namespace_names SET identity = NULL WHERE rowid IN (11, 601)');
  sql.exec("UPDATE namespace_names SET identity = 'from-null' WHERE rowid IN (9, 603)");
  sql.exec('DELETE FROM namespace_names WHERE rowid IN (12, 602)');
  add(sql, 12, 'reused-prefix');
  add(sql, 602, 'reused-future');
  add(sql, 800, 'future');
  owner = namespaceNameCounts(sql);
  fill(store, owner);
  assert.equal(owner.fillStep.nextAt(), null);
  assert.deepEqual(owner.fillStep.step(), { done: true, rows: 0 });
  add(sql, 801, 'future');
  sql.exec('DELETE FROM namespace_names WHERE rowid = 800');
  assert.deepEqual(summary(sql), exact(sql), 'reopened triggers stay active');
  store.db.close();
});

test('rollback midway through a page retains counts and cursor across reopen', () => {
  const store = host(), { sql } = store;
  for (let id = 1; id <= 600; id++) add(sql, id, 'one');
  let fail = false;
  let owner = namespaceNameCounts({ exec(query, ...params) {
    if (fail && query.startsWith('UPDATE namespace_name_count_state SET after_rowid')) throw new Error('interrupt before cursor');
    return sql.exec(query, ...params);
  } });
  store.transaction(() => owner.fillStep.step());
  fail = true;
  assert.throws(() => store.transaction(() => owner.fillStep.step()), /interrupt before cursor/);
  assert.deepEqual(summary(sql), [{ identity: 'one', names: 256 }]);
  assert.equal(sql.exec('SELECT after_rowid FROM namespace_name_count_state').one().after_rowid, 256);
  owner = namespaceNameCounts(sql);
  fill(store, owner);
  assert.deepEqual(summary(sql), [{ identity: 'one', names: 600 }]);
  assert.throws(() => store.transaction(() => {
    sql.exec('UPDATE namespace_name_count_state SET complete = 0');
    assert.equal(owner.ready(), false);
    throw new Error('again');
  }), /again/);
  assert.equal(owner.ready(), true, 'readiness is not cached from rolled-back state');
  store.db.close();
});

test('negative and zero rowids, nullable identities and rowid movement cross the prefix correctly', () => {
  const store = host(), { sql } = store;
  for (let id = -2; id <= 300; id++) add(sql, id, id === 0 ? 'zero' : id === 1 ? null : 'same');
  const owner = namespaceNameCounts(sql);
  store.transaction(() => owner.fillStep.step());
  assert.equal(sql.exec('SELECT after_rowid FROM namespace_name_count_state').one().after_rowid, 253);
  // Same and changed identities in both directions, including counted NULL.
  sql.exec('UPDATE namespace_names SET rowid = 900 WHERE rowid = -2');
  sql.exec("UPDATE namespace_names SET rowid = 901, identity = 'moved-out' WHERE rowid = -1");
  sql.exec('UPDATE namespace_names SET rowid = -10 WHERE rowid = 299');
  sql.exec("UPDATE namespace_names SET rowid = -11, identity = 'moved-in' WHERE rowid = 300");
  sql.exec("UPDATE namespace_names SET rowid = 902, identity = 'from-null' WHERE rowid = 0");
  sql.exec("UPDATE namespace_names SET rowid = 903, identity = 'from-null-prefix' WHERE rowid = 1");
  sql.exec('UPDATE namespace_names SET rowid = -12, identity = NULL WHERE rowid = 298');
  const prefix = sql.exec(`SELECT identity, COUNT(*) AS names FROM namespace_names
    WHERE rowid <= 253 AND identity IS NOT NULL GROUP BY identity HAVING COUNT(*) > 1 ORDER BY identity`).toArray().map(row => ({ ...row }));
  assert.deepEqual(summary(sql), prefix);
  fill(store, owner);
  sql.exec('DELETE FROM namespace_names WHERE rowid = 902');
  assert.equal(owner.counts(['from-null']).length, 0, 'zero-count projection rows disappear');
  assert.deepEqual(summary(sql), exact(sql));
  store.db.close();
});

test('clear/reset atomically resets migration and subsequent inserts are counted immediately', () => {
  const store = host(), { sql } = store;
  for (let id = 1; id <= 300; id++) add(sql, id, 'old');
  const owner = namespaceNameCounts(sql);
  store.transaction(() => owner.fillStep.step());
  assert.throws(() => store.transaction(() => { sql.exec('DELETE FROM namespace_names'); owner.reset(); throw new Error('rollback-clear'); }), /rollback-clear/);
  assert.equal(owner.ready(), false);
  assert.deepEqual(summary(sql), [{ identity: 'old', names: 256 }]);
  store.transaction(() => { sql.exec('DELETE FROM namespace_names'); owner.reset(); });
  assert.equal(owner.ready(), true);
  assert.deepEqual(summary(sql), []);
  add(sql, 1, 'new');
  add(sql, 2, null);
  assert.deepEqual(summary(sql), [], 'a unique name requires no summary row');
  assert.deepEqual(owner.counts(['new']).map(row => ({ ...row })), [{ identity: 'new', names: 1 }]);
  const before = changes(sql);
  sql.exec("UPDATE namespace_names SET name = '/renamed', collection = '/folder', byte_length = 20, modified_at_ms = 12 WHERE rowid = 1");
  assert.equal(changes(sql) - before, 1, 'metadata writes only the source row');
  assert.deepEqual(summary(sql), exact(sql));
  store.db.close();
});

test('empty stores are ready and warm lookup cost stays independent of duplicate names elsewhere', () => {
  const witness = duplicateNames => {
    const store = host(), { sql } = store, queries = [];
    const owner = namespaceNameCounts({ exec(query, ...params) { queries.push({ query, params }); return sql.exec(query, ...params); } });
    assert.equal(owner.ready(), true);
    store.transaction(() => {
      for (let id = 1; id <= duplicateNames; id++) add(sql, id, 'shared');
      add(sql, duplicateNames + 1, 'other');
    });
    queries.length = 0;
    const before = changes(sql);
    assert.equal(owner.counts(['shared', 'shared', null, 'missing'])[0].names, duplicateNames);
    assert.equal(changes(sql), before, 'warm reads do not write');
    assert.equal(queries.length, 1);
    assert.ok(queries.every(({ query }) => !/COUNT\(|GROUP BY/.test(query)), 'warm lookup never aggregates source names');
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${queries[0].query}`, ...queries[0].params).toArray();
    assert.ok(plan.some(row => /SEARCH namespace_name_counts USING INDEX/.test(row.detail)), 'requested identities seek the summary primary key');
    const result = queries.map(({ query, params }) => ({ query, params }));
    store.db.close();
    return result;
  };
  assert.deepEqual(witness(100), witness(10000), 'identical warm SQL and parameters with two orders more duplicate names');
});

test('unique names add no projection writes and promotion/demotion retains exact counts', () => {
  const store = host(), { sql } = store, owner = namespaceNameCounts(sql);
  const before = changes(sql);
  add(sql, 1, 'one');
  assert.equal(changes(sql) - before, 1, 'a first name writes only itself');
  assert.deepEqual(summary(sql), []);
  add(sql, 2, 'one');
  assert.deepEqual(summary(sql), [{ identity: 'one', names: 2 }]);
  sql.exec('DELETE FROM namespace_names WHERE rowid = 2');
  assert.deepEqual(summary(sql), []);
  assert.deepEqual(owner.counts(['one', 'missing']).map(row => ({ ...row })), [{ identity: 'one', names: 1 }]);
  store.db.close();
});

test('a legacy singleton promotes when its second name is on a later fill page', () => {
  const store = host(), { sql } = store;
  for (let n = 1; n <= 300; n++) add(sql, n, n === 1 || n === 300 ? 'split' : `single-${n}`);
  const owner = namespaceNameCounts(sql);
  store.transaction(() => owner.fillStep.step());
  assert.deepEqual(summary(sql), [], 'first-page singletons do not write summary rows');
  store.transaction(() => owner.fillStep.step());
  assert.deepEqual(summary(sql), [{ identity: 'split', names: 2 }], 'one old-prefix singleton plus one page row');
  fill(store, owner);
  sql.exec('DELETE FROM namespace_names WHERE rowid = 300');
  assert.deepEqual(summary(sql), []);
  assert.equal(owner.counts(['split'])[0].names, 1);
  add(sql, 300, 'split');
  assert.deepEqual(summary(sql), [{ identity: 'split', names: 2 }]);
  store.db.close();
});

// This exercises the full integrated listing in real SQLite Durable Objects.
// It must fail if the owner retains the old per-page COUNT over duplicate names.
test('warm full folder listings read constant Workerd rows with 100 versus 10000 duplicate names', async () => {
  const bundled = await build({ stdin: {
    contents: `export { namespaceStore } from './namespace-store.mjs';\nexport { namespaceNameCounts } from './namespace-name-counts.mjs';`,
    resolveDir: new URL('../', import.meta.url).pathname,
    sourcefile: 'namespace-count-probe.mjs', loader: 'js',
  }, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error' });
  const script = `
    import { DurableObject } from 'cloudflare:workers';
    import { namespaceStore, namespaceNameCounts } from './namespace.mjs';
    export class Probe extends DurableObject {
      async fetch(request) {
        const duplicateNames = Number(new URL(request.url).searchParams.get('duplicates'));
        const sql = this.ctx.storage.sql;
        let reads = 0;
        const watched = { exec(query, ...params) {
          const cursor = sql.exec(query, ...params);
          const rows = cursor.toArray();
          reads += cursor.rowsRead;
          return { toArray: () => rows, one: () => {
            if (rows.length !== 1) throw new Error('Expected one row');
            return rows[0];
          }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        } };
        if (new URL(request.url).searchParams.has('pending')) {
          sql.exec('CREATE TABLE namespace_names (name TEXT PRIMARY KEY, collection TEXT, identity TEXT, named_at TEXT)');
          sql.exec('CREATE INDEX namespace_names_identity ON namespace_names(identity)');
          this.ctx.storage.transactionSync(() => {
            for (let n = 1; n <= 300; n++) sql.exec("INSERT INTO namespace_names(rowid, name, collection, identity, named_at) VALUES (?, ?, '/', NULL, 'now')", n, '/folder-' + n);
            for (let n = 0; n < duplicateNames; n++) sql.exec("INSERT INTO namespace_names(name, collection, identity, named_at) VALUES (?, '/', 'shared', 'now')", '/future-' + n);
          });
          const counts = namespaceNameCounts(watched);
          this.ctx.storage.transactionSync(() => counts.fillStep.step());
          reads = 0;
          watched.exec("INSERT INTO namespace_names(rowid, name, collection, identity, named_at) VALUES (-1, '/prefix', '/', 'shared', 'now')");
          return Response.json({ rows_read: reads, prefix_count: counts.counts(['shared'])[0].names });
        }
        const files = namespaceStore(watched);
        const counts = namespaceNameCounts(watched);
        const identity = '1f:' + 'a'.repeat(64);
        const shown = ['alpha', 'beta', 'delta', 'epsilon', 'gamma'].map(name => '/shown/' + name + '.txt');
        this.ctx.storage.transactionSync(() => {
          sql.exec("INSERT INTO namespace_files (identity, byte_length, media_type, origin, key, part_bytes, stored_at, checked_at) VALUES (?, 10, 'text/plain', 'small', 'k', 10, 'now', 'now')", identity);
          const put = (name, collection) => sql.exec("INSERT INTO namespace_names (name, collection, identity, byte_length, named_at) VALUES (?, ?, ?, 10, 'now')", name, collection, identity);
          for (const name of shown) put(name, '/shown');
          for (let n = 0; n < duplicateNames; n++) put('/elsewhere/name-' + n + '.txt', '/elsewhere');
        });
        let pages = 0;
        while (!counts.ready()) {
          if (++pages > 50) throw new Error('Migration did not finish');
          this.ctx.storage.transactionSync(() => counts.fillStep.step());
        }
        reads = 0;
        watched.exec('SELECT identity, COUNT(*) AS names FROM namespace_names WHERE identity IN (SELECT value FROM json_each(?)) GROUP BY identity', JSON.stringify([identity]));
        const old_count_rows_read = reads;
        reads = 0;
        const listing = files.listNames('/shown', '', 5);
        return Response.json({ rows_read: reads, old_count_rows_read, listing });
      }
    }
    export default { fetch(request, env) { return env.PROBE.get(env.PROBE.idFromName(new URL(request.url).search)).fetch(request); } };
  `;
  const runtime = new Miniflare({ telemetry: { enabled: false }, workers: [{ config: {
    name: 'namespace-name-count-seek-test', compatibilityDate: '2026-09-01',
    manifest: { mainModule: 'worker.mjs', modules: {
      'worker.mjs': { type: 'esm', contents: script },
      'namespace.mjs': { type: 'esm', contents: bundled.outputFiles[0].text },
    } },
    env: { PROBE: { type: 'durable-object', worker: 'namespace-name-count-seek-test', exportName: 'Probe' } },
    exports: { Probe: { type: 'durable-object', storage: 'sqlite' } },
  } }] });
  try {
    const costs = [], oldCounts = [];
    for (const duplicateNames of [100, 10000]) {
      const response = await runtime.dispatchFetch('http://localhost/?duplicates=' + duplicateNames);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.listing.next_after, null);
      assert.equal(result.listing.names.length, 5);
      assert.ok(result.listing.names.every(row => row.also_named === duplicateNames + 4), 'exact duplicate counts survive the summary');
      assert.ok(result.listing.names.every(row => row.also_at.length === 3), 'bounded other-name locations remain available');
      costs.push(result.rows_read);
      oldCounts.push(result.old_count_rows_read);
    }
    console.log('warm namespace listNames Workerd rows read', costs);
    console.log('old duplicate COUNT Workerd rows read', oldCounts);
    assert.ok(oldCounts[1] > oldCounts[0] * 50, 'the old aggregate actually walks duplicate names');
    assert.ok(costs[0] > 0 && costs[0] < 256, 'real cursors expose bounded nonzero reads');
    assert.equal(costs[1], costs[0], 'full warm listings stay flat as duplicate names increase 100-fold');
    const pending = [];
    for (const duplicateNames of [100, 10000]) {
      const response = await runtime.dispatchFetch('http://localhost/?pending=1&duplicates=' + duplicateNames);
      assert.equal(response.status, 200);
      const sample = await response.json();
      assert.equal(sample.prefix_count, 1);
      pending.push(sample.rows_read);
    }
    console.log('pending-prefix mutation Workerd rows read', pending);
    assert.ok(pending[0] < 32, 'prefix existence is a bounded indexed seek');
    assert.equal(pending[1], pending[0], 'future duplicates cannot amplify mutation work while filling');
  } finally { await runtime.dispose(); }
});
