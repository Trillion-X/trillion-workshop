// The three attachment cases are carried from bitfield-packages/packages/tasks/read-data/read-tasks.test.ts (vitest
// become node:test, same facts, same expectations). The blocker and default cases, and the two run-the-row cases,
// are added at the Workshop seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { decodeTasksFeed } from '../read-data/read-tasks.ts';

const fact = (subject_id, property_id, value) => ({ subject_id, property_id, value });

test('decodeTasksFeed surfaces attachment refs as opaque strings', () => {
  const tasks = decodeTasksFeed([
    fact('task:1', 'prop:task:title', 'Ship the launch plan'),
    fact('task:1', 'prop:task:status', 'in_progress'),
    fact('task:1', 'prop:task:attachments', ['package::documents::authored-thing::launch-plan', 'exports/launch-plan.md']),
  ]);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].attachments, ['package::documents::authored-thing::launch-plan', 'exports/launch-plan.md']);
});

test('decodeTasksFeed defaults to an empty attachments list', () => {
  assert.deepEqual(decodeTasksFeed([fact('task:2', 'prop:task:title', 'No attachments')])[0].attachments, []);
});

test('decodeTasksFeed ignores non-array attachment values', () => {
  const tasks = decodeTasksFeed([fact('task:3', 'prop:task:title', 'Bad value'), fact('task:3', 'prop:task:attachments', 'not-an-array')]);
  assert.deepEqual(tasks[0].attachments, []);
});

test('each task names what it blocks from what blocks the others, once', () => {
  const tasks = decodeTasksFeed([
    fact('task:a', 'prop:task:title', 'First'),
    fact('task:b', 'prop:task:title', 'Second'),
    fact('task:b', 'prop:task:blocked_by', ['task:a', 'task:a', 'task:missing']),
  ]);
  assert.deepEqual(tasks.find(task => task.id === 'task:a').blocks, ['task:b']);
  assert.deepEqual(tasks.find(task => task.id === 'task:b').blockedBy, ['task:a', 'task:a', 'task:missing']);
});

test('a task is pending at medium priority when nobody said otherwise', () => {
  const [task] = decodeTasksFeed([fact('task:c', 'prop:task:title', 'Plain')]);
  assert.deepEqual([task.status, task.priority], ['pending', 'MEDIUM']);
});

const command = new URL('../do-work/list-tasks-and-what-blocks-them.mjs', import.meta.url).pathname;
const run = input => spawnSync(process.execPath, [command, JSON.stringify(input)], { encoding: 'utf8' });

test('the command prints the tasks with what each blocks', () => {
  const answer = run({ rows: [fact('task:a', 'prop:task:title', 'First'), fact('task:b', 'prop:task:blocked_by', ['task:a'])] });
  assert.equal(answer.status, 0, answer.stderr);
  const { tasks } = JSON.parse(answer.stdout.trim().split('\n').at(-1));
  assert.deepEqual(tasks.map(task => [task.id, task.blocks]), [['task:a', ['task:b']], ['task:b', []]]);
});

test('the command refuses rows that are not a list', () => {
  const answer = run({ rows: 'nope' });
  assert.equal(answer.status, 2);
  assert.match(answer.stderr, /rows must be a list/);
});
