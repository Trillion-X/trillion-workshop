// tools/keep-open-screens-in-step-with-changes/test/tab-leader.test.mjs: moved from old trillion
// test/client-data-layer.test.mjs lines 22-102 with their assertions unchanged: tabs share work through one lock
// owner (src/workspace/tab-leader.ts). Old trillion bundled it with esbuild; here it is imported as it is. The budget and
// stuck-tab tests moved to tools/keep-answers-on-this-device; the Retry-After test stays with src/workspace/quiet-writes.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadBrowser, inOneTab } from '../src/workspace/tab-leader.ts';

// Web Locks as a browser holds them: one holder per name, the next waiter takes over when it lets go.
function fakeLocks() {
  const held = new Map();
  const waiters = new Map();
  const grant = name => {
    const next = (waiters.get(name) ?? []).shift();
    if (!next) return;
    held.set(name, next);
    Promise.resolve(next.run({ name })).finally(() => { held.delete(name); grant(name); next.done(); });
  };
  return {
    held,
    request(name, options, run) {
      return new Promise((resolve, reject) => {
        if (options.ifAvailable) {
          if (held.has(name)) { resolve(run(null)); return; }
          held.set(name, {});
          Promise.resolve(run({ name })).then(resolve, reject).finally(() => held.delete(name));
          return;
        }
        const waiter = { run, done: resolve };
        waiters.set(name, [...(waiters.get(name) ?? []), waiter]);
        options.signal?.addEventListener('abort', () => { const rest = (waiters.get(name) ?? []).filter(item => item !== waiter); waiters.set(name, rest); reject(new Error('aborted')); });
        if (!held.has(name)) grant(name);
      });
    },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('one tab leads a name; when it stops the next waiting tab takes over', async () => {
  const locks = fakeLocks();
  const log = [];
  const stopA = leadBrowser('stream', () => { log.push('A leads'); return () => log.push('A stopped'); }, locks);
  const stopB = leadBrowser('stream', () => { log.push('B leads'); return () => log.push('B stopped'); }, locks);
  await settle();
  assert.deepEqual(log, ['A leads']);
  stopA();
  await settle();
  console.log('TAB LEADER READBACK:', JSON.stringify(log));
  assert.deepEqual(log, ['A leads', 'A stopped', 'B leads']);
  stopB();
  await settle();
  assert.deepEqual(log.slice(-1), ['B stopped']);
  const alone = [];
  leadBrowser('stream', () => { alone.push('leads'); }, null);
  assert.deepEqual(alone, ['leads'], 'without Web Locks a tab leads itself');
});

test('a poll runs in one tab per tick; a tab that finds it running skips', async () => {
  const locks = fakeLocks();
  let ran = 0;
  let release;
  const first = inOneTab('drain', () => new Promise(resolve => { ran += 1; release = resolve; }), locks);
  await settle();
  const second = await inOneTab('drain', () => { ran += 1; }, locks);
  assert.equal(second, false);
  release();
  assert.equal(await first, true);
  assert.equal(await inOneTab('drain', () => { ran += 1; }, locks), true);
  assert.equal(ran, 2);
});

test('an exposed but denied Web Locks API uses the per-tab fallback and releases it', async () => {
  const denied = { request() { throw new DOMException('Opaque frame', 'SecurityError'); } };
  const log = [];
  const stop = leadBrowser('stream', () => { log.push('start'); return () => log.push('stop'); }, denied);
  await settle();
  assert.deepEqual(log, ['start']);
  stop();
  assert.deepEqual(log, ['start', 'stop']);
  assert.equal(await inOneTab('poll', () => log.push('poll'), denied), true);
  assert.deepEqual(log, ['start', 'stop', 'poll']);
});

test('a failure inside lock-owned work is propagated without running it again', async () => {
  let ran = 0;
  const entered = { request: async (_name, _options, work) => work({}) };
  await assert.rejects(inOneTab('poll', () => { ran++; throw new DOMException('Work failed', 'SecurityError'); }, entered), { name: 'SecurityError' });
  assert.equal(ran, 1);
});
