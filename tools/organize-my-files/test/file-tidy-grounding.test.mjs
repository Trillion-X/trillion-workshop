// test/file-tidy-grounding.test.mjs
// A suggested title or new folder is grounded in what is kept about the file (src/file-tidy.mjs `grounding`): the
// old tidy test refused a title and a folder the evidence does not mention, and kept a title it does mention. Checked
// here on the grounding check itself, with the words and thresholds the tool reads from src/file-tidy.json. The rest of
// the old tidy test (propose, apply, undo, history) needs the results store, which is not in this tool yet.
import assert from 'node:assert/strict';
import test from 'node:test';
import { grounding } from '../src/file-tidy.mjs';

const LESSON = 'Today we work on the kick serve: toss the ball over your head, brush up the back of the ball, and finish high.';
const SUMMARY = 'Buy oat milk, bread and coffee beans for the week.';

test('a title the transcript does not mention is refused, and one it mentions is not', () => {
  const judge = grounding();
  const transcript = judge.mentioned(LESSON);
  assert.deepEqual(judge.titleMissing('Quarterly revenue planning meeting', transcript), ['quarterly', 'revenue', 'planning', 'meeting']);
  assert.equal(judge.titleMissing('Kick serve toss', transcript), null);
});

test('a title the summary does not mention is refused for that evidence', () => {
  const judge = grounding();
  assert.deepEqual(judge.titleMissing('Kick serve', judge.mentioned(SUMMARY)), ['kick', 'serve']);
  assert.deepEqual(judge.titleMissing('Groceries for the week', judge.mentioned(SUMMARY)), ['groceries']);
  assert.equal(judge.titleMissing('Oat milk and bread', judge.mentioned(SUMMARY)), null);
});

test('a new folder the evidence does not mention is unsupported; one it mentions is not', () => {
  const judge = grounding();
  const transcript = judge.mentioned(LESSON);
  assert.equal(judge.unsupported('Accounting', transcript), true);
  assert.equal(judge.unsupported('Kick serve', transcript), false);
});

test('a title made only of container words is not judged', () => {
  const judge = grounding();
  assert.equal(judge.titleMissing('Recording notes', judge.mentioned(SUMMARY)), null);
});
