// Tasks kept as rows of a table (the runs-it database of whatever the work is for): recordsInTables over a real Postgres
// (PGlite) carries give, take, hand-on to a person, that person's take and finish, each write conditioned on the row as
// read, and of two takes of one task read at the same time only the first is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { recordsInTables, runTaskMove, tasksIn } from '../run-a-task-move.mjs';
import { changeATask, giveATask, takeATask } from '../task-moves.mjs';

const ROWS = { 'tool:give-a-task': giveATask, 'tool:take-a-task': takeATask, 'tool:change-a-task': changeATask };

async function database() {
  const db = new PGlite();
  await db.exec(`create table calendar_tasks (id text primary key, title text, description text, status text, priority text, assignees jsonb,
    sent_by text, sent_at text, taken_by text, taken_at text, finished_by text, finished_at text, outcome text, result text, summary text,
    details jsonb, plain_title text, made_at timestamptz, changed_at timestamptz);
    create table users (id text primary key, name text, kind text, can jsonb, live jsonb, details jsonb, moved_from jsonb);`);
  await db.query(`insert into users (id, name, kind, can) values ('person:someone', 'Someone', 'person', '["any"]'), ('ai:north', 'North', 'cli', '["any"]')`);
  const runSql = async (sql, params) => (await db.query(sql, params)).rows;
  // tools:run runs the row itself, as the engine would.
  const tools = async (address, method, input, key) => {
    assert.equal(method, 'tools:run');
    return { exit_code: 0, result: await ROWS[input.tool]({ input: input.input, task: { request_key: key } }, { now: () => new Date() }) };
  };
  return { db, resource: recordsInTables(runSql, { rest: tools }) };
}

test('a task is given, taken, handed on to a person and finished, all as rows of the table', async () => {
  const { db, resource } = await database();
  const given = await runTaskMove(resource, { tool: 'tool:give-a-task', key: 'k1', input: { as: 'ai:north', description: 'Fix the build', key: 'k1' } });
  assert.equal(given.kept, true);
  const id = given.result.task_id;
  let [row] = (await db.query('select status, assignees, sent_by, made_at from calendar_tasks where id = $1', [id])).rows;
  assert.deepEqual([row.status, row.assignees, row.sent_by, row.made_at !== null], ['To do', [], 'ai:north', true]);

  const taken = await runTaskMove(resource, { tool: 'tool:take-a-task', key: 't1', input: { as: 'ai:north' }, read: { tasks: { statuses: ['To do'] } } });
  assert.equal(taken.result.taken.id, id);
  [row] = (await db.query('select status, taken_by, taken_at from calendar_tasks where id = $1', [id])).rows;
  assert.equal(row.status, 'In progress');
  assert.equal(row.taken_by, 'ai:north');

  const handed = await runTaskMove(resource, { tool: 'tool:change-a-task', key: 'h1', input: { as: 'ai:north', id, action: 'hand-on', assignees: ['person:someone'], because: 'Yours now', taken_at: row.taken_at }, read: { ids: [{ type: 'calendar-task', id }, { type: 'user', id: 'person:someone' }] } });
  assert.equal(handed.result.moved, true);
  [row] = (await db.query('select status, assignees, taken_by, details from calendar_tasks where id = $1', [id])).rows;
  assert.deepEqual([row.status, row.assignees, row.taken_by], ['To do', ['person:someone'], null]);
  assert.equal(row.details.handed_on.by, 'ai:north', 'fields with no column of their own are kept in details');

  const mine = await runTaskMove(resource, { tool: 'tool:take-a-task', key: 't2', input: { as: 'person:someone', id }, read: { ids: [{ type: 'calendar-task', id }] } });
  assert.equal(mine.result.taken.taken_by, 'person:someone');
  const failed = await runTaskMove(resource, { tool: 'tool:change-a-task', key: 'f1', input: { as: 'person:someone', id, action: 'fail', result: 'The build server is gone.', taken_at: mine.result.taken.taken_at }, read: { ids: [{ type: 'calendar-task', id }] } });
  assert.equal(failed.result.to, 'Broken');
  [row] = (await db.query('select status, result, finished_by from calendar_tasks where id = $1', [id])).rows;
  assert.deepEqual([row.status, row.result, row.finished_by], ['Broken', 'The build server is gone.', 'person:someone']);
});

