// A real Postgres for the tests, with no install and no sudo: the embedded-postgres package starts a cluster in a temporary folder on a
// free loopback port. `database()` makes a fresh database in it and returns its connection string, so a test file's processes share
// one store the way the sign-in processes share theirs, and files never see one another's rows.

import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const freePort = () => new Promise(done => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Every Postgres cluster takes one System V shared memory segment, and the computer allows a fixed number of them in all (macOS
// kern.sysv.shmmni, Linux /proc/sys/kernel/shmmni), shared with every other Postgres on it. Test files run in parallel, one cluster each,
// and past the limit initdb fails with "could not create shared memory segment: No space left on device". So a file queues before it
// starts its cluster: it writes a file named by the time and its process id into the temporary folder (empty until its cluster is
// running, then "started"), and goes when its place in the queue of live processes is within the segments the computer has free, which
// is read at each look: its limit less the segments in use that are not this queue's own started clusters, never below 1. Only a dead
// process's file is deleted, so no two processes race over one file.
const slotsDir = join(tmpdir(), 'better-auth-official-store-queue');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function segments() {
  if (process.platform === 'darwin') {
    const limit = Number(execFileSync('sysctl', ['-n', 'kern.sysv.shmmni'], { encoding: 'utf8' }));
    const inUse = execFileSync('ipcs', ['-m'], { encoding: 'utf8' }).split('\n').filter(line => /^m\s/.test(line)).length;
    return { limit, inUse };
  }
  if (process.platform === 'linux') {
    return { limit: Number(readFileSync('/proc/sys/kernel/shmmni', 'utf8')), inUse: readFileSync('/proc/sysvipc/shm', 'utf8').split('\n').filter(Boolean).length - 1 };
  }
  throw new Error(`no way to read this computer's shared memory limit on ${process.platform}`);
}
async function takeSlot() {
  mkdirSync(slotsDir, { recursive: true });
  const mine = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(slotsDir, mine), '');
  const release = () => rmSync(join(slotsDir, mine), { force: true });
  const started = () => writeFileSync(join(slotsDir, mine), 'started');
  for (;;) {
    const waiting = readdirSync(slotsDir).sort().filter(name => {
      if (alive(Number(name.split('-')[1]))) return true;
      rmSync(join(slotsDir, name), { force: true });
      return false;
    });
    const { limit, inUse } = segments();
    const own = waiting.filter(name => { try { return readFileSync(join(slotsDir, name), 'utf8') === 'started'; } catch { return false; } }).length;
    if (waiting.indexOf(mine) < Math.max(1, limit - (inUse - own))) return { release, started };
    await sleep(100);
  }
}

// A cluster must not outlive the test that started it, even when the test process fails or is killed. Each live cluster is a file here named by
// its owner's process id and its server's, holding its folder. The owner stops its own server on exit and on SIGTERM or SIGINT; a start first
// stops the server of any owner that is gone (a SIGKILL cannot be caught), so no cluster is left running past the next test start.
const clustersDir = join(tmpdir(), 'better-auth-official-store-clusters');
const isPostgres = pid => { try { return /postgres/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })); } catch { return false; } };
const stopServer = pid => { if (isPostgres(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } } };
export function stopOrphanClusters() {
  mkdirSync(clustersDir, { recursive: true });
  for (const name of readdirSync(clustersDir)) {
    const [owner, server] = name.split('-').map(Number);
    if (alive(owner)) continue;
    stopServer(server);
    const folder = readFileSync(join(clustersDir, name), 'utf8');
    rmSync(join(clustersDir, name), { force: true });
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
}

export async function startStore() {
  stopOrphanClusters();
  const { release, started } = await takeSlot();
  const dir = mkdtempSync(join(tmpdir(), 'sign-in-store-'));
  let port;
  let cluster;
  // The slots keep this folder's own files under the limit; another program's clusters may still hold the rest, so a cluster that does
  // not start (its start gives no reason when the server dies at once: no shared memory, or a port taken since it was found) waits and
  // tries again.
  for (let tries = 0; ; tries++) {
    port = await freePort();
    cluster = new EmbeddedPostgres({ databaseDir: join(dir, 'data'), user: 'tester', password: 'tester', port, persistent: false, onLog: () => {}, onError: () => {} });
    try {
      await cluster.initialise();
      await cluster.start();
      break;
    } catch (error) {
      rmSync(join(dir, 'data'), { recursive: true, force: true });
      if (tries >= 120) { release(); throw error ?? new Error('the Postgres cluster did not start (no reason given)'); }
      await sleep(500);
    }
  }
  started();
  const server = Number(readFileSync(join(dir, 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
  const registered = join(clustersDir, `${process.pid}-${server}`);
  writeFileSync(registered, dir);
  const abandon = () => { stopServer(server); release(); };
  process.once('exit', abandon);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { abandon(); process.exit(128 + (signal === 'SIGTERM' ? 15 : 2)); });
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
      process.removeListener('exit', abandon);
      rmSync(registered, { force: true });
      rmSync(dir, { recursive: true, force: true });
      release();
    },
  };
}
