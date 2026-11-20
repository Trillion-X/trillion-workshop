// Ported from the old PersonStore.jobRun read (the old repository src/person-store.mjs:2897, tag b6ae0ebf81) onto
// tools/hand-work-to-ais/read-data/job-run.mjs. Asserts the choice of jobs, the null for an unknown handoff, the empty
// waiting run for a message with no work, and the held plan's job. Steps are not ported (see the module header).
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { liveWork } from '../../hand-off-jobs-between-agents/src/live-work.mjs';
import { agentRecordStore } from '../../shared-code/src/agent-records.mjs';
import { jobRunOf } from '../read-data/job-run.mjs';

function opened() {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let saved = null;
  const agents = makeAgents({ store: { ...agentRecordStore({ records, transaction: host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } } });
  return { agents, liveJobs: liveWork({ sql: host.sql }) };
}

test('a message run holds the jobs it handed on, with the parts handed on from each', { timeout: 120000 }, () => {
  const { agents, liveJobs } = opened();
  const kept = agents.handOff({ request_key: 'run-1', job: 'Write the hook', said: 'Write the hook', input: { arrived: { message_id: 'message:run-1' } } }).handoff;
  const part = agents.handOff({ request_key: 'run-1-part', job: 'Find the opening line', parent_handoff_id: kept.handoff_id }).handoff;
  const run = jobRunOf({ message: 'message:run-1' }, { agents, liveJobs });
  assert.deepEqual(run.jobs.map(job => job.handoff_id), [kept.handoff_id, part.handoff_id]);
  assert.deepEqual(run.steps, []);
  assert.equal(run.handoff, null);
});

test('an addressed handoff with no job on this account is null; a message with no work yet is an empty run', { timeout: 120000 }, () => {
  const { agents, liveJobs } = opened();
  assert.equal(jobRunOf({ handoff: 'h_missing' }, { agents, liveJobs }), null);
  const empty = jobRunOf({ message: 'message:none' }, { agents, liveJobs });
  assert.deepEqual(empty.jobs, []);
  assert.deepEqual(empty.actors, []);
});

test('a parent handoff reads its own job and its parts, and progress is counted over the parts', { timeout: 120000 }, () => {
  const { agents, liveJobs } = opened();
  const parent = agents.handOff({ request_key: 'parent-1', job: 'Plan the thread' }).handoff;
  agents.handOff({ request_key: 'parent-1-a', job: 'Part A', parent_handoff_id: parent.handoff_id });
  const run = jobRunOf({ handoff: parent.handoff_id }, { agents, liveJobs });
  assert.equal(run.jobs[0].handoff_id, parent.handoff_id);
  assert.equal(run.jobs.length, 2);
  assert.ok(run.progress, 'a job with parts carries its progress count');
});

test('a held job on a plan that keeps nothing is drawn by its own id', { timeout: 120000 }, () => {
  const { agents, liveJobs } = opened();
  liveJobs.put({ asked_id: 'queued-press:held', job: 'Write this as a thread', said: 'Write this as a thread' });
  const run = jobRunOf({ message: 'queued-press:held' }, { agents, liveJobs });
  assert.deepEqual(run.jobs.map(job => job.handoff_id), ['queued-press:held']);
});
