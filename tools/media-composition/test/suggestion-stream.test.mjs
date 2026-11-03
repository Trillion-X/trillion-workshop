// test/suggestion-stream.test.mjs
//
// A suggestion arrives as typed lines (tools/media-composition/read-data/suggestion-stream.mjs): watched while it works, kept for
// the algorithm version that made it, stopped when asked, ended with a typed code, and driven here by the real cleanup detector.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../read-data/suggestion-stream.json' with { type: 'json' };
import { decodeSuggestionLines, encodeSuggestionLine, runSuggestion } from '../read-data/suggestion-stream.mjs';
import { detectCleanupSpans } from '../read-data/auto-cleanup.ts';

const memory = () => { const rows = new Map(); return { rows, get: async (id) => rows.get(id), set: async (id, entry) => { rows.set(id, entry); } }; };
const collect = async (iterable) => { const lines = []; for await (const line of iterable) lines.push(line); return lines; };
const words = [{ text: 'So', start: 0, end: 0.3 }, { text: 'um', start: 0.4, end: 0.6 }, { text: 'the', start: 3.0, end: 3.2 }, { text: 'plan', start: 3.3, end: 3.8 }];
const cleanup = (spans) => async function* produce({ settings }) {
  yield { type: 'thinking', text: `looking at ${words.length} words` };
  yield { type: 'complete', proposals: spans(settings) };
};
const spansOf = (settings) => detectCleanupSpans(words, settings).map(({ start, end, reason }) => ({ start, end, reason }));

test('a suggestion is status, thinking, then the proposals as data, driven by a row of modes', async () => {
  const lines = await collect(runSuggestion({ input: 'rec1', mode: 'silent_pauses', algorithm_version: 1, produce: cleanup(spansOf), cache: memory() }));
  assert.deepEqual(lines.map((line) => line.type), ['status', 'thinking', 'complete']);
  assert.deepEqual(lines[2].proposals, [{ start: 0.7, end: 2.9, reason: 'silence' }]);
  assert.equal(lines[2].cached, false);
  const fillers = await collect(runSuggestion({ input: 'rec1', mode: 'filler_words', algorithm_version: 1, produce: cleanup(spansOf), cache: memory() }));
  assert.deepEqual(fillers.at(-1).proposals.map((span) => span.reason), ['filler', 'filler']);
});

test('asking again is answered from what was kept, until the algorithm version changes', async () => {
  const cache = memory();
  let runs = 0;
  const produce = (...args) => { runs += 1; return cleanup(spansOf)(...args); };
  await collect(runSuggestion({ input: 'rec1', mode: 'silent_pauses', algorithm_version: 1, produce, cache }));
  const again = await collect(runSuggestion({ input: 'rec1', mode: 'silent_pauses', algorithm_version: 1, produce, cache }));
  assert.deepEqual(again.map((line) => [line.type, line.cached]), [['complete', true]]);
  assert.equal(runs, 1);
  const newer = await collect(runSuggestion({ input: 'rec1', mode: 'silent_pauses', algorithm_version: 2, produce, cache }));
  assert.equal(runs, 2);
  assert.equal(newer.at(-1).cached, false);
  assert.equal(cache.rows.get('rec1:silent_pauses').algorithm_version, 2);
  const otherMode = await collect(runSuggestion({ input: 'rec1', mode: 'filler_words', algorithm_version: 2, produce, cache }));
  assert.equal(otherMode.at(-1).cached, false, 'another mode is another suggestion');
});

test('nothing to suggest, a producer that fails, and a stop each end in their own typed code and keep nothing', async () => {
  const cache = memory();
  const none = await collect(runSuggestion({ input: 'r', mode: 'silent_pauses', algorithm_version: 1, produce: cleanup(() => []), cache }));
  assert.deepEqual(none.at(-1), { type: 'error', code: 'NO_PROPOSALS', message: rules.errors.NO_PROPOSALS });
  const failed = await collect(runSuggestion({ input: 'r', mode: 'silent_pauses', algorithm_version: 1, produce: async function* () { throw new Error('model down'); }, cache }));
  assert.equal(failed.at(-1).code, 'FAILED');
  const controller = new AbortController();
  const stopped = await collect(runSuggestion({ input: 'r', mode: 'silent_pauses', algorithm_version: 1, signal: controller.signal, cache,
    produce: async function* () { yield { type: 'thinking', text: 'a' }; controller.abort(); yield { type: 'thinking', text: 'b' }; yield { type: 'complete', proposals: [1] }; } }));
  assert.equal(stopped.at(-1).code, 'ABORTED');
  assert.ok(!stopped.some((line) => line.type === 'complete'));
  assert.equal(cache.rows.size, 0);
});

test('lines are checked against the DATA when written and read, a half line is held back, and a bad line is reported', () => {
  assert.equal(encodeSuggestionLine({ type: 'status', message: 'hi' }), '{"type":"status","message":"hi"}\n');
  assert.throws(() => encodeSuggestionLine({ type: 'status' }), /needs message/);
  assert.throws(() => encodeSuggestionLine({ type: 'dance' }), /unknown/);
  const text = `${encodeSuggestionLine({ type: 'status', message: 'a' })}not json\n{"type":"complete"}\n${encodeSuggestionLine({ type: 'complete', proposals: [1] })}{"type":"thi`;
  const read = decodeSuggestionLines(text);
  assert.deepEqual(read.lines.map((line) => line.type), ['status', 'complete']);
  assert.deepEqual(read.unreadable, ['not json', '{"type":"complete"}']);
  assert.equal(read.rest, '{"type":"thi');
});
