// test/supervised-run.test.mjs
//
// Heavy automation runs as a supervised process of its own (computer/supervised-run.mjs: F-0521): wall clock with a
// two-step stop, output kept bounded, and the Mac held awake by a REAL caffeinate tied to the process for exactly its life.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runSupervised, supervisedSettings } from '../supervised-run.mjs';

const settings = supervisedSettings();
const node = process.execPath;
const caffeinatePids = () => { try { return execFileSync('/usr/bin/pgrep', ['-x', 'caffeinate'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };

test('a heavy run is held awake by caffeinate for exactly the life of its process, and the helper is gone when it ends', { skip: process.platform !== 'darwin' }, async () => {
  const before = new Set(caffeinatePids());
  let during = [];
  const answer = await runSupervised({ argv: [node, '-e', "setTimeout(() => console.log('done'), 700)"], class: 'heavy', onStart: () => { setTimeout(() => { during = caffeinatePids().filter(pid => !before.has(pid)); }, 300); } });
  assert.equal(answer.code, 0);
  assert.equal(answer.stdout.trim(), 'done');
  assert.equal(answer.kept_awake, true);
  assert.equal(during.length, 1, `one new caffeinate while the process lived: ${during}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(caffeinatePids().filter(pid => !before.has(pid)), [], 'and none after it');
});

test('a light run holds nothing awake; a run past its wall clock is stopped (TERM, then KILL) and says so', async () => {
  const quiet = await runSupervised({ argv: [node, '-e', "console.log('hi')"], class: 'light' });
  assert.equal(quiet.kept_awake, false);
  const custom = { ...settings, classes: { ...settings.classes, quick: { timeout_ms: 300, prevent_sleep: false, output_bytes: 1000, stop_grace_ms: 200 } } };
  const stuck = await runSupervised({ argv: [node, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], class: 'quick', settings: custom });
  assert.equal(stuck.timed_out, true);
  assert.equal(stuck.signal, 'SIGKILL');
  assert.match(stuck.said, /stopped after 300 ms/);
});

test('output is bounded to its tail, argv must be an array, an unknown class is refused and a missing program says why', async () => {
  const custom = { ...settings, classes: { ...settings.classes, small: { timeout_ms: 20000, prevent_sleep: false, output_bytes: 50, stop_grace_ms: 200 } } };
  const flood = await runSupervised({ argv: [node, '-e', "for (let i = 0; i < 2000; i += 1) process.stdout.write('line ' + i + '\\n')"], class: 'small', settings: custom });
  assert.equal(flood.cut, true);
  assert.ok(flood.stdout.length <= 50);
  assert.match(flood.stdout, /line 1999/);
  await assert.rejects(runSupervised({ argv: 'sh -c ls' }), error => error.status === 400 && error.retry === false);
  await assert.rejects(runSupervised({ argv: [node], class: 'enormous' }), /no supervised class named enormous/);
  await assert.rejects(runSupervised({ argv: ['/nonexistent/program'], class: 'light' }), /could not be started/);
});
