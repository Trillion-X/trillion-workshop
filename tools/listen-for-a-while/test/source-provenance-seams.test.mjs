import test from 'node:test';
import assert from 'node:assert/strict';
import * as handsFree from '../read-data/hands-free.mjs';
import * as handsFreeCore from '../read-data/hands-free-core.mjs';
import * as voiceSession from '../read-data/voice-session.mjs';
import * as voiceSessionCore from '../read-data/voice-session-core.mjs';
import { roleHolder, turnsAfter } from '../read-data/what-was-said.mjs';

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

test('the original sequence filter returns only later turns and keeps their row identities', () => {
  const rows = [100, 200, 300].map(milliseconds => ({ id: `heard:one:${milliseconds}`, value: {} }));
  const fresh = turnsAfter(rows, 200);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0], rows[2]);
  assert.deepEqual(turnsAfter(rows, 300), []);
});
