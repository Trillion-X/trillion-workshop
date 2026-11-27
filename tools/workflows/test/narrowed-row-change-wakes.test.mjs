// tools/workflows/test/narrowed-row-change-wakes.test.mjs
//
// tool:run-a-workflow's narrowed row-change wakes hear only their own table: a-task-row-changed a calendar_tasks change,
// an-asked-run-row-changed a workflow_runs_asked change, and a workflow_recipes change wakes neither. The engine hears a
// fact when its kind and teller match and every field of `match` equals the fact's payload field (the engine's
// src/wake.rs On::hears); this test reads the shipped row and judges facts by that rule. Nov 21 2026: copies of
// a-row-changed that heard every something-changed fact spent about half the Mac's work ledger by 10:18 PM CST.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records;
const runner = rows.find((row) => row.payload.id === 'tool:run-a-workflow').payload;
const wake = (id) => runner.wakes.find((one) => one.id === id);

/** Whether `declared` hears a fact of `kind` told by `teller` with `payload`, by the engine's rule. */
function hears(declared, kind, teller, payload) {
  const fact = declared.on.fact;
  return fact.kind === kind && fact.from.includes(teller)
    && Object.entries(fact.match ?? {}).every(([field, want]) => payload[field] === want);
}

const change = (place) => ({ where: 'a-pursuit-database-connection', place, change: 'changed', key: `a_pursuit_database:1:${place}` });

test('each narrowed wake hears its own table and nothing else', () => {
  assert.ok(hears(wake('a-task-row-changed'), 'something-changed', 'run', change('calendar_tasks')));
  assert.ok(!hears(wake('a-task-row-changed'), 'something-changed', 'run', change('workflow_runs_asked')));
  assert.ok(hears(wake('an-asked-run-row-changed'), 'something-changed', 'run', change('workflow_runs_asked')));
  assert.ok(!hears(wake('an-asked-run-row-changed'), 'something-changed', 'run', change('calendar_tasks')));
});

test('a workflow_recipes change wakes neither narrowed wake', () => {
  for (const id of ['a-task-row-changed', 'an-asked-run-row-changed']) {
    assert.ok(!hears(wake(id), 'something-changed', 'run', change('workflow_recipes')), `${id} heard a workflow_recipes change`);
  }
});
