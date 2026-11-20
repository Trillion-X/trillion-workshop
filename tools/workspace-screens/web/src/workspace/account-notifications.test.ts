// The bell's two routes over a real PostgreSQL, each statement run as tool:run-sql-in-my-database runs it, with the
// notices table made by the statement the notice workflows give: no table is no notices; the newest come first with their
// read state; a mark changes only the named notices; an id that is not a notice's is refused before any statement.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { runSql } from '../../../../run-sql-in-my-database/do-work/run-sql.mjs';
import { notificationsAnswers } from './account-notifications.ts';

const fromTheSqlTool = createRequire(new URL('../../../../run-sql-in-my-database/package.json', import.meta.url));
const EmbeddedPostgres = fromTheSqlTool('embedded-postgres').default ?? fromTheSqlTool('embedded-postgres');
let server: any, connection = '', statements = 0;
const run = async (sql: string, params: unknown[]) => { statements += 1; return (await runSql({ connection, input: { sql, params } })).rows; };
const freePort = () => new Promise<number>(resolve => { const probe = net.createServer().listen(0, () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
(globalThis as { location?: unknown }).location = { origin: 'https://door.example.test' };

before(async () => {
  const port = await freePort();
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'notices-')), user: 'postgres', password: 'made-up-pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  connection = `postgresql://postgres:made-up-pw@127.0.0.1:${port}/postgres`;
});
after(async () => { await server?.stop(); });

const answer = notificationsAnswers(run);
const list = () => answer('/work/api/notifications', {});
const mark = (read: boolean, ids: unknown[]) => answer('/work/api/notifications/read', { method: 'POST', body: JSON.stringify({ read, ids }) });

test('no notices table is no notices', async () => {
  assert.deepEqual(await list(), { status: 200, body: { items: [] } });
});

test('the newest notices come first with their words and read state, and a mark changes only those named', async () => {
  // The table as the notice workflows make it (tools/workflows/recipes/check-my-code-against-my-rules.json).
  await run('create table if not exists notices (id bigint generated always as identity primary key, device_id text, title text not null default \'\', body text not null default \'\', url text, made_at timestamptz not null default now(), read_at timestamptz, acted_at timestamptz)', []);
  await run('alter table notices add column if not exists kind text, add column if not exists key text', []);
  await run("insert into notices (title, body, made_at, kind) values ('older', '', now() - interval '1 hour', 'wake-stopped'), ('newer', 'what happened', now(), null)", []);
  const { body } = (await list())!;
  const items = (body as { items: { id: string; title: string; detail: string | null; read: boolean; kind: string; actions: unknown[] }[] }).items;
  assert.deepEqual(items.map(item => [item.title, item.detail, item.read, item.kind]), [['newer', 'what happened', false, 'notice'], ['older', null, false, 'wake-stopped']]);
  assert.deepEqual(items[0].actions, [], 'a notice carries no action, so none is offered');
  assert.deepEqual(await mark(true, [items[1].id]), { status: 200, body: { marked: 1 } });
  const after = ((await list())!.body as { items: { title: string; read: boolean }[] }).items;
  assert.deepEqual(after.map(item => [item.title, item.read]), [['newer', false], ['older', true]]);
  await mark(false, [items[1].id]);
  assert.equal(((await list())!.body as { items: { read: boolean }[] }).items[1].read, false);
});

test('an id that is not one of the notices is refused before any statement, and other addresses are not answered here', async () => {
  statements = 0;
  assert.equal((await mark(true, ['told:1; drop table notices']))!.status, 400);
  assert.equal((await mark(true, []))!.status, 400);
  assert.equal(statements, 0);
  assert.equal(await answer('/work/api/door/tools:list', {}), null);
});
