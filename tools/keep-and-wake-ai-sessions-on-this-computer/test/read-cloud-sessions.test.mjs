// test/read-cloud-sessions.test.mjs
//
// harness/read-cloud-sessions.mjs cuts a finished cloud session's events down to what it was asked, what it said to
// the person after the last thing it was asked, the pull requests it named, its pushes and the questions it asked.
// Tool results and sub-agent messages are not the person's words, and importing the file runs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whatItSaid } from '../harness/read-cloud-sessions.mjs';

const at = minute => `2026-01-02T03:${String(minute).padStart(2, '0')}:00Z`;
const user = (minute, content, extra = {}) => ({ type: 'user', created_at: at(minute), parent_tool_use_id: null, message: { role: 'user', content }, ...extra });
const assistant = (minute, content, extra = {}) => ({ type: 'assistant', created_at: at(minute), parent_tool_use_id: null, message: { role: 'assistant', content }, ...extra });

test('the task, the later asks and the messages since the last ask are kept apart', () => {
  const said = whatItSaid([
    user(1, 'Make the bakery list sortable.'),
    assistant(2, [{ type: 'text', text: 'Starting on the list.' }]),
    user(3, 'Also keep the old order as a choice.'),
    assistant(4, [{ type: 'text', text: 'Done: both orders. Left: the price column.' }]),
  ]);
  assert.equal(said.first_task, 'Make the bakery list sortable.');
  assert.deepEqual(said.later_user_messages.map(message => message.text), ['Also keep the old order as a choice.']);
  assert.deepEqual(said.final_messages.map(message => message.text), ['Done: both orders. Left: the price column.']);
  assert.equal(said.event_count, 4);
});

test('pull requests and pushes come from tool results and messages, questions from the question tool', () => {
  const said = whatItSaid([
    user(1, 'Ship it.'),
    assistant(2, [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }]),
    user(3, [{ type: 'tool_result', content: 'To https://github.com/example-org/bakery\n * [new branch] side -> side' }]),
    assistant(4, [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: 'Merge now or wait for review?' } }]),
    assistant(5, [{ type: 'text', text: 'Opened https://github.com/example-org/bakery/pull/7 and https://github.com/example-org/bakery/pull/7 again.' }]),
  ]);
  assert.deepEqual(said.pull_requests, ['https://github.com/example-org/bakery/pull/7']);
  assert.equal(said.pushes.length, 1);
  assert.match(said.questions[0], /Merge now or wait for review/);
});

test('a sub-agent message and a tool result are not the person speaking', () => {
  const said = whatItSaid([
    user(1, 'Count the loaves.'),
    user(2, 'sub-agent prompt', { parent_tool_use_id: 'tool-1' }),
    assistant(3, [{ type: 'text', text: 'sub-agent answer' }], { parent_tool_use_id: 'tool-1' }),
    user(4, [{ type: 'tool_result', content: '12 loaves' }]),
    assistant(5, [{ type: 'text', text: 'There are 12 loaves.' }]),
  ]);
  assert.deepEqual(said.later_user_messages, []);
  assert.deepEqual(said.final_messages.map(message => message.text), ['There are 12 loaves.']);
});

test('a session that never answered gives empty parts, not an error', () => {
  const said = whatItSaid([user(1, 'Hello')]);
  assert.deepEqual(said.final_messages, []);
  assert.deepEqual(said.pull_requests, []);
  assert.deepEqual(said.questions, []);
});
