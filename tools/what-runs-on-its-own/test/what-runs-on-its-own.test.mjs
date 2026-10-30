// What runs on its own: each cause's state from the engine's wake book, red for the ones that should have run and
// did not, the engine's own key for a wake, the state-and-step graph (every state reachable, at most 20 arrows), and
// the row's sample run as the tool container runs it. Every value here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seeWhatRunsOnItsOwn, wakeKey } from '../do-work/what-runs-on-its-own.mjs';

const folder = resolve(import.meta.dirname, '..');
const states = JSON.parse(readFileSync(resolve(folder, 'read-data/states.json'), 'utf8'));
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const hourly = { tool: 'tool:sample', id: 'every-hour', on: { time: { every_ms: HOUR } }, budget: { steps: 1 } };
const notes = { tool: 'tool:sample', id: 'on-note', on: { record: { resource: 'notes', kind: 'note' } }, budget: { steps: 1 } };
const inbox = { tool: 'tool:sample', id: 'inbox', on: { arrival: { source: 'mail' } }, budget: { steps: 1 } };
const book = (marks, live = {}) => ({ marks: Object.fromEntries(Object.entries(marks).map(([id, mark]) => [wakeKey('tool:sample', id), mark])), live });
const one = (wake, theBook, extra = {}) => seeWhatRunsOnItsOwn({ now_ms: NOW, wakes: [wake], book: theBook, ...extra }).causes[0];

test('a wake is found by the engine\'s key: BLAKE3 of tool, zero, id, zero', () => {
  // The same bytes through b3sum: printf 'tool:sample\0every-hour\0' | b3sum
  assert.equal(wakeKey('tool:sample', 'every-hour'), '5d779854c55f759d0d6ea808b8cab04402b50d3f866b155e0f71e06ce634fe01');
  // The engine's own test of its key uses this pair (trillion-rust src/wake/tests.rs).
  assert.equal(wakeKey('sample-tool', 'every-hour'), '0266f22d38ce04dcbd4810dd1d16c9ee661cf7719b61d3d8f93237f22ff2477b');
});

test('a wake waiting for its cause is on, with its next run', () => {
  const cause = one(hourly, book({ 'every-hour': { next_ms: NOW + HOUR, ran_ms: NOW - HOUR, outcome: 'ran' } }));
  assert.deepEqual([cause.state, cause.red, cause.next_run_ms, cause.last_run_ms, cause.last_outcome], ['on', false, NOW + HOUR, NOW - HOUR, 'ran']);
  assert.equal(cause.waits_for, 'every hour');
  assert.deepEqual(cause.switch, { tool: 'tool:sample', id: 'every-hour', on: true, turn: 'off', label: 'Turn off' });
});

test('a cause that should have run and did not is red, and says why', () => {
  // Past due by more than late_after_ms: the engine stopped running causes.
  const late = one(hourly, book({ 'every-hour': { next_ms: NOW - 2 * HOUR } }));
  assert.deepEqual([late.state, late.red], ['late', true]);
  assert.match(late.why, /nothing ran it/);
  // A watched resource changed long ago and the wake's cursor never read it.
  const unread = one(notes, book({ 'on-note': { after: 0 } }), { stamps: { notes: (NOW - HOUR) * 65536 } });
  assert.deepEqual([unread.state, unread.red], ['late', true]);
  // Due with the period's budget spent; a failed run; a lost answer; a wake the engine never picked up.
  assert.equal(one(hourly, book({ 'every-hour': { next_ms: NOW, unfunded_ms: NOW - HOUR } })).state, 'unfunded');
  assert.equal(one(hourly, book({ 'every-hour': { next_ms: NOW + HOUR, outcome: 'failed' } })).state, 'failed');
  assert.equal(one(hourly, book({ 'every-hour': { next_ms: NOW + HOUR, outcome: 'unknown' } })).state, 'unknown');
  const unplaced = one(hourly, null);
  assert.deepEqual([unplaced.state, unplaced.red, unplaced.label], ['unplaced', true, 'Not picked up yet']);
  // An arrival wake has no mark until its first event, so no mark is not a fault.
  assert.deepEqual([one(inbox, null).state, one(inbox, null).waits_for], ['on', 'when mail sends something']);
});

test('off wins over everything and shows the switch to turn it on; a running cause shows as running', () => {
  const off = one(hourly, book({ 'every-hour': { off: true, next_ms: NOW - 5 * HOUR, outcome: 'failed' } }));
  assert.deepEqual([off.state, off.red, off.also, off.switch.turn, off.switch.label], ['off', false, [], 'on', 'Turn on']);
  const running = one(hourly, book({ 'every-hour': { next_ms: NOW + HOUR } }, { k: { tool: 'tool:sample', wake: 'every-hour' } }));
  assert.equal(running.state, 'running');
});

test('red causes come first, with counts', () => {
  const all = seeWhatRunsOnItsOwn({ now_ms: NOW, wakes: [inbox, hourly, notes],
    book: book({ 'every-hour': { next_ms: NOW - 2 * HOUR }, 'on-note': { after: 0, off: true } }) });
  assert.deepEqual(all.causes.map(cause => cause.id), ['every-hour', 'inbox', 'on-note']);
  assert.deepEqual([all.red, all.on, all.off], [1, 2, 1]);
  assert.throws(() => seeWhatRunsOnItsOwn({ wakes: [] }), /now_ms/);
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

const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);
const run = (argv, input) => spawnSync(process.execPath, argv, { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, () => {
    for (const sample of row.verify.filter(item => item.kind === 'sample-run')) {
      const ran = run(row.invoke.argv.slice(1), sample.input);
      assert.equal(ran.status, 0, ran.stderr);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}
