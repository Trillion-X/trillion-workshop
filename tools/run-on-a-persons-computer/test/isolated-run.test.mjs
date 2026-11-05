// test/isolated-run.test.mjs
//
// A Mac tool row with `isolate` runs each call in a worker of its own (computer/isolated-run.mjs): a hang, a leak or a
// crash ends only that run; a second start with a live run id is refused; stopping asks first and terminates after the
// grace; a refusal's status and retry cross intact. The module under test is a tool written for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveRuns, runIsolated, stopAll } from '../isolated-run.mjs';
import { settingsOf } from '../mac-tools.mjs';

const folder = mkdtempSync(join(tmpdir(), 'isolated-'));
const file = join(folder, 'tools.mjs');
writeFileSync(file, `
export const tools = {
  echo: async (input, context) => ({ input, context }),
  hang: () => new Promise(() => setInterval(() => {}, 1000)),
  spin: () => { for (;;); },
  leak: () => { const rows = []; for (;;) rows.push(new Array(1e6).fill('x')); },
  refuse: async () => { throw Object.assign(new Error('Not allowed.'), { status: 403, retry: false }); },
  crash: async () => { throw new Error('plain failure'); },
  slow: () => new Promise(resolve => setTimeout(() => resolve({ done: true }), 150)),
};`);
const words = settingsOf().words;
const isolate = { timeout_ms: 400, max_old_generation_mb: 64, stop_grace_ms: 100 };
const start = (name, id = name, extra = {}) => runIsolated({ id, module: pathToFileURL(file).href, export: 'tools', name, input: { n: 1 }, context: { a: 'b' }, isolate: { ...isolate, ...extra }, words });
const refusedWith = async (promise, status, retry, text) => assert.rejects(promise, error => { assert.equal(error.status, status); assert.equal(error.retry, retry); assert.match(error.message, text); return true; });

test('a call runs in its own worker with its plain input and context, and answers', async () => {
  assert.deepEqual(await start('echo'), { input: { n: 1 }, context: { a: 'b' } });
  assert.deepEqual(liveRuns(), []);
});

test('a hung tool and a busy loop are stopped at the timeout, and nothing is left running', async () => {
  const began = Date.now();
  await refusedWith(start('hang'), 504, true, /did not finish in 0 seconds/);
  await refusedWith(start('spin'), 504, true, /was stopped/);
  assert.ok(Date.now() - began < 3000);
  assert.deepEqual(liveRuns(), []);
});

test('a tool over its memory cap ends only itself', async () => {
  await refusedWith(start('leak', 'leak', { timeout_ms: 20000, max_old_generation_mb: 48 }), 507, false, /used more than 48 MB/);
  assert.deepEqual(await start('echo', 'after-leak'), { input: { n: 1 }, context: { a: 'b' } });
});

test('a refusal keeps its status and retry, a plain error is a failure in words, and the same run id twice is refused', async () => {
  await refusedWith(start('refuse'), 403, false, /Not allowed/);
  await assert.rejects(start('crash'), error => { assert.equal(error.message, 'plain failure'); return true; });
  const first = start('slow', 'same');
  await refusedWith(start('slow', 'same'), 409, false, /already going/);
  assert.deepEqual(await first, { done: true });
  assert.deepEqual(await start('slow', 'same'), { done: true }, 'the id is free again once the run ended');
});

test('two runs at once do not touch each other: one hangs while the other answers', async () => {
  const hung = start('hang', 'hung');
  assert.deepEqual(await start('echo', 'quick'), { input: { n: 1 }, context: { a: 'b' } });
  await refusedWith(hung, 504, true, /stopped/);
});

test('a stop on demand, and a clock that jumps (the Mac slept), end every live run with a refusal that says why', async () => {
  const one = start('hang', 'asleep-one', { timeout_ms: 20000 }), two = start('hang', 'asleep-two', { timeout_ms: 20000 });
  stopAll();
  await refusedWith(one, 503, true, /was stopped/);
  await refusedWith(two, 503, true, /was stopped/);
  const real = Date.now;
  const slept = start('hang', 'slept', { timeout_ms: 20000, sleep_check_ms: 20, sleep_gap_ms: 100 });
  await new Promise(resolve => setTimeout(resolve, 50));
  let jump = 0;
  Date.now = () => real() + jump;
  jump = 60_000;
  try { await refusedWith(slept, 503, true, /went to sleep/); } finally { Date.now = real; }
  assert.deepEqual(liveRuns(), []);
});
