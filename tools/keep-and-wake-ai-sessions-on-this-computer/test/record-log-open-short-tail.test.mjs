// A store opened over a short uncovered log tail replays it in the opening call (the host's openReplayRows) instead of asking the
// host's upkeep, so the first call after an eviction is not answered "catching up"; a longer tail is still left to the upkeep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';

const runs = { page_bytes: 1024, memtable_bytes: 1 << 24, big_bytes: 8192, cache_bytes: 8192, max_runs: 4, fan_in: 2, tail_rows: Infinity };
const row = n => ({ id: 'note:' + String(n).padStart(5, '0'), type: 'note', value: { words: 'w' + n } });

function opened(transactions, openReplayRows) {
  const host = sqliteHost(join(mkdtempSync(join(tmpdir(), 'open-tail-')), 'a.db'));
  const first = recordLogStore(host.sql, { transaction: host.transaction, runs });
  for (let t = 0; t < transactions; t += 1) first.write([row(t)]);
  const asked = [];
  const handle = Object.create(host.sql);
  handle.exec = host.sql.exec.bind(host.sql);
  handle.rebuild = work => { asked.push('host'); return work(); };
  handle.openReplayRows = openReplayRows;
  const store = recordLogStore(handle, { transaction: host.transaction, runs });
  return { asked, store };
}

test('a tail within openReplayRows is replayed by the opening call, not asked of the host', () => {
  const { asked, store } = opened(5, 50);
  assert.deepEqual(asked, []);
  assert.equal(store.ids('note', { limit: 200 }).length, 5);
});

test('a tail past openReplayRows is left to the host, as before', () => {
  const { asked } = opened(120, 50);
  assert.deepEqual(asked, ['host']);
});

test('a host that names no openReplayRows is asked, as before', () => {
  const { asked } = opened(5, undefined);
  assert.deepEqual(asked, ['host']);
});
