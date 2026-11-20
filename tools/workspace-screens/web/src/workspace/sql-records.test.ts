// The SQL records transport against a real PostgreSQL, each statement run as tool:run-sql-in-my-database runs it (its own
// runSql: one prepared statement on its own connection), on a server started with that tool's own test packages
// (embedded-postgres in a temp folder). Nothing saved reads as
// nothing held, the first write makes the table, a write is read back with the identity the engine computes, a stale or
// already-taken expectation changes nothing and answers the value held, and the source's outbox confirms through it.
import { tempFolder } from '../../../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';

import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { createRequire } from 'node:module';
import { runSql } from '../../../../run-sql-in-my-database/do-work/run-sql.mjs';

const fromTheSqlTool = createRequire(new URL('../../../../run-sql-in-my-database/package.json', import.meta.url));
const EmbeddedPostgres = fromTheSqlTool('embedded-postgres').default ?? fromTheSqlTool('embedded-postgres');
const pg = fromTheSqlTool('pg');
import { identityOf, remoteRecordsSource } from './records-source.ts';
import { sqlRecordsTransport } from './sql-records.ts';

let server: any, client: any, connection = '';
const statements: string[] = [];
const run = async (sql: string, params: unknown[]) => { statements.push(sql.split(' ')[0]); return (await runSql({ connection, input: { sql, params } })).rows; };
const freePort = () => new Promise<number>(resolve => { const probe = net.createServer().listen(0, () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });

before(async () => {
  const port = await freePort();
  server = new EmbeddedPostgres({ databaseDir: tempFolder(join(tmpdir(), 'sql-records-')), user: 'postgres', password: 'made-up-pw', port, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  client = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'made-up-pw', database: 'postgres' });
  await client.connect();
  connection = `postgresql://postgres:made-up-pw@127.0.0.1:${port}/postgres`;
});
after(async () => { await client?.end(); await server?.stop(); });

const RETRY = { first_ms: 40, most_ms: 100 };
const LAYOUT = { panes: [{ tabs: ['tool:a', 'tool:b'] }], wide: 0.5, 'z-last': true, a: 1 };

test('a read before anything is saved answers nothing held and makes no table', async () => {
  const transport = sqlRecordsTransport(run, 'workspace_records', RETRY);
  assert.deepEqual(await transport.read(['screen-arrangement-layout-state']), { records: {} });
  assert.equal((await client.query("select to_regclass('workspace_records') as t")).rows[0].t, null);
  statements.length = 0;
  assert.deepEqual(await transport.read(['sidebar']), { records: {} });
  assert.deepEqual(statements, [], 'a page that found no table does not ask again');
  await client.query('create table workspace_records (label text primary key, value text not null, identity text not null, changed_at timestamptz not null default now())');
  await client.query(`insert into workspace_records values ('sidebar', '"left"', 'x')`);
  assert.deepEqual(await transport.read(['sidebar'], { fresh: true }), { records: { sidebar: 'left' } }, 'a fresh read asks the database');
  await client.query('drop table workspace_records');
});

test('the first write makes the table; a read answers the value and identity as written', async () => {
  const transport = sqlRecordsTransport(run, 'workspace_records', RETRY);
  assert.deepEqual(await transport.write({ writes: [{ address_label: 'layout', payload: LAYOUT, expected_identity: null }] }), { written: 1 });
  const { records } = await transport.read(['layout', 'other']);
  assert.deepEqual(records, { layout: LAYOUT });
  assert.equal(JSON.stringify(records!.layout), JSON.stringify(LAYOUT), 'the same bytes, keys in the order written');
  assert.equal(identityOf(records!.layout), identityOf(LAYOUT));
});

test('an expectation that no longer holds changes nothing and answers the value held', async () => {
  const transport = sqlRecordsTransport(run, 'workspace_records', RETRY);
  const next = { ...LAYOUT, wide: 0.7 };
  assert.deepEqual(await transport.write({ writes: [{ address_label: 'layout', payload: next, expected_identity: identityOf(LAYOUT) }] }), { written: 1 });
  const stale = await transport.write({ writes: [{ address_label: 'layout', payload: { lost: true }, expected_identity: identityOf(LAYOUT) }] });
  assert.deepEqual(stale, { written: 0, conflicts: [{ address: 'layout', current: { found: true, value: next } }] });
  const taken = await transport.write({ writes: [{ address_label: 'layout', payload: { lost: true }, expected_identity: null }] });
  assert.deepEqual(taken.conflicts, [{ address: 'layout', current: { found: true, value: next } }]);
  const missing = await transport.write({ writes: [{ address_label: 'gone', payload: 1, expected_identity: identityOf(0) }] });
  assert.deepEqual(missing.conflicts, [{ address: 'gone', current: { found: false } }]);
  assert.deepEqual((await transport.read(['layout'])).records, { layout: next });
});

test('a write with no expectation replaces, and the table is made once per page', async () => {
  statements.length = 0;
  const transport = sqlRecordsTransport(run, 'workspace_records', RETRY);
  await transport.write({ writes: [{ address_label: 'a', payload: [1] }] });
  await transport.write({ writes: [{ address_label: 'a', payload: [2] }, { address_label: 'b', payload: 'x' }] });
  assert.deepEqual((await transport.read(['a', 'b'])).records, { a: [2], b: 'x' });
  assert.equal(statements.filter(word => word === 'create').length, 1);
});

test("the source's outbox confirms a write through the database", async () => {
  const source = remoteRecordsSource(sqlRecordsTransport(run, 'workspace_records', RETRY));
  const accepted = new Promise(resolve => source.outbox.onAccepted((_writes, result) => resolve(result)));
  source.outbox.send({ key: 'k', path: 'records', body: { writes: [{ address_label: 'sent', payload: { ok: 1 } }] } });
  assert.deepEqual(await accepted, { written: 1 });
  assert.deepEqual((await source.read(['sent'])).records, { sent: { ok: 1 } });
});

test('after a failed write the next waits, doubling to the most, and a written batch ends the wait', async () => {
  let fail = true, asked = 0;
  const flaky = sqlRecordsTransport(async (sql, params) => { asked += 1; if (fail) throw new Error('could not reach the database'); return run(sql, params); }, 'paced_records', RETRY);
  const timed = async () => { const at = performance.now(); await flaky.write({ writes: [{ address_label: 'a', payload: 1 }] }).catch(() => {}); return performance.now() - at; };
  assert.ok(await timed() < 30, 'the first write does not wait');
  assert.ok(await timed() >= 38, 'after one failure: first_ms');
  assert.ok(await timed() >= 78, 'after two: doubled');
  const most = await timed();
  assert.ok(most >= 98 && most < 160, `never more than most_ms (${most})`);
  assert.equal(asked, 4, 'one attempt per write, never a loop');
  fail = false;
  await flaky.write({ writes: [{ address_label: 'a', payload: 1 }] });
  assert.ok(await timed() < 30, 'a written batch ends the wait');
});

test('a table name that is not a plain name is refused before any statement', () => {
  assert.throws(() => sqlRecordsTransport(run, 'records; drop table x', RETRY), /not a plain table name/);
});
