// test/said-done-tool.test.mjs
// The two command wrappers of the said-done steps (do-work/name-the-open-rows.mjs and do-work/decide-said-done.mjs), run the way
// the container runs them: `node <script> <json>` with one JSON line on stdout. The step logic is in test/said-done-steps.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const run = (script, input) => JSON.parse(execFileSync('node', [resolve(here, '..', 'do-work', script), JSON.stringify(input)], { encoding: 'utf8' }));

const list = { id: 'chores', row_type: 'chores', title_field: 'what', fields: [
  { id: 'what', kind: 'text' }, { id: 'done_when', kind: 'text' }, { id: 'status', kind: 'choice', choices: ['Waiting', 'Done'], settles: ['Done'] },
] };
const rows = [{ record_id: 'record:chores:plugin', row_id: 'plugin', list, field: list.fields[2], values: { what: 'Upload the plugin', done_when: 'It is listed', status: 'Waiting' } }];
const message = { id: 'message:1', app: 'Claude Code', text: 'I uploaded the plugin already', speaker: 'person' };

test('naming the rows gives one ask with its question and settle values, through the container command', () => {
  const { asks } = run('name-the-open-rows.mjs', { message, rows, names: { finish: 'Tell the AIs' } });
  assert.equal(asks.length, 1);
  assert.match(asks[0].question.state, /I uploaded the plugin already/);
  assert.equal(asks[0].values.status, 'Done');
});

test('naming the rows gives no asks for history brought in or for AI words', () => {
  assert.deepEqual(run('name-the-open-rows.mjs', { message, rows, names: { finish: 'Tell the AIs' }, brought_in: true }).asks, []);
  assert.deepEqual(run('name-the-open-rows.mjs', { message: { ...message, speaker: 'ai' }, rows, names: { finish: 'Tell the AIs' } }).asks, []);
});

test('a bad name input is refused by the command, not guessed at', () => {
  assert.throws(() => run('name-the-open-rows.mjs', { message, rows: 'nope', names: { finish: 'x' } }));
  assert.throws(() => run('decide-said-done.mjs', { ask: {}, probability: 2 }));
});

test('deciding the answer: a yes settles, a no changes nothing, an unknown answer is handed on', () => {
  const { asks } = run('name-the-open-rows.mjs', { message, rows, names: { finish: 'Tell the AIs' } });
  const yes = run('decide-said-done.mjs', { ask: asks[0], probability: 0.92, message });
  assert.equal(yes.verdict, 'done');
  assert.equal(yes.settle.values.status, 'Done');
  assert.deepEqual(run('decide-said-done.mjs', { ask: asks[0], probability: 0.1, message }), { verdict: 'not_said', probability: 0.1 });
  const silent = run('decide-said-done.mjs', { ask: asks[0], probability: null, message });
  assert.equal(silent.verdict, 'no_classifier');
  assert.equal(silent.hand.once_per, `said-done:message:1:record:chores:plugin`);
});
