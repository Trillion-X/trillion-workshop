// src/date-shift.mjs (DATA: src/date-shift.json): a plan of dated stages moves by a named strategy and lock mode, and the
// Calendar tasks of a task list move the same way through the Calendar tasks owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DateShiftError, dateOf, dayOf, planTaskShift, shiftChoices, shiftStages } from '../src/date-shift.mjs';
import data from '../src/date-shift.json' with { type: 'json' };

const plan = [
  { id: 'a', start: '2026-11-02', end: '2026-11-06' },
  { id: 'b', start: '2026-11-09', end: '2026-11-13' },
  { id: 'c', start: '2026-11-16', end: '2026-11-20' },
];
const span = result => result.stages.map(stage => `${stage.id}:${dateOf(stage.start)}..${dateOf(stage.end)}`);

test('shift moves every stage by the same days and keeps lengths', () => {
  const result = shiftStages(plan, { strategy: 'shift', lock: 'none', end: '2026-11-27' });
  assert.deepEqual(span(result), ['a:2026-11-09..2026-11-13', 'b:2026-11-16..2026-11-20', 'c:2026-11-23..2026-11-27']);
  assert.throws(() => shiftStages(plan, { strategy: 'shift', lock: 'none', start: '2026-11-03', end: '2026-11-27' }), /same number of days/);
});

test('absorb changes only the stage at the moved end', () => {
  assert.deepEqual(span(shiftStages(plan, { strategy: 'absorb', lock: 'none', end: '2026-12-04' })), ['a:2026-11-02..2026-11-06', 'b:2026-11-09..2026-11-13', 'c:2026-11-16..2026-12-04']);
  assert.throws(() => shiftStages(plan, { strategy: 'absorb', lock: 'none', end: '2026-11-12' }), /would end before it starts|run into|would end/);
});

test('distribute fills the window with no day left over and no day shared', () => {
  const result = shiftStages(plan, { strategy: 'distribute', lock: 'none', start: '2026-11-02', end: '2026-12-02' });
  assert.equal(result.stages[0].start, dayOf('2026-11-02'));
  assert.equal(result.stages.at(-1).end, dayOf('2026-12-02'));
  for (let at = 1; at < result.stages.length; at += 1) assert.equal(result.stages[at].start, result.stages[at - 1].end + 1);
  assert.equal(result.stages.reduce((sum, stage) => sum + stage.end - stage.start + 1, 0), 31);
  assert.throws(() => shiftStages(plan, { strategy: 'distribute', lock: 'none', start: '2026-11-02', end: '2026-11-03' }), /cannot hold 3 stages/);
});

test('accordion keeps lengths and spreads the slack between stages', () => {
  const result = shiftStages(plan, { strategy: 'accordion', lock: 'none', end: '2026-11-30' });
  assert.deepEqual(result.stages.map(stage => stage.end - stage.start + 1), [5, 5, 5]);
  assert.equal(result.stages.at(-1).end, dayOf('2026-11-30'));
  assert.throws(() => shiftStages(plan, { strategy: 'accordion', lock: 'none', end: '2026-11-10' }), /need 15 days/);
});

test('shrink cuts the last stages back first and never below a day', () => {
  const result = shiftStages(plan, { strategy: 'shrink', lock: 'none', end: '2026-11-17' });
  assert.deepEqual(span(result), ['a:2026-11-02..2026-11-06', 'b:2026-11-09..2026-11-13', 'c:2026-11-16..2026-11-17']);
  assert.deepEqual(result.moved, ['c']);
  assert.throws(() => shiftStages(plan, { strategy: 'shrink', lock: 'none', end: '2026-12-01' }), /only brings the end in/);
  assert.throws(() => shiftStages(plan, { strategy: 'shrink', lock: 'none', end: '2026-11-03' }), /cannot hold 3 stages/);
});

