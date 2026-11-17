// tools/better-auth-official/test/store-cleanup.test.mjs
//
// A test store never outlives its test: a stopped store's server is gone, and the server of a test process that was killed (SIGKILL cannot
// be caught) is stopped by the next store start. Without this, killed test runs left embedded Postgres servers running for hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore, stopOrphanClusters } from '../test-fixtures/embedded-store.mjs';

const clustersDir = join(tmpdir(), 'better-auth-official-store-clusters');
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(done => setTimeout(done, 50)); } return check(); };
const mine = () => readdirSync(clustersDir).filter(name => name.startsWith(`${process.pid}-`));

test('a stopped store leaves no server and no registry file behind', async () => {
  const store = await startStore();
  const [name] = mine();
  const server = Number(name.split('-')[1]);
  assert.ok(running(server));
  await store.stop();
  assert.ok(await until(() => !running(server)), 'the server is gone');
  assert.deepEqual(mine(), []);
});

test('the server of a test process that was killed is stopped by the next start', async () => {
  const code = `import { startStore } from ${JSON.stringify(new URL('../test-fixtures/embedded-store.mjs', import.meta.url).href)}; await startStore(); console.log('up'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(done => child.stdout.once('data', done));
  const name = readdirSync(clustersDir).find(entry => entry.startsWith(`${child.pid}-`));
  const server = Number(name.split('-')[1]);
  assert.ok(running(server));
  child.kill('SIGKILL');
  await new Promise(done => child.once('exit', done));
  stopOrphanClusters();
  assert.ok(await until(() => !running(server)), 'the orphaned server was stopped');
  assert.equal(readdirSync(clustersDir).includes(name), false);
  assert.ok(readFileSync(new URL('../test-fixtures/embedded-store.mjs', import.meta.url), 'utf8').includes("process.once('exit', abandon)"));
});
