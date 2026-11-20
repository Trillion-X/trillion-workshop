// The media queue read (read-data/read-media-queue.ts): the old file's invariants as tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderMediaQueue, readMediaQueueOrder } from '../read-data/media-queue-order.ts';

const source = id => ({ id, kind: 'video', source_kind: 'local-file' });
const sources = ['a', 'b', 'c'].map(source);

test('no queue record, or an empty one, keeps natural source order', () => {
  assert.deepEqual(orderMediaQueue(sources, []).map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(readMediaQueueOrder([]).ordered_ids, []);
  assert.deepEqual(readMediaQueueOrder([{ payload: { kind: 'other', ordered_ids: ['c'] } }]).ordered_ids, []);
});

test('the queue order is honoured and sources not queued are appended last, so nothing becomes unreachable', () => {
  assert.deepEqual(orderMediaQueue(sources, ['c', 'a']).map(item => item.id), ['c', 'a', 'b']);
});

test('a stale id whose source is gone is skipped and does not blank the queue', () => {
  assert.deepEqual(orderMediaQueue(sources, ['gone', 'b']).map(item => item.id), ['b', 'a', 'c']);
});

test('the first media-queue record is read, and its non-text ids are dropped', () => {
  const rows = [
    { payload: { kind: 'media-queue', ordered_ids: ['c', 7, '  ', 'a'] } },
    { payload: { kind: 'media-queue', ordered_ids: ['b'] } },
  ];
  assert.deepEqual(readMediaQueueOrder(rows).ordered_ids, ['c', 'a']);
});

test('a bare row (no payload wrapper) is read the same way', () => {
  assert.deepEqual(readMediaQueueOrder([{ kind: 'media-queue', ordered_ids: ['b'] }]).ordered_ids, ['b']);
});
