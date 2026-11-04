import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { keptRuns } from '../parts/record-log/do-work/kept-runs.mjs';

function seed(host, extra = {}) {
  const options = { transaction: host.transaction, prefix: 'stream_boot', max_runs: 8, fan_in: 4,
    filter_boot_bytes: 64, filter_bytes: 64 * 1024, ...extra };
  const space = keptRuns(host.sql, options);
  for (let n = 0; n < 48; n++) {
    space.put(`a${String(n).padStart(3, '0')}`, { n });
    space.put(`z${String(n).padStart(3, '0')}`, { n });
    space.flush();
  }
  return options;
}

function observeCatalog(host) {
  const exec = host.sql.exec.bind(host.sql), observed = { rows: 0, catalogRows: 0, metadataRows: 0, queries: [] };
  host.sql.exec = (query, ...params) => {
    observed.queries.push(query);
    const cursor = exec(query, ...params);
    if (!/^SELECT run(?:,| FROM) .*stream_boot_runs\b/.test(query)) return cursor;
    return { toArray() { throw Error('catalog result was materialized'); },
      *[Symbol.iterator]() { for (const row of cursor) {
        observed.rows++;
        if (query.startsWith('SELECT run,')) observed.catalogRows++;
        else observed.metadataRows++;
        yield row;
      } } };
  };
  return observed;
}

test('backlog boot streams its catalog with bounded metadata lookahead and keeps the total filter cap', t => {
  for (const filter_bytes of [64 * 1024, 64]) {
    const host = sqliteHost(':memory:'); t.after(() => host.db.close());
    const options = seed(host, { filter_bytes });
    const seen = observeCatalog(host), cold = keptRuns(host.sql, options);
    assert.equal(cold.held().runs.length, 48);
    assert.ok(seen.rows <= 48 + 9, 'opening examines at most one threshold-plus-one metadata prefix beyond the streamed catalog');
    assert.ok(cold.held().filter_bytes <= filter_bytes);
    assert.equal(cold.get('m-absent'), undefined);
    assert.deepEqual(cold.get('a005'), { n: 5 });
    const before = { rows: seen.rows, catalog: seen.catalogRows, metadata: seen.metadataRows, queries: seen.queries.length };
    cold.reloadCatalog();
    assert.equal(seen.catalogRows - before.catalog, 48, 'reload streams the complete catalog once');
    assert.equal(seen.metadataRows - before.metadata, 48, 'the existing reload membership sweep reads each run ID once');
    assert.equal(seen.rows - before.rows, 96, 'reload has only its existing membership sweep and one catalog stream');
    assert.ok(seen.queries.slice(before.queries).every(query => !/^SELECT run FROM .* LIMIT /.test(query)), 'reload adds no boot lookahead');
    assert.ok(cold.held().filter_bytes <= filter_bytes);
    assert.deepEqual(cold.get('z047'), { n: 47 });
    assert.ok(seen.queries.every(query => !/\bCOUNT\s*\(/i.test(query)), 'boot makes no full-table count');
  }
});

test('an infinite merge threshold keeps ordinary bounded boot admission with an iterator-only catalog', t => {
  const host = sqliteHost(':memory:'); t.after(() => host.db.close());
  const options = seed(host, { max_runs: Infinity });
  const seen = observeCatalog(host), cold = keptRuns(host.sql, options);
  assert.equal(seen.rows, 48);
  assert.equal(cold.held().runs.length, 48);
  assert.ok(cold.held().filter_bytes <= options.filter_boot_bytes);
  assert.equal(cold.get('m-absent'), undefined);
  assert.deepEqual(cold.get('a005'), { n: 5 });
});
