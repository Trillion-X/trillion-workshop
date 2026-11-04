import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { changesAfter } from '../../record-log/do-work/record-sync.mjs';

// Observe the actual eager SQLite host and JSON decoder, rather than a store-shaped stub that already bounds reads.
function observed(host, run) {
  const exec = host.sql.exec;
  const parse = JSON.parse;
  const read = { physical_rows: 0, physical_chars: 0, transactions_parsed: 0, transaction_chars: 0 };
  host.sql.exec = (query, ...params) => {
    const result = exec(query, ...params);
    if (/^SELECT rowid AS n, id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM record_log/.test(query)) {
      for (const row of result.toArray()) { read.physical_rows += 1; read.physical_chars += row.envelopes.length; }
    }
    return result;
  };
  JSON.parse = (text, ...args) => {
    if (typeof text === 'string' && text.startsWith('[{') && text.includes('"type":"message"')) {
      read.transactions_parsed += 1;
      read.transaction_chars += text.length;
    }
    return parse(text, ...args);
  };
  try { return { answer: run(), read }; }
  finally { host.sql.exec = exec; JSON.parse = parse; }
}

const write = (store, n, size = 65_536, context = {}) => store.write([{ id: `note:${String(n).padStart(4, '0')}`, type: 'message', value: { text: 'x'.repeat(size) } }], context);

test('a cold outbound response reads one transaction at N and 4N instead of decoding a discarded batch', t => {
  for (const facade of [false, true]) {
    const results = [];
    for (const count of [16, 64]) {
      const host = sqliteHost(':memory:');
      const options = { transaction: host.transaction };
      let store = facade ? openRecords(host.sql, options) : recordLogStore(host.sql, options);
      for (let n = 0; n < count; n += 1) write(store, n);
      store.checkpoint();
      store = facade ? openRecords(host.sql, options) : recordLogStore(host.sql, options);
      const { answer, read } = observed(host, () => changesAfter(store, null, { most_rows: 200, chars: 1024 }));
      assert.equal(answer.rows_read, 1);
      assert.equal(answer.rows.length, 1);
      assert.equal(answer.rows[0].envelopes[0].id, 'note:0000');
      assert.equal(answer.more, true);
      assert.equal(read.physical_rows, 1, `${count} stored transactions, facade=${facade}`);
      assert.equal(read.transactions_parsed, 1);
      assert.equal(read.physical_chars, read.transaction_chars);
      results.push(read);
      t.diagnostic(JSON.stringify({ input_transactions: count, facade, response_chars: 1024, ...read }));
      host.db.close();
    }
    assert.deepEqual(results[0], results[1], 'the untouched tail does not enlarge physical reads or parsing');
  }
});

test('multipart transactions stay whole and a budget stop resumes after all of their parts', () => {
  const host = sqliteHost(':memory:');
  let store = recordLogStore(host.sql, { transaction: host.transaction });
  store.write(['left', 'right'].map(id => ({ id, type: 'message', value: { text: id.repeat(110_000) } })));
  store.sealLog();
  write(store, 1, 10);
  store.checkpoint();
  store = recordLogStore(host.sql, { transaction: host.transaction });
  const first = observed(host, () => changesAfter(store, null, { chars: 1024 }));
  assert.equal(first.answer.rows_read, 1);
  assert.deepEqual(first.answer.rows[0].envelopes.map(row => row.id), ['left', 'right']);
  assert.equal(first.read.physical_rows, 2);
  assert.equal(first.read.transactions_parsed, 1);
  assert.equal(first.answer.more, true);
  const second = observed(host, () => changesAfter(store, first.answer.last, { chars: 1024 }));
  assert.equal(second.answer.rows_read, 1);
  assert.equal(second.answer.rows[0].envelopes[0].id, 'note:0001');
  assert.equal(second.read.physical_rows, 1);
  assert.equal(second.answer.more, false);
  assert.equal(changesAfter(store, second.answer.last).rows_read, 0);
  host.db.close();
});

