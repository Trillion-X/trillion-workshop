// The task commands over a database whose tables keep the tasks (command.json `tasks.store`): `--store NAME` names the held
// connection once and is kept for the next command, every read and write is one run of the SQL tool with that name, and
// give, take, hand-on to a person, that person's take and who-can-take answer from the table rows.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import settings from '../do-work/command.json' with { type: 'json' };
import { main, speakFor, stateOf } from '../do-work/command.mjs';
import { taskRowRun } from '../test-fixtures/task-records.mjs';

speakFor({ cli: 'example', site_name: 'Example' });
const KEY = `nm_${'ab'.repeat(32)}`;
const SQL_TOOL = 'tool:run-sql-in-my-database';

async function tableDoor(db) {
  const calls = [];
  const runRow = taskRowRun();
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: 'fake' }, _meta: { [settings.engine.account_meta]: { account_id: 'f'.repeat(64) } } };
    else {
      const args = message.params.arguments;
      calls.push(args);
      let answer;
      if (args.method !== 'tools:run') answer = { refused: `No ${args.method} at ${args.address}: this account keeps no records door.` };
      else if (args.input.tool === SQL_TOOL) answer = { exit_code: 0, result: { rows: (await db.query(args.input.input.sql, args.input.input.params)).rows } };
      else answer = await runRow(args.input);
      result = answer.refused ? { isError: true, content: [{ type: 'text', text: answer.refused }] } : { content: [{ type: 'text', text: JSON.stringify(answer) }], structuredContent: answer };
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { mcp: `http://127.0.0.1:${server.address().port}/mcp`, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

test('--store names the database once; give, take, hand-on, the person\'s take and who-can-take run on its table rows', async () => {
  const db = new PGlite();
  await db.exec(`create table calendar_tasks (id text primary key, title text, description text, status text, priority text, assignees jsonb,
    sent_by text, sent_at text, taken_by text, taken_at text, finished_by text, finished_at text, outcome text, result text, summary text,
    details jsonb, made_at timestamptz, changed_at timestamptz);
    create table users (id text primary key, name text, kind text, can jsonb, live jsonb, details jsonb);
    insert into users (id, name, kind, can) values ('person:someone', 'Someone', 'person', '["any"]');`);
  const door = await tableDoor(db);
  try {
    const folder = mkdtempSync(join(tmpdir(), 'example-cli-tables-'));
    const seams = () => ({ store: { read: () => KEY, where: 'test key' }, grants: { where: 'none', read: () => null, write: () => {}, forget: () => {} }, state: stateOf({ home: folder }),
      env: { CLAUDECODE: '1' }, place: () => ({ repository: 'example', branch: 'main' }), localDoor: () => door.mcp, agentSocket: () => null, computerName: 'Mac', model: null, wait: async () => {} });
    assert.match(await main(['give', 'Fix', 'the', 'build', '--key', 'k1', '--store', 'tasks-db-connection'], seams()), /^Gave record:calendar-task:k1\./);
    assert.equal(seams().state.tasksStore(), 'tasks-db-connection', 'the store named once is kept for the next command');
    let [row] = (await db.query(`select status, sent_by from calendar_tasks where id = 'record:calendar-task:k1'`)).rows;
    assert.equal(row.status, 'To do');
    assert.match(await main(['take'], seams()), /^Took record:calendar-task:k1\./);
    assert.match(await main(['hand-on', 'record:calendar-task:k1', '--to', 'person:someone', '--because', 'Yours now'], seams()), /^record:calendar-task:k1: In progress -> To do\./);
    [row] = (await db.query(`select assignees, taken_by from calendar_tasks where id = 'record:calendar-task:k1'`)).rows;
    assert.deepEqual([row.assignees, row.taken_by], [['person:someone'], null]);
    assert.match(await main(['take', 'record:calendar-task:k1', '--as', 'person:someone'], seams()), /^Took record:calendar-task:k1\./);
    for (const key of ['k2', 'k3', 'k4']) await main(['give', `Task ${key}`, '--key', key], seams());
    const before = door.calls.length;
    const listed = JSON.parse(await main(['tasks', '--limit', '2', '--json'], seams()));
    assert.deepEqual(listed.tasks.map(one => one.id), ['record:calendar-task:k4', 'record:calendar-task:k3'], 'the newest first');
    assert.equal(listed.more, true);
    const lists = door.calls.slice(before).filter(call => call.input?.tool === SQL_TOOL && /from calendar_tasks/.test(call.input.input.sql) && /order by sent_at desc/.test(call.input.input.sql));
    assert.equal(lists.length, 1, 'a listing is one statement that asks the table for the newest only');
    assert.equal(lists[0].input.input.params.at(-1), 3, 'it asks for one more than it shows');
    const who = JSON.parse(await main(['who-can-take', '--json'], seams()));
    assert.equal(who.who.find(one => one.id === 'person:someone')?.busy, 1, 'who-can-take reads the users table and counts what each holds');
    const sql = door.calls.filter(call => call.input?.tool === SQL_TOOL);
    assert.ok(sql.length > 0 && sql.every(call => call.input.input.credential_name === 'tasks-db-connection'));
    assert.ok(!door.calls.some(call => call.address === '@own-records'), 'nothing went to a records door');
  } finally { await door.close(); }
});