test('of two takes that read the same waiting task, only the first is kept, and a type with no table is refused', async () => {
  const { db, resource } = await database();
  const { result } = await runTaskMove(resource, { tool: 'tool:give-a-task', key: 'k2', input: { as: 'ai:north', description: 'One task', key: 'k2' } });
  const read = await resource('@own-records', 'records:list', { type: 'calendar-task', where: { status: 'To do' } });
  const records = read.records.map(row => ({ id: row.id, type: 'calendar-task', value: row.value }));
  const first = await takeATask({ input: { as: 'ai:north', records } }, { now: () => new Date() });
  const second = await takeATask({ input: { as: 'person:someone', records } }, { now: () => new Date() });
  await resource('@own-records', 'records:write', { records: first.keep });
  await assert.rejects(resource('@own-records', 'records:write', { records: second.keep }), error => error.code === 'original_command_conflict');
  const [row] = (await db.query('select taken_by from calendar_tasks where id = $1', [result.task_id])).rows;
  assert.equal(row.taken_by, 'ai:north');
  await db.query(`insert into users (id, name) values ('person:no-can', 'Says nothing it can take')`);
  const takers = await resource('@own-records', 'records:list', { type: 'user', present: ['can'] });
  assert.deepEqual(takers.records.map(one => one.id).sort(), ['ai:north', 'person:someone'], 'a user whose can holds nothing is not listed as one who can take');
  await assert.rejects(resource('@own-records', 'records:list', { type: 'user', present: ['nope; drop'] }), /not a plain table or column name/);
  const counted = await resource('@own-records', 'records:list', { type: 'calendar-task', fields: ['status', 'taken_by'] });
  assert.deepEqual(counted.records.map(one => one.value), [{ status: 'In progress', taken_by: 'ai:north' }], 'only the named fields are read');
  await assert.rejects(resource('@own-records', 'records:list', { type: 'ai-job' }), /No table keeps records of type ai-job/);
  await assert.rejects(resource('@own-records', 'records:list', { type: 'calendar-task', where: { 'status; drop': 'x' } }), /not a plain table or column name/);
});

test('tasksIn runs each statement as one run of the SQL tool with the held connection name, and with no store is the transport itself', async () => {
  const { db } = await database();
  const asked = [];
  const tools = async (address, method, input, key) => {
    if (input.tool === 'tool:run-sql-in-my-database') {
      asked.push(input.input.credential_name);
      return { exit_code: 0, result: { rows: (await db.query(input.input.sql, input.input.params)).rows } };
    }
    return { exit_code: 0, result: await ROWS[input.tool]({ input: input.input, task: { request_key: key } }, { now: () => new Date() }) };
  };
  assert.equal(tasksIn(tools, null), tools);
  const resource = tasksIn(tools, { credential_name: 'tasks-db-connection' });
  const given = await runTaskMove(resource, { tool: 'tool:give-a-task', key: 'k3', input: { as: 'ai:north', description: 'Through the tool', key: 'k3' } });
  assert.equal(given.kept, true);
  const [row] = (await db.query('select description from calendar_tasks where id = $1', [given.result.task_id])).rows;
  assert.equal(row.description, 'Through the tool');
  assert.ok(asked.length > 0 && asked.every(name => name === 'tasks-db-connection'));
});

test('a list names `matching` alternatives and the store hands over only the records fitting one; bad names and shapes are refused', async () => {
  const { db, resource } = await database();
  await db.query(`insert into calendar_tasks (id, status, assignees, taken_by, details) values
    ('a', 'To do', '["ai:north"]', null, '{}'), ('b', 'To do', '[]', null, '{"told_as": {"source": "step"}}'),
    ('c', 'To do', '[]', null, '{"told_as": {"source": ""}}'), ('d', 'To do', '["ai:south"]', 'ai:north', '{}'), ('e', 'To do', null, null, '{}')`);
  const ids = async matching => (await resource('@own-records', 'records:list', { type: 'calendar-task', matching })).records.map(row => row.id);
  assert.deepEqual(await ids([{ assignees: { contains: ['ai:north'] } }]), ['a']);
  assert.deepEqual(await ids([{ assignees: { contains: ['ai:north'] } }, { taken_by: { in: ['ai:north'] } }]), ['a', 'd']);
  assert.deepEqual(await ids([{ assignees: { holds: false }, 'told_as.source': { holds: true } }]), ['b']);
  assert.deepEqual(await ids([{ assignees: { holds: false }, 'told_as.source': { holds: false } }]), ['c', 'e']);
  assert.deepEqual(await ids([{ 'told_as.source': { in: ['step'] } }]), ['b']);
  assert.deepEqual(await ids([{}]), ['a', 'b', 'c', 'd', 'e'], 'an empty alternative fits every record');
  assert.deepEqual(await ids([]), [], 'no alternative fits none, and the store is not asked');
  await assert.rejects(ids([{ 'assignees; drop table calendar_tasks': { holds: true } }]), /not a plain table or column name/);
  await assert.rejects(ids([{ taken_by: { contains: ['x'] } }]), /holds text, which contains nothing/);
  await assert.rejects(ids([{ 'taken_by.deeper': { holds: true } }]), /goes into taken_by, which holds text/);
  await assert.rejects(ids([{ assignees: { holds: true, in: [] } }]), /exactly one of in, contains or holds/);
});
