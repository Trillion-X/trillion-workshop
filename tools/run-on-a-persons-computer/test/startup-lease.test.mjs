// A startup phase that hangs is said and the helper leaves with the restart exit code; one that finishes, or keeps
// reporting progress inside its extensions, is left alone. Seconds, extensions and the code are DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStartupLeases } from '../startup-lease.mjs';
import { settingsOf } from '../mac-tools.mjs';

const clock = () => {
  const pending = new Map();
  let next = 1;
  return { pending, timers: { setTimeout: (run, ms) => { pending.set(next, { run, ms }); return next++; }, clearTimeout: id => pending.delete(id) } };
};

test('the shipped lease rows name the restart code and the phases', () => {
  const { startup_leases } = settingsOf();
  assert.equal(startup_leases.exit_code, 75);
  assert.deepEqual(Object.keys(startup_leases.phases), ['on_start', 'refresh']);
});

test('a phase that does not finish in its lease is said and expires with the code; a finished one leaves nothing', async () => {
  const { pending, timers } = clock();
  const said = [], expired = [];
  const { lease } = makeStartupLeases({ settings: { exit_code: 75, phases: { slow: { seconds: 30, extensions: 1 }, quick: { seconds: 30 } } }, expire: row => expired.push(row), log: row => said.push(row), timers });
  assert.equal(await lease('quick', async () => 'done'), 'done');
  assert.equal(pending.size, 0, 'a finished phase clears its lease');
  assert.equal(await lease('unlisted', async () => 'free'), 'free', 'a phase with no row has no lease');
  let renewed;
  const hung = lease('slow', async ({ renew }) => { renewed = [renew(), renew()]; return new Promise(() => {}); });
  await new Promise(done => setImmediate(done));
  assert.deepEqual(renewed, [true, false], 'one extension, then none');
  const [{ run, ms }] = pending.values();
  assert.equal(ms, 30_000);
  run();
  assert.deepEqual(expired, [{ phase: 'slow', exit_code: 75 }]);
  console.log('said', JSON.stringify(said[0]), 'expired', JSON.stringify(expired[0]));
  void hung;
});
