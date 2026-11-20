// test/serve-task-pages.test.mjs
//
// The task pages' kept session (do-work/serve-task-pages.mjs) over two real Postgres databases (PGlite): `pursuits` reads
// task_pages from the pages database, `data` joins the chosen pursuits' pages, each database is opened once and only for a
// pursuit it holds, a call naming other databases than the session's is refused, and the MCP lines answer as the engine's
// calls expect (initialize, tools/list, tools/call with structuredContent, a failure as isError).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { answer, taskPagesSession } from '../do-work/serve-task-pages.mjs';

const TASK_TABLES = `create table calendar_tasks (id text primary key, title text, plain_title text, plain_detail text, parent_id jsonb, status text,
    waiting_on text, made_at timestamptz, changed_at timestamptz, assignees jsonb, taken_by text);
  create table task_changes (id serial primary key, task_id text, at text, kind text, status text, title text);
  create table task_statuses (name text, mark text, tone text, counts_as_done boolean, closed boolean, place int);
  create table task_shows (task_id text, ref text, label text, made_at text);
  create table task_facts (id serial primary key, task_id text, kind text, said text, number numeric, of_number numeric, at text);
  create table task_fact_kinds (name text, label text, place int, tone text);
  insert into task_statuses values ('Done', 'done', null, true, true, 1), ('To do', 'todo', null, false, false, 2);`;

async function databases() {
  const runs = new PGlite(), garden = new PGlite();
  await runs.exec(`${TASK_TABLES}
    create table task_pages (pursuit text, label text, database text, connection_name text, tables jsonb, place int);
    insert into task_pages values ('bakery', 'Bakery', 'runs_it', null, '{}', 1), ('garden', 'Garden', null, 'garden_it-connection', '{}', 2),
      ('elsewhere', 'Not held', 'not_held', null, '{}', 3);
    insert into calendar_tasks (id, title, status, made_at, assignees, taken_by) values ('t1', 'Build it', 'To do', now(), '["ai:north"]', 'ai:north');
    insert into task_changes (task_id, at, kind, status) values ('t1', '2026-11-19T20:00:00Z', 'made', 'To do');`);
  await garden.exec(`${TASK_TABLES}
    insert into calendar_tasks (id, title, status, made_at) values ('e1', 'Plant beans', 'Done', now());
    insert into task_changes (task_id, at, kind, status) values ('e1', '2026-11-19T19:00:00Z', 'made', 'Done');`);
  const opened = [];
  const held = { runs_it: runs, garden_it: garden };
  const open = async (database, index) => { opened.push([database, index]); return { query: text => held[database].query(text) }; };
  return { open, opened };
}

const dbs = [{ database: 'runs_it' }, { database: 'garden_it' }];

test('pursuits are the task_pages rows whose database the session holds, in their place; data joins the chosen pages', async () => {
  const { open, opened } = await databases();
  const session = taskPagesSession({ open });
  assert.deepEqual(await session.pursuits({ dbs, pages_database: 'runs_it' }), [{ id: 'bakery', label: 'Bakery' }, { id: 'garden', label: 'Garden' }]);
  const both = await session.data({ dbs, pages_database: 'runs_it', p: ['bakery', 'garden', 'elsewhere'] });
  assert.deepEqual(both.tasks.map(task => task.id).sort(), ['e1', 't1']);
  assert.deepEqual(both.changes.map(change => change.task), ['e1', 't1'], 'changes in time order across pursuits');
  assert.deepEqual(both.statuses.map(status => status.name), ['Done', 'To do'], 'each status once');
  assert.deepEqual([both.tasks.find(task => task.id === 't1').assignees, both.tasks.find(task => task.id === 't1').taken_by], [['ai:north'], 'ai:north']);
  await session.data({ dbs, pages_database: 'runs_it', p: ['bakery'] });
  assert.deepEqual(opened, [['runs_it', 0], ['garden_it', 1]], 'each database opened once, element i on its own descriptor');
});

test('a call naming other databases, a bad name, or a database the session was not started with is refused', async () => {
  const { open } = await databases();
  const session = taskPagesSession({ open });
  await session.pursuits({ dbs, pages_database: 'runs_it' });
  await assert.rejects(session.pursuits({ dbs: [{ database: 'runs_it' }], pages_database: 'runs_it' }), /started with/);
  await assert.rejects(taskPagesSession({ open }).pursuits({ dbs: [{ database: 'x; drop' }], pages_database: 'x' }), /plain database name/);
  await assert.rejects(taskPagesSession({ open }).pursuits({ dbs, pages_database: 'not_held' }), /not one of the databases/);
});

test('the MCP lines: initialize, tools/list, a call answered with structuredContent, a failure as isError', async () => {
  const { open } = await databases();
  const session = taskPagesSession({ open });
  assert.equal((await answer(session, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result.serverInfo.name, 'serve-the-task-pages');
  assert.equal(await answer(session, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await answer(session, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map(tool => tool.name), ['pursuits', 'data']);
  const listed = await answer(session, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pursuits', arguments: { dbs, pages_database: 'runs_it' } } });
  assert.deepEqual(listed.result.structuredContent.items.map(item => item.id), ['bakery', 'garden']);
  const failed = await answer(session, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'data', arguments: { dbs, pages_database: 'runs_it' } } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /p is the list/);
});
