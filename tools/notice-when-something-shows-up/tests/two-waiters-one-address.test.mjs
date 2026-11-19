// tools/notice-when-something-shows-up: two waiters that emit at one address keep their state apart across a restart.
//
// Every service-list and row-change waiter emits at where::something-changed. Kept by address alone, a booking list's
// waiter and a database's row-change waiter shared one kept file, so a restarted booking waiter took the other's state
// as all it had seen and never told the bookings made while it was down (two real TidyCal bookings, Nov 19 2026).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { engineCarrier } from '../do-work/tell-the-engine.mjs';

const door = { url: 'http://door.test/mcp', capability: 'c' };
const fetchImpl = async () => new Response(JSON.stringify({ result: { structuredContent: { kept: true } } }), { status: 200 });
const carrier = keep => engineCarrier({ door, waiters: [], fetchImpl, say: () => {}, keep });
const AT = 'where::something-changed';

test('a waiter reads back only its own state, after a restart, when another waiter keeps state at the same address', async () => {
  const keep = mkdtempSync(path.join(tmpdir(), 'noticer-kept-'));
  const first = carrier(keep);
  await first.keepState(AT, { seen: { 101: 'a' } }, 'waiter:bookings');
  await first.keepState(AT, { cursor: 7 }, 'waiter:row-changes');
  await first.writeRecord({ addressLabel: AT, waiterRef: 'waiter:bookings', payload: { kind: 'something-changed', key: '102' }, eventKey: 'b:102', state: { seen: { 101: 'a', 102: 'b' } } });
  const restarted = carrier(keep);
  assert.deepEqual((await restarted.readCurrent(AT, 'waiter:bookings')).state, { seen: { 101: 'a', 102: 'b' } });
  assert.deepEqual((await restarted.readCurrent(AT, 'waiter:row-changes')).state, { cursor: 7 });
});

test('a carrier asked without a waiter keeps by address alone, as before', async () => {
  const keep = mkdtempSync(path.join(tmpdir(), 'noticer-kept-'));
  await carrier(keep).keepState('clock::due', { first_seen_ms: 1 });
  assert.deepEqual((await carrier(keep).readCurrent('clock::due')).state, { first_seen_ms: 1 });
  assert.equal(await carrier(keep).readCurrent('clock::due', 'waiter:other'), null);
});
