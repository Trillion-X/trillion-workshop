// test/read-this-computer.test.mjs
// One runner reads a computer for the person's Trillion (computer/read-this-computer.mjs): only one program on the
// computer reads at a time, every program reports under the computer's one id, and the helper starts it beside its
// connection as one of its handlers (wake-sessions.json `handlers`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { holdReading, reachOf, programOf, releaseReading, computerIdOf, startReading, fileKeeper, rowsOf, adoptProgress } from '../../run-on-a-persons-computer/read-this-computer.mjs';
import { startHandlers, loadHandlers, settings } from '../harness/wake-sessions.mjs';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'read-this-computer-'));

// A failed startup assertion must not leave a perpetual reader holding the test
// runner open. Normal lifetime checks still stop it through SIGTERM below.
const stopFixtureChild = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
};

test('source reading keeps its existing delay and stopping retires its timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const shared = folder(), calls = [];
  const reader = startReading({
    rows: { sources: [], every_seconds: 600, read_every_seconds: 30, files_folder: '/Files', pace: rowsOf().pace },
    account: async () => { calls.push('account'); return { status: 200, body: { services: [] } }; },
    keep: async () => ({}), shared, timers: true, log: () => {},
    keepers: { look: () => calls.push('keepers') },
    listener: { look: () => calls.push('listener') },
    offer: () => calls.push('offer'),
    look: async () => { calls.push('sources'); return { sources: [], browser_sites: [] }; },
  });
  t.after(() => { reader.stop(); fs.rmSync(shared, { recursive: true, force: true }); });
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(shared, 'reading.lock')), false);
  t.mock.timers.tick(4_999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(calls, ['keepers', 'listener']);
  assert.equal(fs.existsSync(path.join(shared, 'reading.lock')), true);
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.ok(calls.includes('sources'));
  reader.stop();
  const stopped = calls.slice();
  t.mock.timers.tick(600_000);
  assert.deepEqual(calls, stopped, 'stopping retires the existing timers');
});

test('a one-look reader does not start background programs', async () => {
  const shared = folder(), calls = [];
  const reader = startReading({ rows: { sources: [], every_seconds: 600, read_every_seconds: 30, files_folder: '/Files' },
    account: async () => null, keep: async () => ({}), shared, timers: false, log: () => {},
    keepers: { look: () => calls.push('keepers') },
    listener: { look: () => calls.push('listener') }, offer: () => calls.push('offer'),
  });
  try { assert.deepEqual(calls, []); }
  finally { reader.stop(); fs.rmSync(shared, { recursive: true, force: true }); }
});

test('only one live program holds the reading, and a dead holder gives it up', async () => {
  const lock = path.join(folder(), 'reading.lock');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  assert.equal(holdReading(lock, other.pid), true);
  assert.equal(holdReading(lock), false, 'a live holder keeps it');
  other.kill();
  await new Promise(done => other.on('exit', done));
  assert.equal(holdReading(lock), true, 'a holder that died gives it up');
  assert.equal(holdReading(lock), true, 'the holder keeps holding');
  releaseReading(lock);
  assert.equal(fs.existsSync(lock), false);
});

test('a program named first in readers_first is handed the reading by the holder, only between its reads', async () => {
  const lock = path.join(folder(), 'reading.lock');
  const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const first = ['Trillion'];
  assert.equal(holdReading(lock, process.pid, { program: 'node', first }), true, 'the helper reads first');
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first }), false, 'the app asks and waits');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).wanted_by, app.pid);
  assert.equal(holdReading(lock, process.pid, { program: 'node', first, busy: true }), true, 'mid-read the helper keeps it');
  assert.equal(holdReading(lock, process.pid, { program: 'node', first }), false, 'between reads it hands it over');
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first }), true, 'the app reads');
  assert.equal(holdReading(lock, process.pid, { program: 'node', first }), false, 'the helper never takes it back from the app');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).wanted_by, undefined, 'a later program never asks a program named first');
  app.kill();
  await new Promise(done => app.on('exit', done));
  assert.equal(holdReading(lock, process.pid, { program: 'node', first }), true, 'once the app is gone the helper reads again');
  releaseReading(lock);
});

