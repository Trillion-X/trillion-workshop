// The two commands as the container runs them: one JSON request on standard input, one JSON line out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const command = name => fileURLToPath(new URL(`../do-work/${name}.mjs`, import.meta.url));

async function ask(name, request) {
  const child = run('node', [command(name)]);
  child.child.stdin.end(JSON.stringify(request));
  try { return JSON.parse((await child).stdout.trim()); } catch (error) { return JSON.parse(error.stdout.trim()); }
}

test('rank-open-trip-things answers { result } for a trip and { error } for a request with no policy', async () => {
  const policy = { priority_order: ['now', 'later', 'closed'], lanes: { chores: { default_priority: 'later', priority_by_status: { late: 'now', done: 'closed' } } } };
  const answered = await ask('rank-open-trip-things', { policy, lanes: [{ id: 'chores', rows: [{ id: 'a', status: 'done' }, { id: 'b' }, { id: 'c', status: 'late' }] }] });
  assert.deepEqual(answered.result.items.map(item => item.id), ['chores:c', 'chores:b', 'chores:a']);
  assert.equal(answered.result.focus.id, 'chores:c');
  const refused = await ask('rank-open-trip-things', { lanes: [{ id: 'chores', rows: [] }] });
  assert.match(refused.error, /policy must be an object/);
});

test('measure-a-checklist answers the share done and refuses a request without its status lists', async () => {
  const answered = await ask('measure-a-checklist', { items: [{ id: 'a', status: 'ok' }, { id: 'b' }], done_statuses: ['ok'], skipped_statuses: [] });
  assert.deepEqual([answered.result.done, answered.result.total, answered.result.ratio], [1, 2, 0.5]);
  const refused = await ask('measure-a-checklist', { items: [] });
  assert.match(refused.error, /done_statuses must be a list/);
});
