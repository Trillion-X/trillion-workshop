// test/read-task-page.test.mjs
//
// The task page's read (read-data/read-task-page.mjs): one read-only SELECT of the three task tables, the caller's SQL runner
// is the only database it touches, the rows map to the page's data (a missing parent is null, a missing list is empty, a
// row with no data is an error), and a table name must be a plain identifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TASK_TABLES, readTaskPage, taskPageFrom, taskPageSql } from '../read-data/read-task-page.mjs';
// The shows table is one more of the four the one SELECT reads; a pursuit's own name for it is passed the same way.

const answer = {
  tasks: [
    { id: 'goal-1', title: 'Goal', plain_title: null, plain_detail: null, parent: null, status: 'To do', waiting_on: null },
    { id: 'step-1', title: 'Step', plain_title: 'A step', plain_detail: 'Details', parent: 'goal-1', status: 'Done', waiting_on: null, evidence: 'Read back 3 of 3' },
  ],
  statuses: [
    { name: 'Done', mark: 'done', tone: null, counts_as_done: true, closed: true, place: 1 },
    { name: 'To do', mark: 'todo', tone: null, counts_as_done: false, closed: false, place: 7 },
  ],
  changes: [
    { task: 'step-1', at: '2026-11-18T14:00:00.000-06:00', kind: 'made', status: 'To do', title: null },
    { task: 'step-1', at: '2026-11-18T15:00:00.000-06:00', kind: 'from transcript', status: 'Done', title: 'Said so' },
  ],
  shows: [
    { task: 'step-1', ref: 'https://example.com/page', label: 'The page', made_at: '2026-11-18T16:00:00.000-06:00' },
  ],
};

test('the SQL reads the three default task tables in one read-only SELECT', () => {
  const sql = taskPageSql();
  assert.match(sql, /^select json_build_object\(/);
  for (const table of Object.values(DEFAULT_TASK_TABLES)) assert.ok(sql.includes(`from ${table})`), `reads ${table}`);
  assert.equal(sql.includes(';'), false, 'one statement');
  assert.equal(/\b(insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(sql), false, 'no write verb');
});

test('table names are plain identifiers; another pursuit names its own tables', () => {
  const sql = taskPageSql({ tasks: 'work_items', changes: 'work_says', statuses: 'work_statuses', shows: 'work_shows' });
  assert.ok(sql.includes('from work_items)') && sql.includes('from work_says)') && sql.includes('from work_statuses)') && sql.includes('from work_shows)'));
  assert.throws(() => taskPageSql({ tasks: 'x; drop table y' }), /plain identifier/);
  assert.throws(() => taskPageSql({ changes: 'Public.Changes' }), /plain identifier/);
});

test('readTaskPage calls the caller runner once and maps the rows', async () => {
  const calls = [];
  const runSql = async sql => { calls.push(sql); return { rows: [{ data: answer }] }; };
  const page = await readTaskPage(runSql);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], taskPageSql());
  assert.deepEqual(page.tasks[0], { id: 'goal-1', title: 'Goal', plain_title: null, plain_detail: null, parent: null, status: 'To do', waiting_on: null, evidence: null });
  assert.equal(page.tasks[1].evidence, 'Read back 3 of 3', 'a row\'s evidence (why its status stands) reaches the page');
  assert.equal(page.tasks[1].parent, 'goal-1');
  assert.equal(page.tasks[1].plain_title, 'A step');
  assert.deepEqual(page.statuses[0], { name: 'Done', mark: 'done', tone: null, counts_as_done: true, closed: true, place: 1 });
  assert.equal(page.changes[0].title, null);
  assert.equal(page.changes[1].title, 'Said so');
  assert.equal(page.changes.length, 2);
  assert.deepEqual(page.shows, [{ task: 'step-1', ref: 'https://example.com/page', label: 'The page', made_at: '2026-11-18T16:00:00.000-06:00' }]);
});

test('an empty table is an empty list, and a missing field is null or false', () => {
  const page = taskPageFrom([{ data: { tasks: null, statuses: [{ name: 'X', mark: 'todo', place: '3' }], changes: [{ task: 't', at: 'a', kind: 'made' }] } }]);
  assert.deepEqual(page.tasks, []);
  assert.deepEqual(page.shows, []);
  assert.deepEqual(page.statuses[0], { name: 'X', mark: 'todo', tone: null, counts_as_done: false, closed: false, place: 3 });
  assert.deepEqual(page.changes[0], { task: 't', at: 'a', kind: 'made', status: null, title: null });
});

test('a read with no data object is an error, never an empty page', async () => {
  assert.throws(() => taskPageFrom([]), /no data object/);
  assert.throws(() => taskPageFrom([{}]), /no data object/);
  await assert.rejects(readTaskPage(async () => ({ rows: [] })), /no data object/);
  await assert.rejects(readTaskPage(null), TypeError);
});

test('facts and their kinds are read in the same SELECT and mapped, a count as a number', () => {
  const sql = taskPageSql();
  assert.ok(sql.includes('from task_facts)') && sql.includes('from task_fact_kinds)'), 'reads the fact tables');
  const page = taskPageFrom([{ data: { tasks: [], statuses: [], changes: [],
    facts: [{ task: 't', kind: 'numbers', said: 'usable clips', number: '0', of_number: null, at: 'a' }, { task: 't', kind: 'next', said: 'Retire it', number: null, of_number: null, at: 'b' }],
    fact_kinds: [{ name: 'numbers', label: 'Numbers', place: '2', tone: null }] } }]);
  assert.deepEqual(page.facts[0], { task: 't', kind: 'numbers', said: 'usable clips', number: 0, of_number: null, at: 'a' });
  assert.equal(page.facts[1].number, null);
  assert.deepEqual(page.fact_kinds[0], { name: 'numbers', label: 'Numbers', place: 2, tone: null });
  assert.deepEqual(taskPageFrom([{ data: { tasks: [] } }]).facts, []);
});