test('a program that can open more of the switched places is handed the reading, whatever readers_first says', async () => {
  const lock = path.join(folder(), 'reading.lock');
  const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  const first = ['Trillion'];
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first, reach: 0 }), true, 'the app, not switched on, holds it');
  assert.equal(holdReading(lock, process.pid, { program: 'node', first, reach: 2 }), false, 'the helper that can open the places asks');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).wanted_reach, 2);
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first, reach: 0 }), false, 'between reads the app hands it over');
  assert.equal(holdReading(lock, process.pid, { program: 'node', first, reach: 2 }), true, 'the helper reads');
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first, reach: 0 }), false, 'the app never takes it back while it can open less');
  assert.equal(holdReading(lock, app.pid, { program: 'Trillion', first, reach: 2 }), false, 'switched on, the app asks again, named first');
  assert.equal(holdReading(lock, process.pid, { program: 'node', first, reach: 2 }), false, 'and is handed it');
  app.kill();
  await new Promise(done => app.on('exit', done));
  releaseReading(lock);
});

test('what a reader can open is measured on the places a switch guards', () => {
  const home = folder();
  fs.mkdirSync(path.join(home, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Notes', 'store.db'), '');
  const rows = { sources: [
    { id: 'a', gate: 'full-disk-access', read: { store: '~/Notes/store.db' } },
    { id: 'b', gate: 'full-disk-access', read: { store: '~/Missing/store.db' } },
    { id: 'c', read: { store: '~/Notes/store.db' } },
  ] };
  assert.equal(reachOf(rows, home), 1);
});

test('a reader is listed as the app whose bundle carries its runtime, else as the runtime itself', () => {
  assert.equal(programOf('/Applications/Trillion.app/Contents/MacOS/node'), 'Trillion');
  assert.equal(programOf('/opt/homebrew/Cellar/node/25.3.0/bin/node'), 'node');
});

test('reader fixture cleanup awaits its child even when the startup assertion fails', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => stopFixtureChild(child));
  await once(child, 'spawn');
  await assert.rejects(async () => {
    try { assert.fail('fixture startup lock is not ready'); }
    finally { await stopFixtureChild(child); }
  }, /fixture startup lock is not ready/);
  assert.equal(child.signalCode, 'SIGKILL');
  await stopFixtureChild(child); // A later cleanup is harmless once it has exited.
});

test('the reader keeps reading as a child until the program that started it stops it, then gives the lock back', async t => {
  // A home of its own: the child finds none of this computer's places, so it opens nothing on the screen.
  const shared = folder();
  const child = spawn(process.execPath, ['--no-warnings', new URL('../../run-on-a-persons-computer/read-this-computer.mjs', import.meta.url).pathname, '--keep-reading', '--shared', shared, '--state', folder()], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, HOME: folder(), TRILLION_ORIGIN: 'http://127.0.0.1:9' } });
  t.after(() => stopFixtureChild(child));
  child.stdin.end('nm_test-key');
  // Its first read is 5 seconds after it starts; wait for the lock it takes then, up to 20 seconds.
  const file = path.join(shared, 'reading.lock');
  for (const until = Date.now() + 20_000; !fs.existsSync(file) && Date.now() < until;) await new Promise(done => setTimeout(done, 250));
  assert.equal(child.exitCode, null, 'it is still running');
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([lock.pid, lock.program], [child.pid, programOf(process.execPath)]);
  child.kill('SIGTERM');
  assert.equal(await new Promise(done => child.on('exit', done)), 0);
  assert.equal(fs.existsSync(path.join(shared, 'reading.lock')), false);
});

test('the computer keeps one id, seeded from an earlier record so it stays one row on Connections', () => {
  const file = path.join(folder(), 'computer.json');
  assert.equal(computerIdOf(file, 'earlier-id'), 'earlier-id');
  assert.equal(computerIdOf(file, 'another'), 'earlier-id');
});

test('a program\'s earlier progress is handed to the shared folder once, never over what is already there', () => {
  const from = folder(), to = path.join(folder(), 'shared');
  fs.writeFileSync(path.join(from, 'written-elsewhere.json'), '{"Apple Notes":{"sent":{"n":"k"}}}');
  fs.writeFileSync(path.join(from, 'computer-sources.json'), '{"computer_id":"mac-1"}');
  assert.deepEqual(adoptProgress(from, to), ['written-elsewhere.json', 'computer-sources.json']);
  fs.writeFileSync(path.join(from, 'written-elsewhere.json'), '{"changed":true}');
  assert.deepEqual(adoptProgress(from, to), []);
  assert.match(fs.readFileSync(path.join(to, 'written-elsewhere.json'), 'utf8'), /Apple Notes/);
  const reader = startReading({ rows: rowsOf(), account: async () => null, keep: async () => ({}), shared: to, timers: false, log: () => {} });
  assert.equal(reader.status().found.computer_id, 'mac-1', 'the computer keeps the id it was known by');
});

