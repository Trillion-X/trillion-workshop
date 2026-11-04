import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

test('logAfter finds a page in a large log using first and last ordered rowid seeks', () => {
  const host = sqliteHost(':memory:');
  const statements = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    statements.push(query);
    return exec(query, ...params);
  };
  const store = recordLogStore(host.sql, { transaction: host.transaction });
  const insert = host.db.prepare(`INSERT INTO record_log
    (id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes)
    VALUES (?, ?, '{}', '', '', 0, 1, '[]')`);
  host.transaction(() => {
    for (let n = 0; n < 100_000; n += 1) {
      const id = `zz${String(n).padStart(8, '0')}`;
      insert.run(id, id);
    }
  });

  const result = store.logAfter('aa', { limit: 2 });
  assert.deepEqual(result.rows.map(row => row.id), ['zz00000000', 'zz00000001']);

  const seeks = statements.filter(query => /^SELECT rowid FROM record_log ORDER BY rowid(?: DESC)? LIMIT 1$/i.test(query));
  assert.deepEqual(seeks, [
    'SELECT rowid FROM record_log ORDER BY rowid LIMIT 1',
    'SELECT rowid FROM record_log ORDER BY rowid DESC LIMIT 1',
  ]);
  const plans = seeks.map(query => host.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => row.detail).join(' '));
  assert.ok(plans.every(plan => !/USE TEMP B-TREE/i.test(plan)), plans.join('\n'));
  assert.ok(!statements.some(query => /SELECT min\(rowid\).*max\(rowid\)/i.test(query)));
  host.db.close();
});

test('a settle from a recent position passes over sealed logs that end before it without reading them', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction });
  for (let generation = 0; generation < 30; generation += 1) {
    for (let n = 0; n < 5; n += 1) store.write([{ id: `n${generation}-${n}`, type: 'note', value: { generation, n } }]);
    store.sealLog();
  }
  store.write([{ id: 'latest', type: 'note', value: { n: 1 } }]);
  const position = store.logAfter(null, { limit: 1000 }).last;
  store.write([{ id: 'after', type: 'note', value: { n: 2 } }]);
  store.logAfter(position, { limit: 10 });
  const statements = [];
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => { statements.push(query); return exec(query, ...params); };
  const result = store.logAfter(position, { limit: 10 });
  assert.deepEqual(result.rows.flatMap(row => row.envelopes.map(envelope => envelope.id)), ['after']);
  assert.ok(statements.length <= 8, `${statements.length} statements for one new row after 30 sealed logs`);
  host.db.close();
});
