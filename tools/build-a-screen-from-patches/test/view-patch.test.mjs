// tools/build-a-screen-from-patches/test/view-patch.test.mjs (moved from Trillion-X/trillion test/view-patch.test.mjs)
//
// A screen in an AI app that already holds a read is sent only what changed (src/view-patch.mjs, asked through
// src/screen-view.mjs screen_read and answered by src/worker.mjs screenRead): patches rebuild the answer exactly, a
// stale or foreign base answers whole, and the screen reads whole again when a patch does not fit what it holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, diff, identityOf, makeAnswerCache, patchedAnswer, textAfter } from '../read-data/view-patch.mjs';

const rows = count => Array.from({ length: count }, (_, at) => ({ id: `row-${at}`, title: `A record titled number ${at}`, done: false, tags: ['a', 'b'] }));
const answerOf = model => ({ status: 200, content_type: 'application/json', text: JSON.stringify(model, null, 2) });

test('a patch rebuilds exactly the next answer for objects, lists that grow and shrink, and removed keys', () => {
  const cases = [
    [{ a: 1, b: { c: [1, 2, 3] } }, { a: 2, b: { c: [1, 2, 3, 4] }, d: 'new' }],
    [{ list: [{ x: 1 }, { x: 2 }, { x: 3 }] }, { list: [{ x: 1 }] }],
    [{ k: 'v', gone: true }, { k: 'v' }],
    [{ 'we/ird~key': 1 }, { 'we/ird~key': 2 }],
    [[1, 2], { now: 'an object' }],
  ];
  for (const [before, after] of cases) assert.deepEqual(applyPatch(before, diff(before, after)), after);
  const before = { a: 1 };
  applyPatch(before, diff(before, { a: 2 }));
  assert.deepEqual(before, { a: 1 }, 'the model given is not changed');
});

test('asked again with the identity it holds, a screen gets changes only; a miss, a foreign identity or a small answer gets the whole text', () => {
  const cache = makeAnswerCache();
  const first = patchedAnswer({ answer: answerOf({ rows: rows(200) }), have: undefined, key: 'u1\n/work/api/lists', cache });
  assert.ok(first.text && first.identity && !first.patch);
  const next = rows(200); next[7].done = true;
  const second = patchedAnswer({ answer: answerOf({ rows: next }), have: first.identity, key: 'u1\n/work/api/lists', cache });
  assert.equal(second.text, undefined);
  assert.deepEqual(second.patch.ops, [{ op: 'replace', path: '/rows/7/done', value: true }]);
  assert.ok(JSON.stringify(second.patch).length < 400);
  const held = textAfter(first, undefined).held;
  const rebuilt = textAfter(second, held);
  assert.deepEqual(JSON.parse(rebuilt.text), { rows: next });
  assert.equal(rebuilt.held.identity, second.identity);
  // Another person never uses this person's answer as a base.
  const foreign = patchedAnswer({ answer: answerOf({ rows: next }), have: first.identity, key: 'u2\n/work/api/lists', cache });
  assert.ok(foreign.text && !foreign.patch);
  // A different identity than the one held here is whole.
  assert.ok(patchedAnswer({ answer: answerOf({ rows: rows(200) }), have: 'not-held', key: 'u1\n/work/api/lists', cache }).text);
  // Short answers, errors and non-JSON are untouched.
  assert.deepEqual(patchedAnswer({ answer: answerOf({ a: 1 }), have: 'x', key: 'k', cache }), answerOf({ a: 1 }));
  assert.equal(patchedAnswer({ answer: { status: 500, text: 'x'.repeat(5000) }, have: 'x', key: 'k', cache }).patch, undefined);
  assert.equal(patchedAnswer({ answer: { status: 200, text: 'x'.repeat(5000) }, have: 'x', key: 'k', cache }).identity, undefined);
});

test('a patch that is not smaller than the share is not sent, and the cache is bounded', () => {
  const cache = makeAnswerCache({ entries: 3 });
  const first = patchedAnswer({ answer: answerOf({ rows: rows(100) }), key: 'u\n/p', cache });
  const replaced = patchedAnswer({ answer: answerOf({ rows: rows(100).map(row => ({ ...row, title: `${row.title} changed everywhere` })) }), have: first.identity, key: 'u\n/p', cache });
  assert.ok(replaced.text && !replaced.patch, 'everything changed: whole is cheaper');
  for (const key of ['a', 'b', 'c', 'd']) cache.set(key, { identity: key, text: '{}' });
  assert.equal(cache.size(), 3);
});

test('the screen reads whole again when a patch does not fit what it holds or does not rebuild its identity', () => {
  const cache = makeAnswerCache();
  const first = patchedAnswer({ answer: answerOf({ rows: rows(100) }), key: 'u\n/p', cache });
  const next = rows(100); next[1].title = 'changed';
  const patched = patchedAnswer({ answer: answerOf({ rows: next }), have: first.identity, key: 'u\n/p', cache });
  assert.deepEqual(textAfter(patched, undefined), { stale: true });
  assert.deepEqual(textAfter(patched, { identity: 'other', text: '{}' }), { stale: true });
  const held = textAfter(first, undefined).held;
  assert.deepEqual(textAfter({ ...patched, patch: { ...patched.patch, to: identityOf('{}') } }, held), { stale: true });
});

// Trillion's 'screen_read carries the screen's identity to the Worker' test runs src/screen-view.mjs, which stays in
// trillion (Worker-coupled), so it stays there with it.
