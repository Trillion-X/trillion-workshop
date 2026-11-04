// src/date-shift.mjs (DATA: src/date-shift.json): a plan of dated stages moves by a named strategy and lock mode, and the
// Calendar tasks of a task list move the same way through the Calendar tasks owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists } from '../../keep-lists-of-rows/lists.mjs';
import { changeCalendarTask, readCalendarTasks } from '../../plan-tasks-and-todo-lists/calendar-tasks.mjs';
import { DateShiftError, dateOf, dayOf, shiftChoices, shiftCalendarTasks, shiftStages } from '../src/date-shift.mjs';
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

test('Calendar tasks of a task list move through the owner, finished work stays, and undo puts them back', () => {
  const store = localStore(':memory:');
  try {
    const lists = makeLists({ eeaf: store.eeaf });
    const { collection } = changeCalendarTask(lists, { action: 'create_collection', request_key: 'launch', title: 'Launch' });
    const make = (key, due, start_on) => changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: 30, collection_id: collection.id, due, ...(start_on ? { start_on } : {}) }).task;
    const one = make('design', '2026-11-06', '2026-11-02');
    const two = make('build', '2026-11-13', '2026-11-09');
    const three = make('ship', '2026-11-20T17:00:00.000Z', '2026-11-16');
    make('undated');
    changeCalendarTask(lists, { action: 'complete', task_id: one.id });

    const preview = shiftCalendarTasks(lists, { collection_id: collection.id, strategy: 'shift', end: '2026-11-27', today: '2026-11-10', dry_run: true });
    assert.deepEqual(preview.moved.sort(), [three.id, two.id].sort());
    assert.equal(readCalendarTasks(lists).tasks.find(task => task.id === three.id).due, '2026-11-20T17:00:00.000Z', 'a dry run writes nothing');

    const done = shiftCalendarTasks(lists, { collection_id: collection.id, strategy: 'shift', lock: 'started', end: '2026-11-27', today: '2026-11-10' });
    const after = Object.fromEntries(readCalendarTasks(lists).tasks.map(task => [task.id, [task.start_on, task.due]]));
    assert.deepEqual(after[one.id], ['2026-11-02', '2026-11-06'], 'finished work stays');
    assert.deepEqual(after[two.id], ['2026-11-09', '2026-11-13'], 'started work stays under the started lock');
    assert.deepEqual(after[three.id], ['2026-11-23', '2026-11-27T17:00:00.000Z'], 'the time of a due date is kept');
    assert.deepEqual(done.moved, [three.id]);

    assert.ok(done.undo?.rows?.length, 'the owner\'s own undo comes back');
    changeCalendarTask(lists, done.undo);
    assert.deepEqual(readCalendarTasks(lists).tasks.find(task => task.id === three.id).due, '2026-11-20T17:00:00.000Z');
    assert.throws(() => shiftCalendarTasks(lists, { end: '2026-12-01' }), /Choose a task list/);
    assert.throws(() => shiftCalendarTasks(lists, { task_ids: ['nobody'], end: '2026-12-01' }), /None of those tasks has a due date/);
  } finally { store.close?.(); }
});

test('the route and tools move a plan and list the choices', async () => {
  const { dateShiftAnnotations, dateShiftTools, handleDateShiftRequest, isDateShiftPath } = await import('../src/date-shift.mjs');
  const store = localStore(':memory:');
  try {
    const lists = makeLists({ eeaf: store.eeaf });
    const { collection } = changeCalendarTask(lists, { action: 'create_collection', request_key: 'trip', title: 'Trip' });
    const task = changeCalendarTask(lists, { action: 'create', request_key: 'book', title: 'Book', duration_minutes: 30, collection_id: collection.id, due: '2026-11-06', start_on: '2026-11-02' }).task;
    const call = async (path, body) => {
      const response = await handleDateShiftRequest(lists, new Request(`https://person${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    };
    const tools = dateShiftTools(async (path, body) => (await call(path, body)).body);
    assert.deepEqual(dateShiftTools(() => {}).map(tool => tool.name).filter(name => !dateShiftAnnotations[name]), []);
    assert.deepEqual((await tools[1].run()).strategies.map(item => item.id), data.strategies.map(item => item.id));
    const moved = await tools[0].run({ collection_id: collection.id, strategy: 'shift', lock: 'none', end: '2026-11-13' });
    assert.deepEqual(moved.moved, [task.id]);
    assert.equal(readCalendarTasks(lists).tasks[0].due, '2026-11-13');
    assert.equal((await call('/calendar/task-shift', { collection_id: collection.id, strategy: 'teleport', end: '2026-11-20' })).status, 400);
    assert.equal(isDateShiftPath('/calendar/task-shift') && !isDateShiftPath('/calendar/tasks'), true);
  } finally { store.close?.(); }
});
