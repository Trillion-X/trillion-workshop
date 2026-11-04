// test/program-host-degrade.test.mjs
// A program the Mac host cannot keep up is restarted a bounded number of times and then left stopped and reported
// degraded (computer/program-host.mjs, program_host.quick_failures_before_degrade in computer/mac-tools.json); a run
// that lasts resets the count; the next look at the account that the account answered gives it a fresh start; a
// program with no limit in its recipe or in program_host is restarted without end, as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { settingsOf } from '../mac-tools.mjs';
import { makeProgramHost } from '../program-host.mjs';

const base = settingsOf();
const follow = ids => ({ id: 'marketplace-install:private:trillion-your-computer', configuration_id: 'trillion-your-computer', context: 'private',
  follows: 'trillion-your-computer', components: ids.map(id => ({ kind: 'tool', id, version: '1f:x' })) });

function rig(limit) {
  const settings = structuredClone(base);
  if (limit === undefined) {
    delete settings.program_host.quick_failures_before_degrade;
    // The recipe's own restart budget (restart_seconds.budget) is a second bound with its own test; this one is about the first.
    delete settings.programs.connections.restart_seconds.budget;
  } else settings.program_host.quick_failures_before_degrade = limit;
  const started = [], logs = [], pending = [];
  let clock = 0;
  const spawn = () => { const child = new EventEmitter(); child.stdin = { on() {}, end() {} }; child.kill = () => true; started.push(child); return child; };
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'program-degrade-'));
  const host = makeProgramHost({ settings, key: 'k', file: path.join(home, 'installed.json'), spawn,
    call: async () => ({ installations: [follow(['tool:carry-connections'])] }),
    timers: { setTimeout: run => { pending.push(run); return pending.length; }, clearTimeout() {} }, now: () => clock, log: row => logs.push(row) });
  const crash = (seconds = 1) => { clock += seconds * 1000; started.at(-1).emit('exit', 1); };
  return { host, started, logs, pending, crash, steady: settings.programs.connections.restart_seconds.steady_seconds, home };
}

test('after the limit of quick failures the program is left stopped and reported degraded', async () => {
  const r = rig(3);
  await r.host.reconcile();
  for (let round = 0; round < 2; round += 1) { r.crash(); r.pending.shift()(); }
  assert.equal(r.started.length, 3, 'restarted after each of the first two quick failures');
  assert.equal(r.host.status('connections').degraded, false);
  r.crash();
  assert.equal(r.pending.length, 0, 'no further restart is scheduled');
  assert.equal(r.host.status('connections').degraded, true);
  assert.deepEqual(r.logs.filter(row => row.program_degraded), [{ program_degraded: 'connections', quick_failures: 3 }]);
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('a run that lasted resets the count, and the next answered look at the account gives a degraded program a fresh start', async () => {
  const r = rig(2);
  await r.host.reconcile();
  r.crash(); r.pending.shift()();
  r.crash(r.steady + 1); r.pending.shift()();
  r.crash();
  assert.equal(r.host.status('connections').degraded, false, 'one quick failure after a long run is not two in a row');
  r.pending.shift()();
  r.crash();
  assert.equal(r.host.status('connections').degraded, true);
  const before = r.started.length;
  await r.host.reconcile();
  assert.equal(r.started.length, before + 1, 'a fresh look at the account starts it again');
  assert.equal(r.host.status('connections').degraded, false);
  await r.host.stop();
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('with no limit in the data a program is restarted without end', async () => {
  const r = rig(undefined);
  await r.host.reconcile();
  for (let round = 0; round < 40; round += 1) { r.crash(); r.pending.shift()(); }
  assert.equal(r.started.length, 41);
  assert.equal(r.host.status('connections').degraded, false);
  await r.host.stop();
  fs.rmSync(r.home, { recursive: true, force: true });
});

test('the shipped data bounds restarts', () => {
  assert.ok(Number.isInteger(base.program_host.quick_failures_before_degrade) && base.program_host.quick_failures_before_degrade > 0);
});
