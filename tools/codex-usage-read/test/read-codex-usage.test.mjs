import assert from 'node:assert/strict';
import test from 'node:test';
import { limitRowsOf } from '../read-data/codex-limits.mjs';
import { readCodexUsage } from '../read-data/read-codex-usage.mjs';

const reply = { accounts: [
  { accountId: 'b-id', status: 'active', resetAtSecondary: '2026-11-24T16:11:22Z', usage: { secondaryRemainingPercent: 98 } },
  { accountId: 'a-id', status: 'active', resetAtSecondary: '2026-11-24T16:09:58Z', usage: { secondaryRemainingPercent: 99 } },
  { accountId: 'c-id', status: 'paused', resetAtSecondary: null, usage: {} },
] };

test('rows are named by account order, percent used, reset time, and carry no id or email', () => {
  const rows = limitRowsOf(reply, '2026-11-21T21:00:00.000Z');
  assert.deepEqual(rows.map(row => [row.account, row.used_percent, row.state]), [
    ['codex-lb account 1', 1, 'ok'], ['codex-lb account 2', 2, 'ok'], ['codex-lb account 3', null, 'unknown'],
  ]);
  assert.equal(JSON.stringify(rows).includes('-id'), false);
});

test('no reported door means no read, said in words', async () => {
  assert.match((await readCodexUsage({ local_ports: {} })).error, /does not report a codex-lb door/);
});