test('small transactions use bounded read-ahead without reading beyond a filled logical row limit', t => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction });
  for (let n = 0; n < 256; n += 1) write(store, n, 80);
  store.checkpoint();
  let batches = 0;
  const exec = host.sql.exec;
  host.sql.exec = (query, ...params) => {
    if (/^SELECT rowid AS n, id, transaction_id/.test(query)) batches += 1;
    return exec(query, ...params);
  };
  try {
    const result = observed(host, () => changesAfter(store, null, { most_rows: 200, chars: 4_000_000 }));
    assert.equal(result.answer.rows_read, 200);
    assert.equal(result.answer.more, true);
    assert.equal(result.read.transactions_parsed, 200);
    assert.equal(result.read.physical_rows, 200, 'the raw read-ahead stays inside the logical row limit too');
    assert.ok(batches < 40, `${batches} SQL payload batches for 200 small transactions`);
    t.diagnostic(JSON.stringify({ logical_rows: 200, physical_rows: result.read.physical_rows, payload_sql_batches: batches }));
    const remaining = changesAfter(store, result.answer.last, { most_rows: 200, chars: 4_000_000 });
    assert.equal(remaining.rows_read, 56);
    assert.equal(remaining.more, false);
  } finally { host.sql.exec = exec; host.db.close(); }
});

test('skipped rows still move the cursor and row limits retain their page-boundary semantics', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction });
  for (let n = 0; n < 4; n += 1) write(store, n, 2000, { actor: { from_copy: n < 2 ? 'phone' : 'other' } });
  const leave_out = row => row.actor?.from_copy === 'phone';
  const first = observed(host, () => changesAfter(store, null, { most_rows: 200, chars: 1024, leave_out }));
  assert.equal(first.answer.rows_read, 3);
  assert.equal(first.answer.rows[0].envelopes[0].id, 'note:0002');
  assert.equal(first.read.physical_rows, 3);
  assert.equal(first.read.transactions_parsed, 3);
  assert.equal(first.answer.more, true);
  const second = changesAfter(store, first.answer.last, { most_rows: 1, chars: 1024, leave_out });
  assert.equal(second.rows_read, 1);
  assert.equal(second.rows[0].envelopes[0].id, 'note:0003');
  assert.equal(second.more, true, 'filling the requested row count keeps the legacy possibly-more flag');
  const done = changesAfter(store, second.last, { most_rows: 1, leave_out });
  assert.equal(done.more, false);
  assert.equal(done.last, second.last);
  const skipAll = changesAfter(store, null, { most_rows: 200, chars: 1024, leave_out: () => true });
  assert.equal(skipAll.rows_read, 4);
  assert.equal(skipAll.last, second.last);
  assert.deepEqual(skipAll.rows, []);
  assert.equal(skipAll.more, false);
  host.db.close();
});

test('the array log API stays compatible and a lazy read failure leaves the transaction retryable', () => {
  const host = sqliteHost(':memory:');
  const store = recordLogStore(host.sql, { transaction: host.transaction });
  write(store, 0, 600_000);
  write(store, 1, 30);
  const page = store.logAfter(null, { limit: 1 });
  assert.ok(Array.isArray(page.rows));
  assert.deepEqual(Object.keys(page).sort(), ['last', 'oldest', 'rows']);
  assert.equal(page.last, page.rows[0].id);
  assert.deepEqual(store.logAfter(null, { limit: 0 }), { rows: [], oldest: page.oldest, last: null });
  const lazy = store.logAfter(null, { limit: 1, lazy: true });
  assert.equal(lazy.last, null);
  assert.deepEqual([...lazy.rows], page.rows);
  assert.equal(lazy.last, page.last);
  assert.equal(lazy.more, true);

  const exec = host.sql.exec;
  let parts = 0;
  host.sql.exec = (query, ...params) => {
    if (/^SELECT rowid AS n, id, transaction_id/.test(query) && ++parts === 2) throw new Error('read interrupted');
    return exec(query, ...params);
  };
  const interrupted = store.logAfter(null, { lazy: true });
  try { assert.throws(() => interrupted.rows.next(), /read interrupted/); }
  finally { host.sql.exec = exec; }
  assert.equal(interrupted.last, null, 'only a completed transaction advances the cursor');
  assert.deepEqual([...store.logAfter(null, { limit: 1, lazy: true }).rows], page.rows);

  const arrayOnly = { logAfter: (position, { limit }) => store.logAfter(position, { limit }) };
  assert.deepEqual(changesAfter(arrayOnly, null, { chars: 1024 }), changesAfter(store, null, { chars: 1024 }), 'older array-only stores retain sync compatibility');
  const root = store.checksum().root;
  const reopened = recordLogStore(host.sql, { transaction: host.transaction });
  assert.equal(reopened.checksum().root, root);
  assert.deepEqual(reopened.read('note:0000'), { text: 'x'.repeat(600_000) });
  host.db.close();
});
