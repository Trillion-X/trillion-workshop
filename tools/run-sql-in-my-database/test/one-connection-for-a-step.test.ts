// A step run shares one database connection: every statement of the run, the dry run and the real commit included, is answered by
// the same server process, and the connection is closed at the end. A real PostgreSQL server in a temp folder.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { runSql } from '../do-work/run-sql.mjs';
import { committer, sharedConnection } from '../../ask-questions-sort-answers-follow-up/steps/serve-steps.ts';

const PORT = 55000 + (process.pid % 900);
const CONNECTION = `postgres://postgres:made-up-admin-pw@127.0.0.1:${PORT}/postgres`;
let server: EmbeddedPostgres;

before(async () => {
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'one-connection-')), user: 'postgres', password: 'made-up-admin-pw', port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
});
after(async () => { await server.stop(); });

test('every statement of a run goes through one server process, and closing ends it', async () => {
  const shared = sharedConnection(CONNECTION);
  const pids = new Set<string>();
  for (let n = 0; n < 4; n += 1) pids.add(String(((await runSql({ connection: CONNECTION, input: { sql: 'select pg_backend_pid() as pid', params: [] }, connect: shared.connect as never })).rows[0] as { pid: number }).pid));
  const commit = committer(CONNECTION, runSql, shared.connect as never);
  await commit([{ sql: 'select 1', params: [] }]);
  pids.add(String(((await runSql({ connection: CONNECTION, input: { sql: 'select pg_backend_pid() as pid', params: [] }, connect: shared.connect as never })).rows[0] as { pid: number }).pid));
  assert.equal(pids.size, 1, 'one server process answered every statement');
  const watcher = new pg.Client({ connectionString: CONNECTION });
  await watcher.connect();
  const open = async () => Number(((await watcher.query("select count(*)::int n from pg_stat_activity where pid = $1", [[...pids][0]])).rows[0] as { n: number }).n);
  assert.equal(await open(), 1);
  await shared.close();
  await new Promise(done => setTimeout(done, 300));
  assert.equal(await open(), 0, 'the connection is closed at the end');
  await watcher.end();
});

test('a refused statement of a committed batch still keeps nothing', async () => {
  const shared = sharedConnection(CONNECTION);
  const commit = committer(CONNECTION, runSql, shared.connect as never);
  await runSql({ connection: CONNECTION, input: { sql: 'create table if not exists t (id int primary key)', params: [] }, connect: shared.connect as never });
  await assert.rejects(commit([{ sql: 'insert into t values (1)', params: [] }, { sql: 'insert into t values (1)', params: [] }]), /Something went wrong/);
  const count = (await runSql({ connection: CONNECTION, input: { sql: 'select count(*)::int n from t', params: [] }, connect: shared.connect as never })).rows[0] as { n: number };
  assert.equal(count.n, 0);
  await shared.close();
});
