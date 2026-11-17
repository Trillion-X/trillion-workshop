// A real Postgres for the tests, with no install and no sudo: the embedded-postgres package starts a cluster in a temporary folder on a
// free loopback port. `database()` makes a fresh database in it and returns its connection string, so a test file's processes share
// one store the way the sign-in processes share theirs, and files never see one another's rows.

import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Every Postgres cluster takes one System V shared memory segment, and macOS allows 32 on the whole computer (kern.sysv.shmmni), shared
// with every other Postgres on it. Test files run in parallel, one cluster each, and past the limit initdb fails with "could not create
// shared memory segment: No space left on device". So a file takes one of a few slots (a folder in the temporary folder, holding its
// process id; a slot whose process is gone is taken over) before it starts its cluster, and the others wait their turn.
const SLOTS = 3;
const slotsDir = join(tmpdir(), 'better-auth-official-store-slots');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function takeSlot() {
  mkdirSync(slotsDir, { recursive: true });
  for (;;) {
    for (let n = 0; n < SLOTS; n++) {
      const slot = join(slotsDir, String(n));
      try {
        mkdirSync(slot);
        writeFileSync(join(slot, 'pid'), String(process.pid));
        return () => rmSync(slot, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let holder;
        try { holder = Number(readFileSync(join(slot, 'pid'), 'utf8')); } catch { holder = undefined; }
        // A slot with no process id yet is being made; it is stale only when it has stayed that way.
        const stale = holder === undefined ? Date.now() - statSync(slot).mtimeMs > 5000 : !alive(holder);
        if (stale) rmSync(slot, { recursive: true, force: true });
      }
    }
    await sleep(100);
  }
}

export async function startStore() {
  const release = await takeSlot();
  const dir = mkdtempSync(join(tmpdir(), 'sign-in-store-'));
  let port;
  let cluster;
  // The slots keep this folder's own files under the limit; another program's clusters may still hold the rest, so a refusal for
  // shared memory waits and tries again.
  for (let tries = 0; ; tries++) {
    port = await freePort();
    cluster = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'tester', password: 'tester', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await cluster.initialise();
      await cluster.start();
      break;
    } catch (error) {
      rmSync(join(dir, 'data'), { recursive: true, force: true });
      if (tries >= 120 || !/shared memory|No space left|Address already in use/.test(String(error?.message))) { release(); throw error; }
      await sleep(500);
    }
  }
  process.once('exit', release);
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
      release();
    },
  };
}
