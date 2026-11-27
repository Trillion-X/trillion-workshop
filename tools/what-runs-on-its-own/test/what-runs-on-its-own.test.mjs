// What runs on its own: each cause's state from its wake:list row, red for the ones that should have run and did not,
// the state-and-step graph (every state reachable, at most 20 arrows), and the row's sample run as the tool container
// runs it. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seeWhatRunsOnItsOwn } from '../do-work/what-runs-on-its-own.mjs';

const folder = resolve(import.meta.dirname, '..');
const states = JSON.parse(readFileSync(resolve(folder, 'read-data/states.json'), 'utf8'));
const NOW = 1_800_000_000_000;
const daily = { kind: 'due-time', from: ['run'], watch: { schedules: [{ cadence: { unit: 'day' }, local_window: { start: '14:00', duration_minutes: 1 }, timezone: 'UTC' }] } };
const wake = (id, on, switched_on, mark = {}) => ({ tool: 'tool:sample', id, on, budget: { steps: 1 }, switched_on, mark });
const one = row => seeWhatRunsOnItsOwn({ wakes: [row] }).causes[0];

test('a fact wake says what it hears, and a due time says its schedule', () => {
  assert.equal(one(wake('daily', { fact: daily }, true)).waits_for, 'every day at 14:00 UTC');
  const weekly = { ...daily, watch: { schedules: [{ cadence: { unit: 'week', weekdays: [1] }, local_window: { start: '09:00' }, timezone: 'UTC' }] } };
  assert.equal(one(wake('weekly', { fact: weekly }, true)).waits_for, 'every week on Monday at 09:00 UTC');
  const added = one(wake('added', { fact: { kind: 'something-changed', from: ['run'], match: { place: 'launch', change: 'added' } } }, true));
  assert.equal(added.waits_for, 'when run tells something-changed (place launch, change added)');
  assert.equal(one(wake('keep', { running: {} }, true, { running: 'k' })).waits_for, 'kept running, started again if it stops');
});

test('a switched-on fact wake that has heard nothing yet is on, not red: it has no mark until its first fact', () => {
  const cause = one(wake('daily', { fact: daily }, true));
  assert.deepEqual([cause.state, cause.red, cause.last_run_ms], ['on', false, null]);
  assert.deepEqual(cause.switch, { tool: 'tool:sample', id: 'daily', on: true, turn: 'off', label: 'Turn off' });
});

test('a cause that should have run and did not is red, and says why', () => {
  const failed = one(wake('daily', { fact: daily }, true, { outcome: 'failed', outcome_cause: 'tool_runner.rs:264 declaration_changed_switch_on_again', ran_ms: NOW }));
  assert.deepEqual([failed.state, failed.red, failed.last_run_ms], ['failed', true, NOW]);
  assert.match(failed.why, /declaration_changed_switch_on_again/);
  assert.equal(one(wake('daily', { fact: daily }, true, { outcome: 'unknown' })).state, 'unknown');
  const unfunded = one(wake('daily', { fact: daily }, true, { unfunded_ms: NOW }));
  assert.deepEqual([unfunded.state, unfunded.red, unfunded.label], ['unfunded', true, 'Came with no budget left']);
  const unstarted = one(wake('keep', { running: {} }, true, { on: true }));
  assert.deepEqual([unstarted.state, unstarted.red, unstarted.label], ['unplaced', true, 'Not picked up yet']);
});

test('off wins over everything and shows the switch to turn it on; a fired cause not yet ran shows as running', () => {
  const off = one(wake('daily', { fact: daily }, false, { outcome: 'failed' }));
  assert.deepEqual([off.state, off.red, off.also, off.switch.turn, off.switch.label], ['off', false, [], 'on', 'Turn on']);
  assert.equal(one(wake('daily', { fact: daily }, true, { fired_ms: NOW, ran_ms: NOW - 1 })).state, 'running');
  assert.equal(one(wake('keep', { running: {} }, true, { running: 'k', fired_ms: NOW, ran_ms: NOW })).state, 'running');
});

test('red causes come first, then switched-on ones, with counts', () => {
  const all = seeWhatRunsOnItsOwn({ wakes: [
    wake('quiet', { fact: daily }, false), wake('daily', { fact: daily }, true), wake('broken', { fact: daily }, true, { outcome: 'failed' }),
  ] });
  assert.deepEqual(all.causes.map(cause => cause.id), ['broken', 'daily', 'quiet']);
  assert.deepEqual([all.red, all.on, all.off], [1, 2, 1]);
  assert.throws(() => seeWhatRunsOnItsOwn({}), /wakes/);
});

test('the state-and-step graph: every state is reachable from a new wake and has a way out, in at most 20 arrows', () => {
  const names = Object.keys(states.states);
  assert.deepEqual([...states.order].sort(), [...names].sort());
  assert.ok(states.steps.length <= 20, `${states.steps.length} arrows`);
  for (const step of states.steps) assert.ok(names.includes(step.from) && names.includes(step.to), JSON.stringify(step));
  const reached = new Set(['unplaced']);
  for (let grew = true; grew;) {
    grew = false;
    for (const step of states.steps) if (reached.has(step.from) && !reached.has(step.to)) { reached.add(step.to); grew = true; }
  }
  assert.deepEqual([...reached].sort(), [...names].sort());
  for (const name of names) assert.ok(states.steps.some(step => step.from === name), `${name} has a way out`);
});

const rows = JSON.parse(readFileSync(resolve(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);
const run = (argv, input) => spawnSync(process.execPath, argv, { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, () => {
    for (const sample of row.verify.filter(item => item.kind === 'sample-run')) {
      const ran = run(row.invoke.run.slice(1), sample.input);
      assert.equal(ran.status, 0, ran.stderr);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}
