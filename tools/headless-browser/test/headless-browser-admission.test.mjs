import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserAdmissionQueue, legacyHeadlessRoots, parseLegacyHeadlessRoots } from '../admission.mjs';

async function queueFixture() {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-admission-'));
  return { root, queue: createBrowserAdmissionQueue(root), close: () => rm(root, { recursive: true, force: true }) };
}

test('a live owner is inspected outside the guard without probing queued tickets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-owner-probe-'));
  const probes = [];
  try {
    await mkdir(join(root, 'tickets'), { recursive: true });
    await writeFile(join(root, 'owner.json'), JSON.stringify({ pid: 812, process_started: 'live owner', token: 'held' }));
    for (const pid of [813, 814]) await writeFile(join(root, 'tickets', `${pid}.json`),
      JSON.stringify({ id: String(pid), pid, process_started: 'queued process', priority: 0, created_at: 0 }));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => {
      if (pid === process.pid) return 'this process';
      probes.push(pid);
      assert.equal(existsSync(join(root, 'state.guard')), false);
      return 'live owner';
    } });
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
    assert.ok(probes.length > 0);
    assert.ok(probes.every(pid => pid === 812));
    assert.deepEqual((await readdir(join(root, 'tickets'))).sort(), ['813.json', '814.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an old process observation cannot retire a replacement browser owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-replaced-owner-'));
  const ownerPath = join(root, 'owner.json');
  const replacement = { pid: 813, process_started: 'replacement process', token: 'new owner' };
  try {
    await writeFile(ownerPath, JSON.stringify({ pid: 812, process_started: 'old process', token: 'old owner' }));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => {
      if (pid === process.pid) return 'this process';
      if (pid === 812) { writeFileSync(ownerPath, JSON.stringify(replacement)); return null; }
      return 'replacement process';
    }, isBlocked: () => { throw new Error('must not admit past the replacement owner'); } });
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
    assert.deepEqual(JSON.parse(await readFile(ownerPath, 'utf8')), replacement);
    assert.deepEqual(await readdir(join(root, 'tickets')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation during owner inspection cannot retire its lease or admit a browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-owner-cancel-'));
  const controller = new AbortController();
  const owner = { pid: 812, process_started: 'old process', token: 'held' };
  try {
    await writeFile(join(root, 'owner.json'), JSON.stringify(owner));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => {
      if (pid === process.pid) return 'this process';
      controller.abort(new Error('cancelled during inspection'));
      return null;
    } });
    await assert.rejects(queue.acquire({ signal: controller.signal, timeoutMs: 3000 }), /cancelled during inspection/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')), owner);
    assert.deepEqual(await readdir(join(root, 'tickets')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dead-ticket and legacy-browser inspection never holds the state guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-ticket-probe-'));
  try {
    await mkdir(join(root, 'tickets'));
    await writeFile(join(root, 'tickets', 'dead.json'), JSON.stringify({ id: 'dead', pid: 812, process_started: 'old', priority: 100, created_at: 0 }));
    const queue = createBrowserAdmissionQueue(root, {
      inspectProcess: pid => { assert.equal(existsSync(join(root, 'state.guard')), false); return pid === process.pid ? 'this process' : null; },
      isBlocked: () => { assert.equal(existsSync(join(root, 'state.guard')), false); return false; },
    });
    const release = await queue.acquire({ timeoutMs: 3000 });
    assert.deepEqual(await readdir(join(root, 'tickets')), []);
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a dead-ticket observation keeps a replacement ticket and its priority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-ticket-replace-'));
  const replacement = { id: 'changed', pid: 813, process_started: 'replacement', priority: 100, created_at: 0 };
  try {
    await mkdir(join(root, 'tickets'));
    const path = join(root, 'tickets', 'changed.json');
    await writeFile(path, JSON.stringify({ ...replacement, pid: 812, process_started: 'old' }));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => {
      if (pid === process.pid) return 'this process';
      if (pid === 812) { writeFileSync(path, JSON.stringify(replacement)); return null; }
      return 'replacement';
    } });
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement);
    assert.equal(existsSync(join(root, 'owner.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation while inspecting a ticket does not delete it or admit a browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-ticket-cancel-'));
  const controller = new AbortController();
  const ticket = { id: 'kept', pid: 812, process_started: 'old', priority: 100, created_at: 0 };
  try {
    await mkdir(join(root, 'tickets'));
    const path = join(root, 'tickets', 'kept.json');
    await writeFile(path, JSON.stringify(ticket));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => {
      if (pid === process.pid) return 'this process';
      controller.abort(new Error('cancelled while inspecting a ticket')); return null;
    } });
    await assert.rejects(queue.acquire({ signal: controller.signal, timeoutMs: 3000 }), /cancelled while inspecting a ticket/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), ticket);
    assert.equal(existsSync(join(root, 'owner.json')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('high-priority customer admission runs before queued normal browser work', async () => {
  const fixture = await queueFixture();
  try {
    const firstRelease = await fixture.queue.acquire({ timeoutMs: 3000 });
    const normal = fixture.queue.acquire({ timeoutMs: 3000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    const high = fixture.queue.acquire({ priority: 100, timeoutMs: 3000 });
    await new Promise(resolve => setTimeout(resolve, 30));
    await firstRelease();
    const highRelease = await high;
    let normalAdmitted = false;
    normal.then(() => { normalAdmitted = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(normalAdmitted, false);
    await highRelease();
    const normalRelease = await normal;
    await normalRelease();
  } finally { await fixture.close(); }
});

test('parallel processes can release and reacquire the shared state guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-guard-race-'));
  const moduleUrl = new URL(import.meta.resolve('../admission.mjs')).href;
  const child = `import { createBrowserAdmissionQueue } from ${JSON.stringify(moduleUrl)}; const queue = createBrowserAdmissionQueue(process.argv[1]); for (let i = 0; i < 8; i++) { const release = await queue.acquire({ priority: 1, timeoutMs: 12000 }); await release(); }`;
  const run = () => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', child, root], { timeout: 20000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${error.message}\n${stderr}\n${stdout}`));
    else resolve();
  }));
  try {
    await Promise.all([run(), run(), run()]);
    assert.deepEqual((await readdir(root)).sort(), ['tickets']);
    assert.deepEqual(await readdir(join(root, 'tickets')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation removes a queued browser request', async () => {
  const fixture = await queueFixture();
  try {
    const release = await fixture.queue.acquire({ timeoutMs: 3000 });
    const controller = new AbortController();
    const waiting = fixture.queue.acquire({ signal: controller.signal, timeoutMs: 3000 });
    controller.abort(new Error('cancelled by test'));
    await assert.rejects(waiting, /cancelled by test/);
    await release();
    assert.deepEqual(await readdir(join(fixture.root, 'tickets')), []);
  } finally { await fixture.close(); }
});

test('a lease from a dead exact PID is reclaimed', async () => {
  const fixture = await queueFixture();
  try {
    await mkdir(join(fixture.root, 'tickets'), { recursive: true });
    await writeFile(join(fixture.root, 'owner.json'), JSON.stringify({ pid: 2147483647, process_started: 'old process', token: 'stale' }));
    const release = await fixture.queue.acquire({ timeoutMs: 3000 });
    assert.equal(typeof release, 'function');
    await release();
  } finally { await fixture.close(); }
});

test('the admission blocker admits an empty legacy-root set and waits for a real root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-blocker-'));
  let legacyRoots = [];
  const queue = createBrowserAdmissionQueue(root, { isBlocked: () => legacyRoots.length > 0, inspectProcess: () => 'this process' });
  try {
    const release = await queue.acquire({ timeoutMs: 3000 });
    await release();
    legacyRoots = [{ pid: 812, command: '/opt/chromium_headless_shell-1243/chrome-headless-shell --headless' }];
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
    legacyRoots = [];
    const unblocked = await queue.acquire({ timeoutMs: 3000 });
    await unblocked();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy scan parses Chromium headless shell roots from actual ps-shaped lines', () => {
  const started = 'Mon Oct 12 08:01:02 2026';
  const ps = [
    `  921  111 ${started} /Users/example/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-mac/headless_shell --headless --remote-debugging-port=0`,
    `  922  921 ${started} /Users/example/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-mac/headless_shell --type=renderer --headless`,
    `  923  111 ${started} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new`,
    `  924  111 ${started} /Users/example/not-a-browser --headless`,
  ].join('\n');
  const roots = parseLegacyHeadlessRoots(ps, (pid, identity) => identity === started && pid !== 923);
  assert.deepEqual(roots.map(row => row.pid), [921]);
});

test('legacy admission reads argv only for browser candidates and bounds every process probe', () => {
  const started = 'Mon Oct 12 08:01:02 2026';
  const calls = [];
  const run = (program, args, options) => {
    calls.push({ program, args, options });
    return args[0] === '-axo'
      ? ' 111 /usr/bin/node\n 921 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n'
      : `921 111 ${started} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new\n`;
  };
  assert.equal(legacyHeadlessRoots({ run, inspect: () => started }), true);
  assert.deepEqual(calls.map(call => call.args), [['-axo', 'pid=,comm='], ['-p', '921', '-o', 'pid=,ppid=,lstart=,command=']]);
  assert.ok(calls.every(call => call.options.timeout === 2000 && call.options.killSignal === 'SIGKILL'));
  calls.length = 0;
  assert.equal(legacyHeadlessRoots({ run: (...args) => { calls.push(args); return '111 /usr/bin/node\n'; } }), false);
  assert.equal(calls.length, 1);
});

test('failed process inspection keeps browser admission closed', () => {
  const timeout = () => { throw Object.assign(new Error('process probe timed out'), { code: 'ETIMEDOUT' }); };
  assert.equal(legacyHeadlessRoots({ run: timeout }), true);
  let count = 0;
  assert.equal(legacyHeadlessRoots({ run: () => ++count === 1 ? '921 /opt/chrome-headless-shell\n' : timeout() }), true);
});

test('an unavailable identity probe never reclaims a live browser lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-live-identity-'));
  const owner = { pid: 812, process_started: 'existing process', token: 'kept-live-owner' };
  try {
    await writeFile(join(root, 'owner.json'), JSON.stringify(owner));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: pid => pid === process.pid ? 'this process' : 'unverified-live-process' });
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')), owner);
    assert.deepEqual(await readdir(join(root, 'tickets')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a lease recorded while its process probe was unavailable is kept while its PID is alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-unverified-'));
  try {
    await mkdir(join(root, 'tickets'), { recursive: true });
    await writeFile(join(root, 'owner.json'), JSON.stringify({ pid: process.pid, process_started: 'unverified-live-process', token: 'held' }));
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: () => 'Mon Oct 12 08:01:02 2026' });
    await assert.rejects(queue.acquire({ timeoutMs: 300 }), /Timed out/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('admission proceeds when the process probe is unavailable for this process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion-browser-probe-'));
  try {
    const queue = createBrowserAdmissionQueue(root, { inspectProcess: () => 'unverified-live-process' });
    const release = await queue.acquire({ timeoutMs: 1000 });
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
