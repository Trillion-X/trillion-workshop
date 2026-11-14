import assert from 'node:assert/strict';
import test from 'node:test';
import { createCursorTransitionQueue } from './walkthrough-cursor-queue';

type Cursor = { currentStepId: string; history: string[]; status: 'active' | 'complete' };
const cursor = (currentStepId: string, history: string[] = [], status: Cursor['status'] = 'active'): Cursor => ({
  currentStepId, history, status,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const same = (a: Cursor, b: Cursor) => a.currentStepId === b.currentStepId
  && a.status === b.status
  && a.history.join('\0') === b.history.join('\0');

test('shows rapid advances immediately and serializes owner writes', async () => {
  const first = deferred<{ kind: 'accepted'; cursor: Cursor }>();
  const writes: string[] = [];
  const shown: string[] = [];
  const queue = createCursorTransitionQueue<Cursor>({
    initial: cursor('one'),
    persist: async ({ previous, next }) => {
      writes.push(previous.currentStepId + '>' + next.currentStepId);
      if (writes.length === 1) return first.promise;
      return { kind: 'accepted', cursor: next };
    },
    same, onVisible: (value) => shown.push(value.currentStepId),
    onSaving: () => {}, onFailure: (error) => { throw error; }, onComplete: () => {},
  });
  queue.enqueue(cursor('two', ['one']), 'advance');
  queue.enqueue(cursor('three', ['one', 'two']), 'advance');
  assert.equal(queue.current.currentStepId, 'three');
  assert.deepEqual(writes, ['one>two']);
  first.resolve({ kind: 'accepted', cursor: cursor('two', ['one']) });
  assert.equal(await queue.flush(), true);
  assert.deepEqual(writes, ['one>two', 'two>three']);
  assert.equal(shown.at(-1), 'three');
});

test('retries the exact failed compare-and-set transition', async () => {
  let attempts = 0;
  const requests: unknown[] = [];
  const queue = createCursorTransitionQueue<Cursor>({
    initial: cursor('one'),
    persist: async (transition) => {
      requests.push(transition);
      attempts += 1;
      if (attempts === 1) throw new Error('temporary');
      return { kind: 'accepted', cursor: transition.next };
    },
    same, onVisible: () => {}, onSaving: () => {}, onFailure: () => {}, onComplete: () => {},
  });
  queue.enqueue(cursor('two', ['one']), 'advance');
  assert.equal(await queue.flush(), false);
  assert.equal(await queue.flush(), false);
  queue.retry();
  assert.equal(await queue.flush(), true);
  assert.equal(requests[0], requests[1]);
});

test('adopts the authoritative stale cursor and drops queued transitions', async () => {
  let calls = 0;
  let shown: Cursor = cursor('one');
  const queue = createCursorTransitionQueue<Cursor>({
    initial: shown,
    persist: async () => {
      calls += 1;
      return { kind: 'stale', cursor: cursor('server-step', ['one', 'server-step']) };
    },
    same, onVisible: (value) => { shown = value; },
    onSaving: () => {}, onFailure: (error) => { throw error; }, onComplete: () => {},
  });
  queue.enqueue(cursor('two', ['one']), 'advance');
  queue.enqueue(cursor('three', ['one', 'two']), 'advance');
  assert.equal(await queue.flush(), true);
  assert.equal(calls, 1);
  assert.equal(queue.pendingCount, 0);
  assert.equal(shown.currentStepId, 'server-step');
});

test('reports completion only after the final owner write is accepted', async () => {
  const write = deferred<{ kind: 'accepted'; cursor: Cursor }>();
  let completed = false;
  const queue = createCursorTransitionQueue<Cursor>({
    initial: cursor('last'),
    persist: async () => write.promise,
    same, onVisible: () => {}, onSaving: () => {},
    onFailure: (error) => { throw error; }, onComplete: () => { completed = true; },
  });
  queue.enqueue(cursor('last', ['last'], 'complete'), 'advance');
  assert.equal(completed, false);
  assert.equal(queue.current.status, 'active');
  write.resolve({ kind: 'accepted', cursor: cursor('last', ['last'], 'complete') });
  assert.equal(await queue.flush(), true);
  assert.equal(completed, true);
});
