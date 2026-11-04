import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords } from '../src/record-engine.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { recordFeedWriter, RECORD_CALL } from '../../shared-code/src/search-feed.mjs';

// The exact previous adapter: the storage/log owner is identical on both roads.
function eagerFeed(store, after, limit) {
  const page = store.logAfter(after, { limit });
  return { ids: [...new Set(page.rows.flatMap(row => row.envelopes.map(envelope => envelope.id)))],
    count: page.rows.length, oldest: page.oldest, last: page.last };
}

test('lazy feed preserves transaction count, ID order/dedup and the final consumed cursor', () => {
  const calls = [];
  let last = 'before';
  const store = { ids() {}, lastLogId() {}, logAfter(after, opts) {
    calls.push({ after, opts });
    return { oldest: 'oldest', get last() { return last; }, rows: (function* () {
      last = 'first'; yield { envelopes: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] };
      last = 'second'; yield { envelopes: [] };
      last = 'third'; yield { envelopes: [{ id: 'c' }, { id: 'a' }] };
    })() };
  } };
  const feed = recordFeedWriter(store);
  assert.equal(feed.available, true);
  assert.deepEqual(feed.logAfter('before', 20), { ids: ['b', 'a', 'c'], count: 3, oldest: 'oldest', last: 'third' });
  assert.deepEqual(calls, [{ after: 'before', opts: { limit: 20, lazy: true, buffer_chars: RECORD_CALL.bytes } }]);
});

test('array-only legacy facades and empty pages preserve the existing response shape and bounds', () => {
  const requested = [];
  const feed = recordFeedWriter({ logAfter(after, { limit }) {
    requested.push(limit);
    return { rows: [], oldest: 'oldest', last: after };
  } });
  for (const [limit, expected] of [[undefined, 1], [0, 1], [-8, 1], [2.8, 2], [999, RECORD_CALL.log], [Infinity, RECORD_CALL.log], ['4', 4], [NaN, 1]]) {
    assert.deepEqual(feed.logAfter('position', limit), { ids: [], count: 0, oldest: 'oldest', last: 'position' });
    assert.equal(requested.at(-1), expected);
  }
  assert.equal(feed.available, false, 'an older engine without the full log facade stays unavailable');
});

test('an interrupted lazy page fails alone and retries without retaining partial IDs', () => {
  let fail = true;
  const feed = recordFeedWriter({ logAfter(after) {
    let last = after;
    return { oldest: 'one', get last() { return last; }, rows: (function* () {
      last = 'one'; yield { envelopes: [{ id: 'a' }] };
      if (fail) throw Error('record log read interrupted');
      last = 'two'; yield { envelopes: [{ id: 'b' }] };
    })() };
  } });
  assert.throws(() => feed.logAfter(null, 2), /record log read interrupted/);
  fail = false;
  assert.deepEqual(feed.logAfter(null, 2), { ids: ['a', 'b'], count: 2, oldest: 'one', last: 'two' });
});

test('actual multipart/sealed logs, facade and array-only facade have equal resumable ID pages after reopen', () => {
  const host = sqliteHost(':memory:');
  try {
    let store = openRecords(host.sql, { transaction: host.transaction });
    store.write([{ id: 'left', type: 'message', value: { text: 'l'.repeat(600_000) } },
      { id: 'right', type: 'message', value: { text: 'r'.repeat(80) } }]);
    store.sealLog();
    store.write([{ id: 'left', type: 'message', value: { text: 'changed' } }]);
    store.write([{ id: 'last', type: 'message', value: { text: 'end' } }]);
    store.checkpoint();
    store = openRecords(host.sql, { transaction: host.transaction });
    const feed = recordFeedWriter(store);
    const legacy = recordFeedWriter({ logAfter: (after, { limit }) => store.logAfter(after, { limit }) });
    const first = feed.logAfter(null, 1);
    assert.deepEqual(first, eagerFeed(store, null, 1));
    assert.deepEqual(first, legacy.logAfter(null, 1));
    assert.equal(first.count, 1, 'physical parts count as one whole transaction');
    assert.deepEqual(first.ids, ['left', 'right']);
    const second = feed.logAfter(first.last, 200);
    assert.deepEqual(second, eagerFeed(store, first.last, 200));
    assert.deepEqual(second.ids, ['left', 'last']);
    assert.equal(second.count, 2);
    assert.deepEqual(feed.logAfter(null, 200).ids, ['left', 'right', 'last']);
    assert.deepEqual(feed.logAfter(second.last, 200), { ids: [], count: 0, oldest: first.oldest, last: second.last });
  } finally { host.db.close(); }
});

