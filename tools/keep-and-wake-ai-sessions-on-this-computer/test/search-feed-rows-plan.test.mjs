// test/search-feed-rows-plan.test.mjs
//
// searchFeedWriter.rows reads the named identities of a kind by the (identity, kind) primary key. Left to choose its join order, the planner
// scanned every result of the kind: 117,864 rows read for two identities of a kind of 39,000 on Sam Example's Namespace (2026-10-20), which failed
// every other Namespace evidence step against its admitted 40,000 rows. The statement now fixes the order (the named identities first), so
// the rows it reads follow the identities it names, not the size of the kind.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { searchFeedWriter } from '../../shared-code/src/search-feed.mjs';

const KIND_ROWS = 20_000;

function store() {
  const host = sqliteHost(':memory:');
  host.sql.exec('CREATE TABLE namespace_results (identity TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, produced_by TEXT, value_identity TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (identity, kind))');
  host.sql.exec('CREATE INDEX namespace_results_kind ON namespace_results (kind, identity)');
  host.sql.exec('CREATE INDEX namespace_results_kind_time ON namespace_results (kind, recorded_at)');
  host.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${KIND_ROWS - 1})
    INSERT INTO namespace_results SELECT printf('12:%08d', i), 'transcript', '{"text":"x","segments":[]}', 'test', printf('v%d', i), '2026-10-13T00:00:00Z' FROM n`);
  host.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 9999)
    INSERT INTO namespace_results SELECT printf('1f:%08d', i), 'facts', '{}', 'test', printf('f%d', i), '2026-10-13T00:00:00Z' FROM n`);
  return host;
}

test('rows reads the named identities by primary key, never the whole kind', () => {
  const host = store();
  const seen = [];
  const sql = { exec(query, ...params) { seen.push({ query, params }); return host.sql.exec(query, ...params); } };
  const ids = ['12:00000007', '12:00000011'];
  const answer = searchFeedWriter(sql).rows('transcript', ids, 500_000);
  assert.deepEqual(answer.rows.map(row => row.identity), ids);
  const statement = seen.findLast(entry => /ROW_NUMBER\(\) OVER/.test(entry.query));
  const plan = host.sql.exec(`EXPLAIN QUERY PLAN ${statement.query}`, ...statement.params).toArray().map(row => row.detail).join(' | ');
  // The local planner already picks the right order for this fixture; Cloudflare's picked the kind's index as the outer loop (measured on
  // Sam Example's book: 117,864 rows read, and 18 with the order fixed), so the fixed order is asserted in the statement itself as well.
  assert.match(statement.query, /FROM json_each\(\?\) AS j CROSS JOIN namespace_results AS r ON r\.identity = j\.value AND r\.kind = \?/, 'the named identities are the fixed outer loop');
  assert.doesNotMatch(plan, /SCAN r\b|SCAN namespace_results/, `the plan scans the kind: ${plan}`);
  assert.match(plan, /SCAN j VIRTUAL TABLE.*SEARCH r USING .*\((kind=\? AND identity=\?|identity=\? AND kind=\?)\)/, `the named identities are not the outer loop: ${plan}`);
});
