// tool:read-deleted-files-keep-for run as the container runs it, with no records door: the person's choice comes in the request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };

const row = rowOf(rows, 'tool:read-deleted-files-keep-for');

test('each state keeps its DATA default until the person chose their own days', async () => {
  const defaults = await answerOf(row, {});
  assert.equal(defaults.status, 0, defaults.error);
  assert.deepEqual(defaults.result.states.map(state => [state.id, state.after_days, state.default_after_days]), [['deleted', 30, 30], ['archived', 30, 30]]);
  assert.deepEqual(defaults.result.choices, [1, 7, 30, 90, 365, null]);
  const chosen = await answerOf(row, { keep_for: { deleted: 7, archived: null } });
  assert.deepEqual(chosen.result.states.map(state => [state.id, state.after_days, state.when_due]), [['deleted', 7, null], ['archived', null, 'deleted']]);
});

test('the row holds no records door and takes the choice as input', () => {
  assert.equal(row.invoke.records, undefined);
  assert.ok(row.input_schema.properties.keep_for);
});
