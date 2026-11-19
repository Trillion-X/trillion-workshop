// suggestMediaCuts: the cut suggestions for one recording, as values. The old tool's store calls (the words and the kept
// suggestions read, the merge written) are the caller's now: the recipe keeps them, and the lane proof checks equal answers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestMediaCuts } from '../src/media-tools.mjs';

const IDENT = `1f:${'a'.repeat(64)}`;
const TRANSCRIPT = { segments: [{ words: [
  { word: 'so', start: 0, end: 0.4 }, { word: 'um', start: 0.5, end: 0.8 }, { word: 'today', start: 0.9, end: 1.3 },
  { word: 'we', start: 5.0, end: 5.2 }, { word: 'go', start: 5.3, end: 5.6 }, { word: 'uh', start: 5.7, end: 6.0 }, { word: 'now', start: 6.1, end: 6.5 },
] }] };

test('filler words are proposed as cuts, and the entry to keep comes back with the answer', async () => {
  const answer = await suggestMediaCuts({ identity: IDENT, mode: 'filler_words', transcript: TRANSCRIPT, kept: {} });
  assert.deepEqual(answer.proposals.map(p => [p.start, p.end, p.reason]).sort((a, b) => a[0] - b[0]), [[0.5, 0.8, 'filler'], [5.7, 6, 'filler']]);
  assert.ok(Object.keys(answer.keep).length > 0, 'the caller keeps what the answer names');
});

test('an ask answered by a kept entry is marked cached and keeps nothing new', async () => {
  const first = await suggestMediaCuts({ identity: IDENT, mode: 'filler_words', transcript: TRANSCRIPT, kept: {} });
  const again = await suggestMediaCuts({ identity: IDENT, mode: 'filler_words', transcript: TRANSCRIPT, kept: first.keep });
  assert.equal(again.lines.find(line => line.type === 'complete').cached, true);
  assert.deepEqual(again.keep, {});
});

test('no transcript says so in words, and a recording not named by its identity is refused', async () => {
  const none = await suggestMediaCuts({ identity: IDENT, mode: 'silent_pauses', transcript: null, kept: {} });
  assert.ok(none.lines.some(line => line.type === 'error' && line.code === 'NO_TRANSCRIPT'));
  await assert.rejects(suggestMediaCuts({ identity: 'talk.mp4', mode: 'filler_words' }), /content identity/);
});
