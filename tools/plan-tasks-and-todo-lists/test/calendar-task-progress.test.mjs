// A task's progress is a rollup the Lists owner works out on every read: the share of the tasks where its steps end whose Status
// the list itself settles on. Nothing here names a status word, a task list or a depth; the rows below are made by the calendar's own
// actions and read back through the real Lists owner and the real formula engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import data from '../calendar-tasks.json' with { type: 'json' };
import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/lists.json' with { type: 'json' };
import { localStore } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { makeLists, handleListsRequest } from '../../keep-lists-of-rows/lists.mjs';
import { makeRowFilter } from '../../formula-engine/rules/filter-rows-by-rules.mjs';
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { changeCalendarTask } from '../calendar-tasks.mjs';

const evaluator = makeRowFilter({ operators, wasm: () => readFileSync(new URL('../../formula-engine/built-stored-bytes/evaluate-over-rows/evaluate-over-rows_bg.wasm', import.meta.url)) });
const ruleKinds = new Map(settings.field_kinds.map(kind => [kind.id, kind.ruleKind]));
const views = { filterRows: input => evaluator.filterRowsByRules(input), ruleKindOf: kind => ruleKinds.get(kind) ?? kind,
  evaluateBinding: async (binding, input) => (await evaluator.evaluateBinding({ binding, input })).value };

test('the shipped task list declares progress as DATA: steps are the rows paired with parent_id, and what is settled is the Status field\'s own', () => {
  const fields = Object.fromEntries(data.list.fields.map(field => [field.id, field]));
  assert.equal(fields.parent_id.pairs_with, 'children');
  assert.equal(fields.children.pairs_with, 'parent_id');
  assert.equal(fields.progress.kind, 'formula');
  assert.ok(fields.status.settles.length, 'what counts as settled is the Status field\'s own data');
  assert.ok(JSON.stringify(fields.own_settled.rollup.where).includes('"settles_of":"status"'), 'no status word is named in the definition');
  assert.ok(!JSON.stringify([fields.own_settled, fields.steps_done, fields.progress]).includes('Done'));
  for (const id of ['children', 'step_count', 'own_settled', 'steps_total_below', 'steps_done_below', 'steps_total', 'steps_done', 'progress']) assert.ok(data.undo.excluded_fields.includes(id), `${id} is computed or paired, never restored`);
});

test('a task\'s progress counts the settled end rows under it, whatever its depth, and a task with no steps is done or not by its own status', async t => {
  const store = localStore(':memory:');
  t.after(() => store.close?.());
  let n = 0;
  const lists = makeLists({ eeaf: store.eeaf, newId: () => `row-${++n}` });
  const make = async (key, parent) => (await changeCalendarTask(lists, { action: 'create', request_key: key, title: key, duration_minutes: 15, ...(parent ? { parent_id: parent } : {}) })).task.id;
  const trunk = await make('trunk');
  const branch = await make('branch', trunk);
  const one = await make('one', branch);
  const two = await make('two', branch);
  const three = await make('three', trunk);
  await changeCalendarTask(lists, { action: 'complete', task_id: one });
  const read = async () => {
    const response = await handleListsRequest(lists, new Request(`https://person/lists/${data.list.id}`), views);
    return Object.fromEntries((await response.json()).rows.map(row => [row.id, row.values.progress]));
  };
  let progress = await read();
  assert.equal(progress[trunk], 33, 'one of the three end rows (one, two, three) is settled');
  assert.equal(progress[branch], 50);
  assert.equal(progress[two], 0);
  assert.equal(progress[three], 0);
  await changeCalendarTask(lists, { action: 'complete', task_id: two });
  await changeCalendarTask(lists, { action: 'complete', task_id: three });
  progress = await read();
  assert.equal(progress[trunk], 100);
  assert.equal(progress[branch], 100);
});
