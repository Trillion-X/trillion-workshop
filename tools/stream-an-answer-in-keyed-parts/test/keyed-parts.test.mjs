// test/keyed-parts.test.mjs
// A streamed answer is keyed parts merged by type; a patch that does not apply never loses the answer; a replay adds
// nothing twice; a re-attach continues from a snapshot and gives up after a bounded number of empty tries (F-0314, F-0740).
// Ported from Trillion-X/trillion test/keyed-parts.test.mjs; its last case (the local model chat through askLocal,
// computer/local-models.mjs) stays with the old tree, which still calls the module.
import assert from 'node:assert/strict';
import test from 'node:test';
import { afterAttempt, applyOps, mergeEvent, newEntry, resumeToken } from '../src/keyed-parts.mjs';

const feed = events => events.reduce((entry, event) => mergeEvent(entry, event), newEntry());

test('text appends, sources and related are parts of their own, and a patch changes a part already sent', () => {
  const entry = feed([
    { seq: 1, type: 'text', key: 'answer', text: 'Trillion keeps ' },
    { seq: 2, type: 'text', key: 'answer', text: 'your records.' },
    { seq: 3, type: 'sources', key: 'sources', value: [{ n: 1, url: 'https://a.example' }], more: { page: 2 } },
    { seq: 4, type: 'related', key: 'related', value: ['What else?'] },
    { seq: 5, type: 'patch', target: 'sources', ops: [{ op: 'add', path: '/-', value: { n: 2, url: 'https://b.example' } }, { op: 'replace', path: '/0/url', value: 'https://a2.example' }] },
  ]);
  assert.equal(entry.parts.answer.text, 'Trillion keeps your records.');
  assert.deepEqual(entry.parts.sources.value.map(row => row.url), ['https://a2.example', 'https://b.example']);
  assert.deepEqual(entry.parts.sources.more, { page: 2 });
  assert.deepEqual(entry.order, ['answer', 'sources', 'related']);
  console.log('readback', JSON.stringify({ answer: entry.parts.answer.text, sources: entry.parts.sources.value.length, seq: entry.seq }));
});

test('a patch that does not apply is recorded as drift and kept as its own part; unknown types are kept', () => {
  const entry = feed([
    { seq: 1, type: 'sources', key: 'sources', value: [] },
    { seq: 2, type: 'patch', target: 'sources', ops: [{ op: 'replace', path: '/5/url', value: 'x' }] },
    { seq: 3, type: 'hologram', key: 'extra', value: 1 },
  ]);
  assert.equal(entry.drift.length, 2);
  assert.match(entry.drift[0].why, /did not apply/);
  assert.ok(entry.parts['sources~patch']);
  assert.deepEqual(entry.parts.sources.value, []);
  assert.ok(entry.parts.extra);
});

test('a replayed event adds nothing twice and a snapshot lets a re-attach continue', () => {
  const first = feed([{ seq: 1, type: 'text', key: 'answer', text: 'ab' }, { seq: 2, type: 'text', key: 'answer', text: 'cd' }]);
  assert.equal(mergeEvent(first, { seq: 2, type: 'text', key: 'answer', text: 'cd' }).parts.answer.text, 'abcd');
  const fresh = mergeEvent(newEntry(), { type: 'snapshot', seq: 2, parts: first.parts, order: first.order });
  const continued = mergeEvent(fresh, { seq: 3, type: 'text', key: 'answer', text: 'ef' });
  assert.equal(continued.parts.answer.text, 'abcdef');
  assert.equal(resumeToken(first).seq, 2);
  assert.equal(resumeToken(first).identity, resumeToken(fresh).identity);
});

test('empty re-attach attempts are bounded', () => {
  let entry = feed([{ seq: 1, type: 'text', key: 'answer', text: 'a' }]);
  const outcomes = [];
  for (let attempt = 0; attempt < 3; attempt += 1) { const result = afterAttempt(entry, entry); entry = result.entry; outcomes.push(result.give_up); }
  assert.deepEqual(outcomes, [false, false, true]);
  assert.equal(applyOps({ a: 1 }, [{ op: 'remove', path: '/a' }]).a, undefined);
});

