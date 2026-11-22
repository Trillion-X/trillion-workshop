// tools/record-voice-and-meetings/test/transcript-empty-state.test.mjs
//
// A kept recording with no words says so: the Record screen draws the shared empty state from the transcript's DATA
// words, never an empty box with only a copy mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const words = JSON.parse(await readFile(new URL('../read-data/transcript-words.json', import.meta.url), 'utf8'));
const screen = await readFile(new URL('../web/src/workspace/record-screen.tsx', import.meta.url), 'utf8');

test('the empty transcript words are plain and say what happened', () => {
  assert.ok(words.empty.title.length > 0);
  assert.ok(words.empty.description.length > 0);
  assert.doesNotMatch(words.empty.title + words.empty.description, /[{}<>\[\]`]|::|\/src\//);
});

test('a kept recording with no words draws the shared empty state, not the words box', () => {
  assert.match(screen, /saving\.state === 'saved' && !saving\.kept\.words\.trim\(\)/);
  assert.match(screen, /<ScreenState state=\{\{ status: 'empty', icon: 'Mic', title: transcriptWords\.empty\.title/);
});
