// tools/media-composition/test/auto-edit.test.mjs (moved from Trillion-X/trillion test/auto-edit.test.mjs; its suggest_media_cuts test stays with src/tools.mjs)
//
// A recording's kept words become cut proposals as typed lines (read-data/auto-edit.mjs): modes are
// DATA rows, a recording without timed words and a transcript with nothing to cut end in typed errors, and an answer is kept
// per version.
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoEditLines, autoEditText, timedWords } from '../read-data/auto-edit.mjs';
import { decodeSuggestionLines } from '../read-data/suggestion-stream.mjs';
import rules from '../read-data/auto-edit.json' with { type: 'json' };

const word = (word, start, end) => ({ word, start, end });
const transcript = { text: 'hello um world', segments: [{ start: 0, end: 6, text: 'hello um world', words: [word('hello', 0, 0.5), word('um', 0.6, 0.9), word('world', 3, 3.5)] }] };
const memory = () => { const kept = new Map(); return { kept, get: id => kept.get(id), set: (id, entry) => { kept.set(id, entry); } }; };
const collect = async iterable => { const lines = []; for await (const line of iterable) lines.push(line); return lines; };
const ID = `1f:${'a'.repeat(64)}`;

test('silent_pauses proposes the gap, filler_words the filler, as remove-span proposals with their reason', async () => {
  const gaps = await collect(autoEditLines({ identity: ID, mode: 'silent_pauses', transcript, cache: memory() }));
  assert.deepEqual(gaps.map(line => line.type), ['status', 'status', 'thinking', 'complete']);
  assert.equal(gaps.at(-1).proposals.length, 1);
  assert.deepEqual({ kind: gaps.at(-1).proposals[0].kind, reason: gaps.at(-1).proposals[0].reason }, { kind: 'remove-span', reason: 'silence' });
  assert.ok(gaps.at(-1).proposals[0].start > 0.9 && gaps.at(-1).proposals[0].end < 3);
  const fillers = await collect(autoEditLines({ identity: ID, mode: 'filler_words', transcript, cache: memory() }));
  assert.deepEqual(fillers.at(-1).proposals.map(item => [item.start, item.end, item.reason]), [[0.6, 0.9, 'filler']]);
});

test('no timed words ends in NO_TRANSCRIPT, nothing to cut in NO_PROPOSALS, an unknown mode in FAILED', async () => {
  assert.equal((await collect(autoEditLines({ identity: ID, mode: 'silent_pauses', transcript: { text: 'x', segments: [{ start: 0, end: 1, text: 'x' }] }, cache: memory() })))[0].code, 'NO_TRANSCRIPT');
  assert.equal((await collect(autoEditLines({ identity: ID, mode: 'silent_pauses', transcript: null, cache: memory() })))[0].code, 'NO_TRANSCRIPT');
  const tight = { segments: [{ words: [word('one', 0, 0.4), word('two', 0.5, 0.9)] }] };
  assert.equal((await collect(autoEditLines({ identity: ID, mode: 'filler_words', transcript: tight, cache: memory() }))).at(-1).code, 'NO_PROPOSALS');
  assert.equal((await collect(autoEditLines({ identity: ID, mode: '__proto__', transcript, cache: memory() })))[0].code, 'FAILED');
});

test('an answer is kept per version: asked again it is cached, a raised version asks afresh', async () => {
  const cache = memory();
  await collect(autoEditLines({ identity: ID, mode: 'filler_words', transcript, cache }));
  const again = await collect(autoEditLines({ identity: ID, mode: 'filler_words', transcript, cache }));
  assert.deepEqual(again.map(line => [line.type, line.cached]), [['complete', true]]);
  const next = await collect(autoEditLines({ identity: ID, mode: 'filler_words', transcript, cache }, { ...rules, algorithm_version: 2 }));
  assert.equal(next.at(-1).cached, false);
});

test('a filler added to the DATA list is cut, and the text stream decodes back to the same lines', async () => {
  const text = [];
  for await (const chunk of autoEditText({ identity: ID, mode: 'filler_words', transcript, cache: memory() }, { ...rules, fillers: ['hello'] })) text.push(chunk);
  const { lines, rest, unreadable } = decodeSuggestionLines(text.join(''));
  assert.equal(rest, '');
  assert.deepEqual(unreadable, []);
  assert.deepEqual(lines.at(-1).proposals.map(item => item.start), [0]);
  assert.equal(timedWords({ segments: [{ words: [word('a', 0, 1), { word: 'b', start: 'x' }] }] }).length, 1);
});
