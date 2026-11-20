// tools/search-everything-with-one-question/test/find-tools-by-job.test.mjs
//
// find_tool_for_job (the old tool's held source at tools/list-and-run-my-tools-for-any-ai/source-baselines): a job
// described in plain words finds the Workshop tools that do it. The tools lane of this search answers it: a tool holds some of the job's
// words in its title, job or kit text, and the tool holding the most words ranks first. No all-words rule: a job sentence longer than any
// one tool's title still finds the tool that does it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchEverything } from '../do-work/search-everything.mjs';

const tools = [
  { id: 'tool:count-words', title: 'Count words', job: 'Count the words and characters in a piece of text', kit: 'word count for a document' },
  { id: 'tool:resize-pictures', title: 'Resize pictures', job: 'Make a picture smaller for a web page', kit: 'image scale' },
  { id: 'tool:extract-sound', title: 'Extract sound', job: 'Take the audio track out of a video', kit: 'ffmpeg audio' },
];

test('a job sentence returns the tool that does it first', async () => {
  const answer = await searchEverything({ question: 'count the words in my document', tools, sources: ['workshop'], places: ['written'] });
  assert.equal(answer.results[0]?.id, 'tool:count-words');
  assert.ok(answer.results[0].found_in.includes('written'));
});

test('a job no tool does returns nothing', async () => {
  const answer = await searchEverything({ question: 'translate a letter into french', tools, sources: ['workshop'], places: ['written'] });
  assert.equal(answer.results.filter(hit => String(hit.id).startsWith('tool:')).length, 0);
});

test('a job with words from two tools ranks the one holding more words first', async () => {
  const answer = await searchEverything({ question: 'cut the audio from a video clip', tools, sources: ['workshop'], places: ['written'] });
  assert.equal(answer.results[0]?.id, 'tool:extract-sound');
});

test('a blank job finds nothing, and a search without tools is unchanged', async () => {
  const blank = await searchEverything({ question: '   ', tools, sources: ['workshop'], places: ['written'] });
  assert.equal(blank.results.length, 0);
  const without = await searchEverything({ question: 'count the words', sources: ['workshop'], places: ['written'] });
  assert.ok(!without.unavailable.some(item => item.lane === 'tools'), 'no tools lane is asked when no tools are handed in');
  assert.ok(!without.results.some(hit => String(hit.id).startsWith('tool:')));
});