test('locked work never moves, and unlocked work cannot come before it', () => {
  const stages = [{ ...plan[0], done: true }, { ...plan[1], done: true }, plan[2]];
  const result = shiftStages(stages, { strategy: 'shift', lock: 'finished', end: '2026-11-27' });
  assert.deepEqual(span(result), ['a:2026-11-02..2026-11-06', 'b:2026-11-09..2026-11-13', 'c:2026-11-23..2026-11-27']);
  assert.deepEqual(result.moved, ['c']);
  assert.throws(() => shiftStages(stages, { strategy: 'shift', lock: 'finished', start: '2026-11-01' }), /start cannot move while its first stage is locked/);
  assert.throws(() => shiftStages(stages, { strategy: 'shift', lock: 'finished', end: '2026-11-10' }), /run into locked work that ends on 2026-11-13/);
  assert.throws(() => shiftStages([plan[0], { ...plan[1], done: true }], { lock: 'finished', end: '2026-12-01' }), /not locked but comes before locked work/);
  assert.throws(() => shiftStages(stages.map(stage => ({ ...stage, done: true })), { lock: 'finished', end: '2026-12-01' }), /Every stage is locked/);
  const started = shiftStages([{ ...plan[0], started: true }, plan[1], plan[2]], { strategy: 'absorb', lock: 'started', end: '2026-12-11' });
  assert.deepEqual(started.moved, ['c'], 'started work is locked by the started mode only');
  assert.deepEqual(shiftStages([{ ...plan[0], started: true }, plan[1], plan[2]], { strategy: 'absorb', lock: 'finished', start: '2026-11-01', end: '2026-12-11' }).moved, ['a', 'c']);
});

test('refusals name the problem; choices list every strategy and lock from DATA', () => {
  assert.throws(() => shiftStages(plan, { strategy: 'teleport', end: '2026-12-01' }), /teleport is not a way to move a plan. The ways are: shift, absorb, distribute, accordion, shrink/);
  assert.throws(() => shiftStages(plan, { lock: 'maybe', end: '2026-12-01' }), /not a lock mode/);
  assert.throws(() => shiftStages(plan, {}), /new start, the new end, or both/);
  assert.throws(() => shiftStages([], { end: '2026-12-01' }), DateShiftError);
  assert.throws(() => shiftStages([{ id: 'x', start: '2026-11-05', end: '2026-11-01' }], { end: '2026-12-01' }), /Stage x must start on or before it ends/);
  assert.throws(() => shiftStages(plan, { end: '2026-02-30' }), /new end must be a date/);
  assert.deepEqual(shiftChoices().strategies.map(item => item.id), data.strategies.map(item => item.id));
});

test('planTaskShift moves the dated tasks as values: the changes carry the new dates and the previous ones, and nothing else', () => {
  const tasks = [
    { id: 'one', title: 'design', start_on: '2026-11-02', due: '2026-11-06', status: 'Done' },
    { id: 'two', title: 'build', start_on: '2026-11-09', due: '2026-11-13', status: 'Open' },
    { id: 'three', title: 'ship', start_on: '2026-11-16', due: '2026-11-20T17:00:00.000Z', status: 'Open' },
    { id: 'undated', title: 'undated', start_on: null, due: null, status: 'Open' },
  ];
  const plan = planTaskShift(tasks, { strategy: 'shift', lock: 'started', end: '2026-11-27', today: '2026-11-10' });
  assert.deepEqual(plan.moved, ['three']);
  assert.deepEqual(plan.changes, [{ task_id: 'three', start_on: '2026-11-23', due: '2026-11-27T17:00:00.000Z', previous: { start_on: '2026-11-16', due: '2026-11-20T17:00:00.000Z' } }], 'a due time of day is kept');
  assert.equal(tasks[2].due, '2026-11-20T17:00:00.000Z', 'the rows handed in are not changed');
  const preview = planTaskShift(tasks, { strategy: 'shift', end: '2026-11-27', today: '2026-11-10', dry_run: true });
  assert.equal(preview.dry_run, true);
  assert.deepEqual(preview.moved.sort(), ['three', 'two'].sort());
});

test('planTaskShift refuses a plan with no dated task, in words, and reads no store', () => {
  assert.throws(() => planTaskShift([{ id: 'x', title: 'none', start_on: null, due: null, status: 'Open' }], { end: '2026-12-01' }), DateShiftError);
  assert.throws(() => planTaskShift([], { end: '2026-12-01' }), /has a due date/);
});

test('choices list every strategy and lock from DATA', () => {
  assert.deepEqual(shiftChoices().strategies.map(s => s.id), data.strategies.map(s => s.id));
});
