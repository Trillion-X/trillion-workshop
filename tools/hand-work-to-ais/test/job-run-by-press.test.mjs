// Ported from old trillion test/job-run-by-press.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The retired PersonStore.jobRun chose a run's jobs in one line: the held job a plan that keeps
// nothing made (src/live-work.mjs, now tools/hand-off-jobs-between-agents/src/live-work.mjs) when it holds the id, else
// agents.fromMessage (tools/shared-code/src/agents.mjs) over this tool's agentRecordStore; `jobsOf` below is that line,
// over a counting SQLite handle. The rest of jobRun (the activity steps and actor cards it drew beside the jobs) is not
// asked by this test. Every assertion is the old one.
//
// A button press (Have my AI write it, any QueueJobButton) is shown live by the press's own asked_id, the id the store
// hands the job on with: the run finds the kept job a press started (its arrival names the asked_id, agents.mjs
// fromMessage) and the held job a plan that keeps nothing made, and it finds the kept one through an index, never by
// reading every job the store holds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { liveWork } from '../../hand-off-jobs-between-agents/src/live-work.mjs';
import { agentRecordStore } from '../agent-records.mjs';

const OTHERS = 400;
const PAGE = 50;

function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    reads.push({ query, params, rows: cursor.toArray().length });
    return cursor;
  } };
  return { host, sql, take: () => reads.splice(0) };
}

test('the work a press started is read by its asked_id, kept or held, without reading every job', { timeout: 300000 }, async () => {
  const store = countingHost();
  const records = openRecords(store.sql, { transaction: store.host.transaction, hash: text => text });
  let saved = null;
  const agents = makeAgents({ store: { ...agentRecordStore({ records, transaction: store.host.transaction }),
    savedInstructions: () => structuredClone(saved), putSavedInstructions: list => { saved = structuredClone(list); } } });
  const liveJobs = liveWork({ sql: store.sql });
  // The jobs of a run, as PersonStore.jobRun chose them for a message.
  const jobsOf = message => (liveJobs.holds(message) ? liveJobs.list().filter(job => job.handoff_id === message) : agents.fromMessage(message));
  const person = { jobRun: ({ message }) => ({ message, jobs: jobsOf(message) }), liveJobs };
  for (let i = 0; i < OTHERS; i += 1) agents.handOff({ request_key: `other-${i}`, job: `Other job ${i}`, input: { arrived: { message_id: `message:${i}` } } });
  const kept = agents.handOff({ request_key: 'press-1', job: 'Write this as a Hook and story', said: 'Write this as a Hook and story', input: { arrived: { asked_id: 'queued-press:one' } } }).handoff;
  const part = agents.handOff({ request_key: 'press-1-part', job: 'Find the opening line', parent_handoff_id: kept.handoff_id }).handoff;

  store.take();
  const run = person.jobRun({ message: 'queued-press:one' });
  const heavy = store.take().filter(read => read.rows > PAGE).map(read => `${read.rows} rows: ${read.query.replace(/\s+/g, ' ').slice(0, 120)}`);
  assert.deepEqual(run.jobs.map(job => job.handoff_id), [kept.handoff_id, part.handoff_id]);
  assert.deepEqual(heavy, [], 'a press is found through the index, never by reading every job');
  // A message still finds its own work, and a press id never matches a message's.
  assert.deepEqual(person.jobRun({ message: 'message:3' }).jobs.length, 1);
  assert.deepEqual(person.jobRun({ message: 'queued-press:none' }).jobs, []);

  // On a plan that keeps nothing, the press is held for an hour under its asked_id and drawn the same way.
  person.liveJobs.put({ asked_id: 'queued-press:held', job: 'Write this as a thread', said: 'Write this as a thread' });
  assert.deepEqual(person.jobRun({ message: 'queued-press:held' }).jobs.map(job => job.handoff_id), ['queued-press:held']);
});
