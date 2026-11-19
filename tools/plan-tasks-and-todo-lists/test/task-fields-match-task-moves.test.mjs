// The shipped task list holds the fields the task rows keep, its Status offers the rows' states, and it settles the closed
// ones. Reads only the two DATA files, so it runs without the calendar's own code.
import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../calendar-tasks.json' with { type: 'json' };
import rules from '../task-moves.json' with { type: 'json' };

const fields = new Map(data.list.fields.map(field => [field.id, field]));
const planning = new Map(data.collections.fields.map(field => [field.id, field]));

test('the list holds the fields a task keeps: who may take it, who gave it, who took it and when, and what it came to', () => {
  assert.equal(fields.get('assignees').kind, 'tags', 'a list of record ids is held as a tags field');
  for (const id of ['sent_by', 'taken_by', 'outcome']) assert.equal(fields.get(id).kind, 'text', id);
  assert.equal(fields.get('taken_at').kind, 'date');
  assert.equal(fields.get('result').kind, 'long-text');
});

test('Status offers the rows\' states, starts waiting, and settles the closed states', () => {
  const status = fields.get('status');
  assert.deepEqual(status.choices, rules.states.map(state => state.key));
  assert.equal(status.starts, rules.start);
  assert.deepEqual(status.settles, rules.states.filter(state => state.terminal).map(state => state.key));
});

test('no job gate is left in the list: the lane-job mark and the job link are gone', () => {
  const text = JSON.stringify(data);
  assert.equal(text.includes('needs_linked_records_to_set'), false);
  assert.equal('job_link' in data, false);
  assert.equal(text.includes('ai-job'), false);
});

test('the planning switch is named plan_automatically on the list and on the preferences row', () => {
  assert.equal(planning.get('plan_automatically').kind, 'choice');
  assert.equal(JSON.stringify(data).includes('ai_scheduling'), false);
});
