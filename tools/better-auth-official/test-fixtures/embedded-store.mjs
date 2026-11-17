// A real Postgres for the tests, with no install and no sudo: the embedded-postgres package starts a cluster in a temporary folder on a
// free loopback port. `database()` makes a fresh database in it and returns its connection string, so a test file's processes share
// one store the way the sign-in processes share theirs, and files never see one another's rows.

import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

export async function startStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sign-in-store-'));
  const port = await freePort();
  const cluster = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'tester', password: 'tester', port, persistent: false, onLog: () => {}, onError: () => {} });
  await cluster.initialise();
  await cluster.start();
  let made = 0;
  const pools = [];
  return {
    // A pool a test opened (auth.mjs exports its own), closed before the cluster stops.
    hold(pool) { pools.push(pool); return pool; },
    async database() {
      const name = `store_${++made}`;
      await cluster.createDatabase(name);
      return `postgres://tester:tester@127.0.0.1:${port}/${name}`;
    },
    async stop() {
      await Promise.all(pools.map(pool => pool.end()));
      // pool.end() answers before its sockets are closed, so a shutdown right after it ends connections still closing and the pool
      // reports an error nobody awaits (a crash of the test file under load); wait until the server itself sees no client left.
      const watch = new pg.Client({ host: '127.0.0.1', port, user: 'tester', password: 'tester', database: 'postgres' });
      watch.on('error', () => {});
      await watch.connect();
      for (let tries = 0; tries < 200; tries++) {
        const { rows } = await watch.query("select count(*)::int as n from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()");
        if (rows[0].n === 0) break;
        await new Promise(done => setTimeout(done, 25));
      }
      await watch.end();
      await cluster.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
