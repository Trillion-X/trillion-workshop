import test from 'node:test';
import assert from 'node:assert/strict';
import * as handsFree from '../read-data/hands-free.mjs';
import * as handsFreeCore from '../read-data/hands-free-core.mjs';
import * as voiceSession from '../read-data/voice-session.mjs';
import * as voiceSessionCore from '../read-data/voice-session-core.mjs';
import { roleHolder, turnsAfter, waitForHearing } from '../read-data/what-was-said.mjs';

test('compatibility entries forward every existing helper binding to the one source core', () => {
  for (const [entry, core] of [[handsFree, handsFreeCore], [voiceSession, voiceSessionCore]]) {
    assert.deepEqual(Object.keys(entry), Object.keys(core));
    for (const name of Object.keys(core)) assert.equal(entry[name], core[name], name);
  }
});

test('record-role adaptation preserves strict expiry and refuses an unreadable expiry', () => {
  const at = Date.parse('2026-10-17T12:00:00Z');
  const held = { device: 'one', until: new Date(at + 1000).toISOString() };
  assert.equal(roleHolder(held, at + 999.5), 'one');
  assert.equal(roleHolder(held, at + 1000), null);
  assert.equal(roleHolder(held, at + 1001), null);
  assert.equal(roleHolder(held, String(at + 1000)), null);
  assert.equal(roleHolder(held, Number.NaN), null);
  assert.equal(roleHolder({ ...held, until: 'not a date' }, at), null);
  assert.equal(roleHolder({ until: held.until }, at), null);
});

test('the row-door wait refreshes asynchronous status and stops at its exact caller bound', async () => {
  let clock = 100_000;
  let reads = 0;
  const sleeps = [];
  const door = { async read() {
    reads += 1;
    return { hearing_pending: true, heard_until: null, heartbeat_ms: clock };
  } };
  const result = await waitForHearing(door, 'one', {
    askedAt: clock, waitMs: 125, now: () => clock,
    sleep: async milliseconds => { sleeps.push(milliseconds); clock += milliseconds; },
  });
  assert.equal(result.flushed, false);
  assert.equal(result.live, true);
  assert.equal(result.waited_ms, 125);
  assert.deepEqual(sleeps, [125]);
  assert.equal(reads, 2);
});

test('the original sequence filter returns only later turns and keeps their row identities', () => {
  const rows = [100, 200, 300].map(milliseconds => ({ id: `heard:one:${milliseconds}`, value: {} }));
  const fresh = turnsAfter(rows, { after_ms: 200 });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0], rows[2]);
  assert.deepEqual(turnsAfter(rows, { after_ms: 300 }), []);
});
