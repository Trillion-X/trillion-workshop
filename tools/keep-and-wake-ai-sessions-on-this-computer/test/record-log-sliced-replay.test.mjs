// A long uncovered log tail is rebuilt in slices (record-log-store replay, the host's replaySliceRows): each slice stops after a whole
// transaction and checkpoints once, the projection stays stale until a slice reaches the log's end, and the result is the one a full
// replay makes, sums and checksums included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const runs = { page_bytes: 1024, memtable_bytes: 1 << 24, big_bytes: 8192, cache_bytes: 8192, max_runs: 4, fan_in: 2, tail_rows: Infinity };
const row = (n, g) => ({ id: 'note:' + String(n).padStart(5, '0'), type: 'note', value: { g, words: 'w' + n } });

// Two databases holding one and the same log (the file is copied), so a sliced rebuild and a whole one are compared on identical rows.
function tailed(transactions) {
  const folder = mkdtempSync(join(tmpdir(), 'sliced-replay-'));
  const host = sqliteHost(join(folder, 'a.db'));
  const first = recordLogStore(host.sql, { transaction: host.transaction, runs });
  for (let t = 0; t < transactions; t += 1) first.write([row(t % 40, t), row(1000 + t, t)]);
  host.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(join(folder, 'a.db'), join(folder, 'b.db'));
  return { host, copy: sqliteHost(join(folder, 'b.db')) };
}
// The host an own-records book is: a rebuild is asked of it, and a slice that stopped short answers busy.
function sliced(host, rows, log) {
  const handle = Object.create(host.sql);
  handle.exec = host.sql.exec.bind(host.sql);
  handle.rebuild = work => { const result = work(); if (result?.more) { log.push(result); throw Object.assign(new Error('catching up'), { slice_progress: true }); } log.push(result); return result; };
  handle.replaySliceRows = () => rows;
  return handle;
}

test('a long tail becomes current over several slices, each checkpointed, and equals one full replay', () => {
  const { host, copy } = tailed(300);
  const log = [];
  const handle = sliced(host, 40, log);
  let opened = null, attempts = 0;
  while (!opened) {
    attempts += 1;
    assert.ok(attempts < 100, 'the tail is finished');
    try { opened = recordLogStore(handle, { transaction: host.transaction, runs }); } catch (error) { assert.equal(error.slice_progress, true); }
  }
  assert.ok(attempts > 3, `several slices (${attempts})`);
  const covered = log.map(r => r.covered);
  assert.deepEqual(covered, [...covered].sort((a, b) => a - b), 'covered only moves forward');
  assert.ok(log.slice(0, -1).every(r => r.more && r.tail_left > 0) && log.at(-1).more === false);
  const tails = log.map(r => r.tail_left);
  assert.deepEqual(tails, [...tails].sort((a, b) => b - a), 'the tail only shrinks');
  const whole = recordLogStore(copy.sql, { transaction: copy.transaction, runs });
  const ids = store => store.ids('note', { limit: 200 });
  assert.deepEqual(ids(opened), ids(whole));
  assert.equal(JSON.stringify(opened.read('note:01100')), JSON.stringify(whole.read('note:01100')));
  assert.ok(opened.checksum().root, 'a checksum is made');
  assert.deepEqual(opened.checksum(), whole.checksum());
  assert.deepEqual([...opened.countMany(['note'])], [...whole.countMany(['note'])]);
  assert.deepEqual([...opened.countMany(['note'])], [['note', 340]]);
});

test('a slice stops only after a whole transaction', () => {
  const { host } = tailed(50);
  const log = [];
  try { recordLogStore(sliced(host, 1, log), { transaction: host.transaction, runs }); } catch (error) { assert.equal(error.slice_progress, true); }
  assert.equal(log.length, 1);
  assert.ok(log[0].covered >= 1 && log[0].more);
});