test('the rows are one list: every place the helper reads is a place it looks for', () => {
  const rows = rowsOf();
  assert.ok(rows.read_every_seconds > 0 && rows.origin.startsWith('https://') && rows.keychain_item && rows.every_seconds > 0 && rows.files_folder.startsWith('/'));
  assert.ok(rows.sources.filter(row => row.read).every(row => row.look && row.read.route && row.read.reader));
  assert.match(rows.gates['full-disk-access'].steps.join(' '), /\{program\}/);
});

test('the reader sends new items and its report while it holds the reading, and nothing while another program does', async () => {
  const shared = folder(), state = folder();
  const sent = [];
  const account = async (route, { method = 'GET', body } = {}) => {
    if (method === 'GET') return { status: 200, body: { services: [] } };
    sent.push([route, body]);
    return { status: 200, body: { message_id: 'm' } };
  };
  const rows = { every_seconds: 600, read_every_seconds: 30, files_folder: '/Written elsewhere', gates: { disk: { label: 'Full Disk Access for {program}', steps: ['Turn on {program}.'] } },
    sources: [{ id: 'shots', label: 'Screenshots', look: { paths: ['~/x'] }, gate: 'disk', read: { route: 'Screenshots', reader: 'folder', store: '/nowhere', settle_seconds: 0 } }] };
  const item = { source_id: 's1', title: 'Shot', text: 'A screenshot', at: '2000-01-01T00:00:00.000Z' };
  const reader = startReading({ rows, account, keep: async () => ({}), stateFolder: state, shared, program: 'node', timers: false, log: () => {},
    readers: { folder: async (carrier, since) => [item].filter(one => Date.parse(one.at) > since.getTime()) }, look: async () => ({ sources: [{ id: 'shots', label: 'Screenshots', state: 'needs_switch', gate: 'disk' }], browser_sites: [] }) });
  // A fresh install: the first read only marks where reading starts, the next sends what is new since.
  await reader.tick();
  await new Promise(done => setTimeout(done, 20));
  item.at = new Date().toISOString();
  await new Promise(done => setTimeout(done, 20));
  await reader.once();
  assert.deepEqual(sent.map(([route]) => route), ['/inbound', '/computer-sources']);
  const report = sent[1][1];
  assert.equal(report.computer_id, JSON.parse(fs.readFileSync(path.join(shared, 'computer.json'), 'utf8')).computer_id);
  assert.deepEqual(report.gates.disk, { label: 'Full Disk Access for node', steps: ['Turn on node.'] });
  reader.stop();

  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  holdReading(path.join(shared, 'reading.lock'), other.pid);
  const second = startReading({ rows, account, keep: async () => ({}), stateFolder: folder(), shared, timers: false, log: () => {}, readers: { folder: async () => [item] }, look: async () => ({ sources: [], browser_sites: [] }) });
  await second.once();
  assert.equal(sent.length, 2, 'nothing is read or reported while another program reads this computer');
  assert.equal(second.status().reading_here, false);
  other.kill();
});

test('a small file is kept in the person\'s files by name, and an account that refuses it says so', async () => {
  const file = path.join(folder(), 'shot preview.jpg');
  fs.writeFileSync(file, 'jpg');
  const bodies = [];
  const keep = fileKeeper(async (route, { body }) => { bodies.push([route, body]); return { status: 200, body: { identity: '1f:abc' } }; }, '/Written elsewhere');
  assert.deepEqual(await keep({ path: file, name: 'shot preview.jpg', media_type: 'image/jpeg' }), { id: '1f:abc', name: 'shot preview.jpg' });
  assert.deepEqual(bodies, [['/namespace/write', { name: '/Written elsewhere/shot preview.jpg', content_base64: Buffer.from('jpg').toString('base64'), media_type: 'image/jpeg' }]]);
  await assert.rejects(fileKeeper(async () => ({ status: 503, body: { error: 'busy' } }), '/x')({ path: file, name: 'a' }), /answered 503: busy/);
});

test('the helper starts each handler that runs by itself, and one that fails to start does not stop the rest', async () => {
  const logged = [];
  const started = startHandlers({ handlers: [{ path: 'bad', start: () => { throw new Error('no'); } }, { path: 'events-only', wants: () => true }, { path: 'good', start: context => ({ started: context.key }) }], key: 'k', log: line => logged.push(line) });
  assert.deepEqual(started, [{ started: 'k' }]);
  assert.match(logged[0], /bad did not start: no/);
  const reader = (await loadHandlers()).find(handler => handler.path === '../../run-on-a-persons-computer/read-this-computer.mjs');
  assert.ok(reader && typeof reader.start === 'function' && reader.wants({ event: {} }) === false, 'reading this computer is a handler row that takes no events');
});
