// Ported from old trillion test/caller-run-claim.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. src/workshop.mjs and harness/wake-handlers/run-tools-here.mjs are this tool's;
// the old test/workshop-tasks-for-tests.mjs taskQuestions (held in tools/keep-each-workshop-task-whole-and-a-small-index,
// its src/workshop-tasks.mjs not running) is stood in below over the same empty list. Every assertion is the old one.
// A run handed to the caller's own computers (for_you_to_run) is claimed by one computer before its command runs
// (src/workshop.mjs claimCallerRun, harness/wake-handlers/run-tools-here.mjs), so two computers that both heard it never
// both run it; a claim left by a computer that stopped can be followed after its lease.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkshop, readToolData } from '../src/workshop.mjs';
import { handle } from '../harness/wake-handlers/run-tools-here.mjs';

// The store's task questions over an empty list of current tasks (old test/workshop-tasks-for-tests.mjs taskQuestions).
const taskQuestions = () => ({ dueTasks: async () => [], nextDueAt: async () => null, lastCompleted: async () => null, taskCards: async () => [] });

const later = () => new Promise(resolve => setImmediate(resolve));
function host(task, clock) {
  const tasks = new Map([[task.task_id, task]]);
  // Every read and write yields first, as a store's does, so two claims interleave.
  const store = { readTask: async id => { await later(); return tasks.get(id) ?? null; }, writeTask: async next => { await later(); tasks.set(next.task_id, next); },
    ...taskQuestions(async () => []), readSavedTools: async () => [], writeSavedTool: async () => {}, putBytes: async () => {} };
  const workshop = makeWorkshop({ host: 'hosted', data: async () => readToolData([]), executors: {}, pool: { recordRun: async () => {}, recordReport: async () => {}, stats: async () => ({}) }, store, now: () => new Date(clock.at) });
  return { workshop, tasks };
}

test('two computers claiming one run at once: exactly one gets it', async () => {
  const clock = { at: Date.parse('2026-10-09T10:00:00Z') };
  const { workshop, tasks } = host({ task_id: 'task_one', tool_id: 'tool:x', state: 'for_you_to_run', placement: 'caller-sandbox' }, clock);
  const [a, b] = await Promise.all([workshop.claim({ task_id: 'task_one', by: 'computer-a', lease_seconds: 600 }), workshop.claim({ task_id: 'task_one', by: 'computer-b', lease_seconds: 600 })]);
  assert.deepEqual([a.claimed, b.claimed].sort(), [false, true]);
  assert.equal(tasks.get('task_one').claimed_by, a.claimed ? 'computer-a' : 'computer-b');
  assert.equal((a.claimed ? b : a).claimed_by, a.claimed ? 'computer-a' : 'computer-b');
});

test('a claim is held for its lease, then another computer may follow one that stopped', async () => {
  const clock = { at: Date.parse('2026-10-09T10:00:00Z') };
  const { workshop } = host({ task_id: 'task_two', tool_id: 'tool:x', state: 'for_you_to_run', placement: 'caller-sandbox' }, clock);
  assert.equal((await workshop.claim({ task_id: 'task_two', by: 'computer-a', lease_seconds: 120 })).claimed, true);
  assert.equal((await workshop.claim({ task_id: 'task_two', by: 'computer-b', lease_seconds: 120 })).claimed, false);
  assert.equal((await workshop.claim({ task_id: 'task_two', by: 'computer-a', lease_seconds: 120 })).claimed, true, 'the holder may claim again');
  clock.at += 121_000;
  assert.equal((await workshop.claim({ task_id: 'task_two', by: 'computer-b', lease_seconds: 120 })).claimed, true);
});

test('a run that is no longer waiting for a computer is not claimed', async () => {
  const clock = { at: Date.parse('2026-10-09T10:00:00Z') };
  const { workshop } = host({ task_id: 'task_three', tool_id: 'tool:x', state: 'completed' }, clock);
  assert.deepEqual(await workshop.claim({ task_id: 'task_three', by: 'computer-a' }), { claimed: false, state: 'completed' });
});

test('a computer that does not get the claim leaves the run to the one that did, and runs nothing', async () => {
  let ran = 0;
  const said = await handle({
    event: { refs: { task_id: 'task_four' } },
    helper: { agent_id: 'computer-b', runs: ['caller-sandbox'] },
    read: async () => ({ task_id: 'task_four', tool_id: 'tool:x', state: 'for_you_to_run', placement: 'caller-sandbox', input: {} }),
    call: async path => (path.endsWith('/claim') ? { claimed: false, state: 'for_you_to_run', claimed_by: 'computer-a' } : (() => { throw new Error(`no call to ${path} was expected`); })()),
    run: async () => { ran += 1; return { code: 0, stdout: '', stderr: '' }; },
    workFolder: () => { throw new Error('no folder is made for a run another computer holds'); },
    rules: { wake_timeout_seconds: 600 },
  });
  assert.equal(ran, 0);
  assert.match(said.skipped, /another computer/);
});
