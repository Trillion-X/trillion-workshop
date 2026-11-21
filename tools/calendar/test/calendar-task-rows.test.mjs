// The Calendar's task rows against a real PostgreSQL: the signed-in person's rows are found by assignee or sender, AI rows
// stay out, a typed task is kept assigned and sent by him, and no token with no subject reads anything.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { runSql } from '../../run-sql-in-my-database/do-work/run-sql.mjs';
import { createTaskQuery, personOfToken, personTasksQuery, taskOfRow } from '../web/src/workspace/calendar-task-rows.mjs';

const fromTheSqlTool = createRequire(new URL('../../run-sql-in-my-database/package.json', import.meta.url));
const EmbeddedPostgres = fromTheSqlTool('embedded-postgres').default ?? fromTheSqlTool('embedded-postgres');
const owners = JSON.parse(readFileSync(new URL('../web/src/workspace/calendar-owners.json', import.meta.url), 'utf8'));
const owner = owners.tasks;

// A made-up subject for the stand-in pass; no real person's id appears in this file.
const PERSON = 'made-up-subject-7';
const OTHER = 'made-up-subject-8';

let server, connection = '';
const run = async (sql, params) => (await runSql({ connection, input: { sql, params } })).rows;
const freePort = () => new Promise(resolve => { const probe = net.createServer().listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const jwt = payload => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

before(async () => {
  const port = await freePort();
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'calendar-task-rows-')), user: 'postgres', password: 'made-up-pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  connection = `postgresql://postgres:made-up-pw@127.0.0.1:${port}/postgres`;
  // The columns the screen reads and writes, with the owner's types (starts_at and due are dates in the owner's table).
  await run(`create table public.calendar_tasks (id text primary key, title text, description text, priority text, labels jsonb,
    duration_minutes numeric, minimum_duration_minutes numeric, due date, starts_at date, ends_at date, status text,
    collection_id jsonb, parent_id jsonb, manual_order text, source_id text, made_at timestamptz, changed_at timestamptz,
    smart_list text, assignees jsonb, sent_by text)`, []);
  const row = (id, fields) => run(`insert into public.calendar_tasks (id, title, status, made_at, assignees, sent_by) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [id, id, fields.status ?? 'To do', fields.made_at, JSON.stringify(fields.assignees ?? []), fields.sent_by ?? null]);
  await row('for-him-assigned', { assignees: [PERSON], sent_by: 'ai:turn-judge', made_at: '2026-11-21T10:00:00Z' });
  await row('for-him-sent', { sent_by: PERSON, made_at: '2026-11-21T11:00:00Z' });
  await row('ai-row', { sent_by: 'ai:turn-judge', made_at: '2026-11-21T12:00:00Z' });
  await row('other-person', { assignees: [OTHER], made_at: '2026-11-21T12:30:00Z' });
  await row('done-for-him', { assignees: [PERSON], status: 'Done', made_at: '2026-11-21T13:00:00Z' });
});
after(async () => { await server?.stop(); });

test('a token with a subject names its person; an opaque token or one with no subject names none', () => {
  assert.equal(personOfToken(jwt({ sub: PERSON, exp: 1 })), PERSON);
  assert.equal(personOfToken(jwt({ exp: 1 })), null);
  assert.equal(personOfToken('opaque-token-without-dots'), null);
  assert.equal(personOfToken(null), null);
});

test('the person sees the rows he is assigned or sent, not AI rows or other people, not done ones', async () => {
  const query = personTasksQuery(owner, PERSON);
  const ids = (await run(query.sql, query.params)).map(row => row.id).sort();
  assert.deepEqual(ids, ['for-him-assigned', 'for-him-sent']);
});

test('a task he types is kept assigned and sent by him, and the list shows it at once', async () => {
  const id = 'record:calendar-task:made-up-new-task';
  const write = createTaskQuery(owner, PERSON, { title: 'Call the made-up bakery', duration_minutes: 30 }, id, '2026-11-21T14:00:00.000Z');
  const [written] = await run(write.sql, write.params);
  const task = taskOfRow(written, owner);
  assert.equal(task.title, 'Call the made-up bakery');
  assert.deepEqual(task.assignees, [PERSON]);
  assert.equal(task.sent_by, PERSON);
  assert.equal(task.status, 'To do');
  assert.equal(task.duration_minutes, 30);
  const query = personTasksQuery(owner, PERSON);
  const ids = (await run(query.sql, query.params)).map(row => row.id);
  assert.ok(ids.includes(id), 'the new task is in his list');
  assert.equal(ids[0], id, 'and newest first');
});

test('the list is limited to the owner JSON limit and carries its timeout', () => {
  const query = personTasksQuery(owner, PERSON);
  assert.equal(query.params.at(-1), owner.most_tasks);
  assert.equal(owners.tasks.statement_timeout_ms, 5000);
});
