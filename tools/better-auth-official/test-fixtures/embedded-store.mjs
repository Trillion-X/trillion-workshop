// A real Postgres for the tests, with no install and no sudo: the embedded-postgres package starts a cluster in a temporary folder on a
// free loopback port. `database()` makes a fresh database in it and returns its connection string, so a test file's processes share
// one store the way the sign-in processes share theirs, and files never see one another's rows.

import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

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
      await cluster.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
