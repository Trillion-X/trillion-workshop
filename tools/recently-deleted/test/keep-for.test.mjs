// tool:read-deleted-files-keep-for run as the container runs it, against the fake records door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:read-deleted-files-keep-for');

test('each state keeps its DATA default until the person chose their own days', async () => {
  const defaults = await runRow(row, {});
  assert.equal(defaults.status, 0, defaults.error);
  assert.deepEqual(defaults.result.states.map(state => [state.id, state.after_days, state.default_after_days]), [['deleted', 30, 30], ['archived', 30, 30]]);
  assert.deepEqual(defaults.result.choices, [1, 7, 30, 90, 365, null]);
  const chosen = await runRow(row, {}, { records: [{ id: 'setting:keep_for', type: 'setting', value: { value: { deleted: 7, archived: null } } }] });
  assert.deepEqual(chosen.result.states.map(state => [state.id, state.after_days, state.when_due]), [['deleted', 7, null], ['archived', null, 'deleted']]);
});

test('the row may read the one keep-for setting and nothing else', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'setting', id: 'setting:keep_for', operations: ['records:read'] }]);
});
