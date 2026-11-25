// A step run shares one database connection, and its writes are one statement. Every statement of a run goes through the same
// server process, closing ends it, and a refused part of a write keeps nothing. A real PostgreSQL server in a temp folder.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runSql } from '../do-work/run-sql.mjs';
import { sharedConnection } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';
import { sqlStore } from '../../ask-questions-sort-answers-follow-up/steps/store.ts';

const PORT = 55000 + (process.pid % 900);
const CONNECTION = `postgres://postgres:made-up-admin-pw@127.0.0.1:${PORT}/postgres`;
let server: EmbeddedPostgres;

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'one-connection-')), user: 'postgres', password: 'made-up-admin-pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
});
after(async () => { await server.stop(); });

const executeOn = (shared: ReturnType<typeof sharedConnection>) => async (sql: string, params: unknown[] = []) => (await runSql({ connection: CONNECTION, input: { sql, params }, connect: shared.connect as never })).rows as Record<string, unknown>[];

test('every statement of a run goes through one server process, and closing ends it', async () => {
  const shared = sharedConnection(CONNECTION);
  const execute = executeOn(shared);
  const pids = new Set<string>();
  for (let n = 0; n < 5; n += 1) pids.add(String((await execute('select pg_backend_pid() as pid'))[0].pid));
  assert.equal(pids.size, 1, 'one server process answered every statement');
  const watcher = new pg.Client({ connectionString: CONNECTION });
  await watcher.connect();
  const open = async () => Number(((await watcher.query('select count(*)::int n from pg_stat_activity where pid = $1', [[...pids][0]])).rows[0] as { n: number }).n);
  assert.equal(await open(), 1);
  await shared.close();
  await new Promise(done => setTimeout(done, 300));
  assert.equal(await open(), 0, 'the connection is closed at the end');
  await watcher.end();
});

test('a step\'s writes are one statement: all kept together, and a refused part keeps nothing', async () => {
  const shared = sharedConnection(CONNECTION);
  const execute = executeOn(shared);
  await execute('create table form_rows (id text primary key, type text not null, value jsonb not null, kept_at timestamptz not null default now())');
  const store = sqlStore({ execute });
  await store.apply([{ kind: 'insert', id: 'a', type: 't', value: { n: 1 } }, { kind: 'upsert', id: 'b', type: 't', value: { n: 2 } }]);
  assert.equal(Number((await execute('select count(*)::int n from form_rows'))[0].n), 2);
  await assert.rejects(store.apply([{ kind: 'insert', id: 'c', type: 't', value: {} }, { kind: 'insert', id: 'a', type: 't', value: {} }]), /Something went wrong/);
  assert.equal(Number((await execute("select count(*)::int n from form_rows where id = 'c'"))[0].n), 0, 'the part before the refused one is not kept');
  await store.apply([{ kind: 'merge', id: 'a', changes: { m: 3 } }, { kind: 'delete', id: 'b' }]);
  assert.deepEqual((await execute('select id, value from form_rows order by id')).map(row => [row.id, row.value]), [['a', { n: 1, m: 3 }]]);
  await shared.close();
});