// Observe actual payload SELECTs and actual transaction decoding, then the
// adapter's first ID access. This proves eager preloading versus consumption
// interleaving; it does not claim a GC heap peak, a provider reset or live savings.
function observed(host, run) {
  const exec = host.sql.exec, parse = JSON.parse;
  const measured = { payload_sql_statements: 0, physical_rows: 0, physical_chars: 0, decoded: 0, decoded_chars: 0,
    decoded_before_first_id: null, peak_decoded_unvisited_transactions: 0 };
  let unvisited = 0;
  host.sql.exec = (query, ...params) => {
    const result = exec(query, ...params);
    if (/^SELECT rowid AS n, id, transaction_id, actor_context, application_time, system_time, part, parts, envelopes FROM record_log/.test(query)) {
      measured.payload_sql_statements += 1;
      for (const row of result.toArray()) { measured.physical_rows += 1; measured.physical_chars += row.envelopes.length; }
    }
    return result;
  };
  JSON.parse = (text, ...args) => {
    const value = parse(text, ...args);
    if (Array.isArray(value) && value.length && value[0]?.type === 'message' && typeof value[0].id === 'string') {
      measured.decoded += 1; measured.decoded_chars += text.length;
      unvisited += 1;
      measured.peak_decoded_unvisited_transactions = Math.max(measured.peak_decoded_unvisited_transactions, unvisited);
      const envelope = value[0], id = envelope.id;
      let visited = false;
      Object.defineProperty(envelope, 'id', { enumerable: true, configurable: true, get() {
        if (!visited) {
          measured.decoded_before_first_id ??= measured.decoded;
          unvisited -= 1; visited = true;
        }
        return id;
      } });
    }
    return value;
  };
  try { return { answer: run(), measured }; }
  finally { host.sql.exec = exec; JSON.parse = parse; }
}

test('actual large-payload log feeds consume one decoded transaction at a time instead of retaining the eager page', t => {
  for (const facade of [false, true]) for (const count of [16, 64, 256]) {
    const host = sqliteHost(':memory:');
    try {
      const make = () => facade ? openRecords(host.sql, { transaction: host.transaction }) : recordLogStore(host.sql, { transaction: host.transaction });
      let store = make();
      for (let n = 0; n < count; n++) store.write([{ id: `note:${n}`, type: 'message', value: { text: 'x'.repeat(65_536) } }]);
      store.checkpoint(); store = make(); store.lastLogId();
      // The eager owner's actual returned array owns the complete payload page.
      // The actual lazy owner returns an iterator, not an equivalent array.
      const retainedPayloadChars = (() => {
        const retained = store.logAfter(null, { limit: 200 });
        assert.ok(Array.isArray(retained.rows));
        assert.equal(retained.rows.length, Math.min(count, 200));
        return retained.rows.reduce((total, row) => total + JSON.stringify(row.envelopes).length, 0);
      })();
      assert.ok(retainedPayloadChars > Math.min(count, 200) * 65_536);
      assert.equal(Array.isArray(store.logAfter(null, { limit: 200, lazy: true }).rows), false);
      const before = observed(host, () => eagerFeed(store, null, 200));
      const after = observed(host, () => recordFeedWriter(store).logAfter(null, 200));
      assert.deepEqual(after.answer, before.answer);
      assert.equal(after.answer.count, Math.min(count, 200));
      assert.equal(before.measured.decoded, after.measured.decoded, 'every required transaction still decodes');
      assert.equal(after.measured.decoded_chars, before.measured.decoded_chars);
      assert.equal(before.measured.decoded_before_first_id, Math.min(count, 200));
      assert.equal(before.measured.peak_decoded_unvisited_transactions, Math.min(count, 200));
      assert.equal(after.measured.decoded_before_first_id, 1);
      assert.equal(after.measured.peak_decoded_unvisited_transactions, 1);
      assert.equal(after.measured.physical_rows, Math.min(count, 200));
      assert.ok(after.measured.physical_rows <= before.measured.physical_rows);
      if (count === 256) assert.ok(after.measured.physical_rows < before.measured.physical_rows, 'the filled 200-transaction page does not fetch the discarded physical tail');
      t.diagnostic(JSON.stringify({ facade, stored_transactions: count, retained_eager_payload_chars: retainedPayloadChars,
        before: before.measured, after: after.measured }));
    } finally { host.db.close(); }
  }
});
