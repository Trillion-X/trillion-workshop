// A caller that loops while readers hang never has more than most_children reader processes: the rest wait for a place and,
// after wait_seconds, are turned away with the reason (computer/read-new-items.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { childLimit } from '../computer/read-new-items.mjs';

const limits = JSON.parse(readFileSync(new URL('../computer/read-new-items.json', import.meta.url), 'utf8'));

test('the cap is in DATA', () => {
  assert.ok(limits.most_children >= 1 && limits.wait_seconds > 0);
});

test('a looping caller with hanging readers never has more than most_children running', async () => {
  const place = childLimit({ most_children: 3, wait_seconds: 30 });
  let running = 0;
  let most = 0;
  const hangs = [];
  const call = () => place(() => new Promise(done => { running += 1; most = Math.max(most, running); hangs.push(() => { running -= 1; done('items'); }); }));
  const calls = Array.from({ length: 50 }, call);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(running, 3);
  while (hangs.length) { hangs.shift()(); await new Promise(r => setTimeout(r, 1)); }
  assert.equal(most, 3);
  assert.equal((await Promise.all(calls)).length, 50);
});

test('a read over the cap is turned away with the reason after its wait, and frees nothing it never held', async () => {
  const timers = [];
  const place = childLimit({ most_children: 1, wait_seconds: 5 }, { setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => {} });
  let release;
  const holder = place(() => new Promise(done => { release = done; }));
  const waiter = place(async () => 'never runs');
  assert.equal(timers[0].ms, 5000);
  timers[0].run();
  await assert.rejects(waiter, /Reading waits: 1 readers are already running \(at most 1\)/);
  release('ok');
  await holder;
  assert.equal(await place(async () => 'again'), 'again', 'the place is free after the holder finished');
});

test('a finished child hands its place to the oldest waiting read, in order', async () => {
  const place = childLimit({ most_children: 1, wait_seconds: 30 });
  const order = [];
  let release;
  const first = place(() => new Promise(done => { release = done; }));
  const second = place(async () => { order.push('second'); });
  const third = place(async () => { order.push('third'); });
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['second', 'third']);
});

test('a reader that throws still frees its place', async () => {
  const place = childLimit({ most_children: 1, wait_seconds: 30 });
  await assert.rejects(place(async () => { throw new Error('synthetic reader failure'); }), /synthetic reader failure/);
  assert.equal(await place(async () => 'next'), 'next');
});
