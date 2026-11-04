import assert from 'node:assert/strict';
import test from 'node:test';
import { watchBoardLoad } from '../show/board-load.ts';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function watch(t, pending, events) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return watchBoardLoad(() => pending.promise, {
    timeoutMs: 5000,
    onSlow: () => events.push('slow'),
    onLoaded: value => events.push(['loaded', value]),
    onFailed: error => events.push(['failed', error.message]),
  });
}

test('a completed board suppresses the warning and paints once', async t => {
  const pending = deferred(), events = [];
  watch(t, pending, events);
  pending.resolve({ cards: ['first', 'middle', 'last'] });
  await flush();
  t.mock.timers.tick(10000);
  assert.deepEqual(events, [['loaded', { cards: ['first', 'middle', 'last'] }]]);
});

test('a hung open warns at five seconds and a late result still paints', async t => {
  const pending = deferred(), events = [];
  watch(t, pending, events);
  await flush();
  t.mock.timers.tick(4999);
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ['slow']);
  t.mock.timers.tick(15000);
  assert.deepEqual(events, ['slow']);
  pending.resolve('six workflow cards');
  await flush();
  assert.deepEqual(events, ['slow', ['loaded', 'six workflow cards']]);
});

test('a rejected load reports failure and cancels its warning', async t => {
  const pending = deferred(), events = [];
  watch(t, pending, events);
  pending.reject(new Error('read failed'));
  await flush();
  t.mock.timers.tick(10000);
  assert.deepEqual(events, [['failed', 'read failed']]);
});

test('retry or unmount fences late success and late failure from the old open', async t => {
  const old = deferred(), events = [];
  const stop = watch(t, old, events);
  await flush();
  t.mock.timers.tick(5000);
  stop();
  const next = deferred();
  const stopNext = watchBoardLoad(() => next.promise, {
    timeoutMs: 5000, onSlow: () => events.push('next slow'),
    onLoaded: value => events.push(['next', value]),
    onFailed: () => events.push('next failed'),
  });
  old.resolve('stale board');
  next.resolve('current board');
  await flush();
  stopNext();
  const rejected = deferred();
  const dispose = watchBoardLoad(() => rejected.promise, {
    timeoutMs: 5000, onSlow: () => events.push('disposed slow'),
    onLoaded: () => events.push('disposed ready'),
    onFailed: () => events.push('disposed failed'),
  });
  dispose();
  rejected.reject(new Error('late failure'));
  await flush();
  t.mock.timers.tick(10000);
  assert.deepEqual(events, ['slow', ['next', 'current board']]);
});

test('the warning covers downstream work, not just the first read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const apply = deferred(), events = [];
  watchBoardLoad(async () => { await Promise.resolve('read'); await apply.promise; return 'drawn'; }, {
    timeoutMs: 5000, onSlow: () => events.push('slow'),
    onLoaded: value => events.push(value), onFailed: () => events.push('failed'),
  });
  await flush();
  t.mock.timers.tick(5000);
  apply.resolve();
  await flush();
  assert.deepEqual(events, ['slow', 'drawn']);
});

test('a successful refresh can replace the opening read before its warning', async t => {
  const opening = deferred(), events = [];
  const stop = watch(t, opening, events);
  await flush();
  t.mock.timers.tick(3000);
  // The current refresh has painted. Dispose the older opening observer so it
  // can neither restore its older graph nor bring its warning back afterward.
  events.push(['refresh', 'current board']);
  stop();
  t.mock.timers.tick(3000);
  opening.resolve('older board');
  await flush();
  assert.deepEqual(events, [['refresh', 'current board']]);
});
