// test/owned-upsert.test.mjs
//
// One message of our own on a shared surface (src/owned-upsert.mjs): found by marker and author, made once, rewritten in place,
// never written about a version that moved on, and failures reach the caller.
import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertOwned } from '../src/owned-upsert.mjs';

const MARKER = '<!-- trillion:diagram -->';
const surface = (messages, { pageSize = 2 } = {}) => {
  const calls = [];
  return {
    calls, messages,
    list: async (page = 0) => { calls.push(['list', page]); const slice = messages.slice(page, page + pageSize); return { messages: slice, next: page + pageSize < messages.length ? page + pageSize : undefined }; },
    create: async (body) => { calls.push(['create']); const made = { id: `m${messages.length + 1}`, author: 'us', body }; messages.push(made); return made; },
    update: async (id, body) => { calls.push(['update', id]); messages.find((m) => m.id === id).body = body; },
  };
};
const run = (target, extra = {}) => upsertOwned({ surface: target, marker: MARKER, owner: 'us', compose: async () => `${MARKER} v1`, currentVersion: async () => 'head1', ...extra });

test('no message of ours yet: one is created, and the surface is read to its last page first', async () => {
  const target = surface([{ id: 'a', author: 'them', body: 'hi' }, { id: 'b', author: 'them', body: 'ho' }, { id: 'c', author: 'them', body: 'hum' }]);
  const result = await run(target);
  assert.equal(result.outcome, 'created');
  assert.deepEqual(target.calls.map((c) => c[0]), ['list', 'list', 'create']);
  assert.equal(result.said, 'Posted a new message.');
});

test('a marker alone is not ours: someone else copying it is left alone and ours is still made', async () => {
  const target = surface([{ id: 'a', author: 'them', body: `${MARKER} forged` }]);
  const result = await run(target);
  assert.equal(result.outcome, 'created');
  assert.equal(target.messages[0].body, `${MARKER} forged`);
});

test('our message is rewritten in place, not posted again, and left alone when it already says this', async () => {
  const target = surface([{ id: 'a', author: 'us', body: `${MARKER} old` }]);
  const updated = await run(target);
  assert.deepEqual([updated.outcome, updated.id, target.messages.length], ['updated', 'a', 1]);
  const same = await run(target);
  assert.deepEqual([same.outcome, same.id], ['unchanged', 'a']);
  assert.equal(target.calls.filter((c) => c[0] === 'update').length, 1);
});

test('older duplicates of ours are reported and kept, and the newest is the one updated', async () => {
  const target = surface([{ id: 'a', author: 'us', body: `${MARKER} 1` }, { id: 'b', author: 'us', body: `${MARKER} 2` }]);
  const result = await run(target);
  assert.deepEqual([result.outcome, result.id, result.duplicates], ['updated', 'b', ['a']]);
  assert.match(result.said, /1 older copies/);
  assert.equal(target.messages.length, 2);
});

test('a thing that moved on while the message was being composed is not written about', async () => {
  const target = surface([{ id: 'a', author: 'us', body: `${MARKER} old` }]);
  const versions = ['head1', 'head2'];
  const result = await run(target, { currentVersion: async () => versions.shift() });
  assert.equal(result.outcome, 'overtaken');
  assert.deepEqual(target.calls.filter((c) => c[0] !== 'list'), []);
  assert.equal(target.messages[0].body, `${MARKER} old`);
});

test('a failed read or a failed page is an error, not "nothing there", and a message without the marker is refused', async () => {
  const target = surface([]);
  await assert.rejects(() => run(target, { currentVersion: async () => { throw new Error('forge down'); } }), /forge down/);
  await assert.rejects(() => run({ ...target, list: async () => { throw new Error('rate limited'); } }), /rate limited/);
  assert.equal(target.calls.length, 0);
  await assert.rejects(() => run(target, { compose: async () => 'no marker here' }), /marker/);
});
