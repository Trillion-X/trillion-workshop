// test/board-bytes-bounded.test.mjs
//
// How many bytes the AI work board answers with. On 2026-10-08 (store-memory lane H, probes on the person's live store)
// the board read through tool:read-work-tree was 2.37 MB for 250 open jobs: every job came whole (its words, inputs,
// results, attempts), the answer is carried twice by the tool envelope, and the download alone took 1.3 s of a call that
// had to answer in under 2 s. This test seeds large open jobs and fails when a page grows with the jobs' size or count:
// the screen's rows carry only what the screen draws, and a page of whole jobs ends at a byte budget and reads on
// through next_before, reaching every job once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

const BIG = 6_000;
// The board cuts a page of jobs at 150 KB of JSON; one more job may end it, so a page is never more than this.
const PAGE_BYTES = 150_000 + 2 * (2 * BIG + 2_000);
// What one row of the screen may weigh whatever the job's words: its short title, state, who and when.
const SCREEN_ROW_BYTES = 1_500;
const bytes = answer => JSON.stringify(answer).length;

function seeded(open, finished = 0) {
  let time = Date.parse('2026-09-29T12:00:00Z');
  const agents = makeAgents({ store: agentStoreForTests(), now: () => new Date(time += 1000) });
  agents.publish({ agent_id: 'coder', name: 'Coder', description: 'Codes', takes_work: true, capacity: { max_concurrent: 5 } });
  const ids = [];
  for (let index = 0; index < open + finished; index += 1) {
    const { handoff } = agents.handOff({ job: `Job ${index}: ${'x'.repeat(BIG)}`, request_key: `job-${index}`, input: { notes: 'y'.repeat(BIG) } });
    ids.push(handoff.handoff_id);
  }
  // The oldest jobs are the ones taken first, and finished.
  const done = [];
  for (let index = 0; index < finished; index += 1) {
    const taken = agents.take({ agent_id: 'coder' });
    agents.finish({ handoff_id: taken.handoff.handoff_id, agent_id: 'coder', generation: taken.generation, result: 'z'.repeat(BIG), summary: 'w'.repeat(BIG) });
    done.push(taken.handoff.handoff_id);
  }
  return { agents, ids, done };
}

test('the screen rows weigh the same whatever a job says, and four times the jobs weigh about four times as much', () => {
  const small = seeded(20).agents.board({ rows: 'screen', limit: 100 });
  const large = seeded(80).agents.board({ rows: 'screen', limit: 100 });
  assert.equal(small.work.length, 20);
  assert.equal(large.work.length, 80);
  assert.ok(bytes(large) <= bytes(small) * 4.5, `4N jobs weigh ${bytes(large)} bytes against ${bytes(small)} for N`);
  for (const row of large.work) {
    assert.ok(bytes(row) <= SCREEN_ROW_BYTES, `a screen row weighs ${bytes(row)} bytes`);
    for (const key of ['input', 'result', 'attempts', 'effects', 'corrections']) assert.ok(!(key in row), `the screen row carries no ${key}`);
    assert.ok(row.said.length > 0, 'the title the screen draws is still there');
  }
});

test('a page of whole jobs ends at the byte budget, N or 4N open jobs', () => {
  const first = seeded(50).agents.board({});
  const four = seeded(200).agents.board({});
  assert.ok(bytes(first) <= PAGE_BYTES && bytes(four) <= PAGE_BYTES, `${bytes(first)} and ${bytes(four)} bytes`);
  assert.ok(Math.abs(bytes(four) - bytes(first)) <= bytes(first) * 0.15, 'four times the open jobs does not make the first page bigger');
  assert.ok(first.next_before && four.next_before, 'the rest is read on through next_before');
});

test('reading on from each page reaches every job once, open work first and the finished work after it', () => {
  const { agents, ids, done } = seeded(227, 3);
  const finished = new Set(done);
  const seen = [];
  let before = null;
  for (let page = 0; page < 200; page += 1) {
    const answer = agents.board(before ? { before } : {});
    assert.ok(bytes(answer) <= PAGE_BYTES, `page ${page} weighs ${bytes(answer)} bytes`);
    seen.push(...answer.work.map(job => job.handoff_id));
    before = answer.next_before;
    if (!before) break;
  }
  assert.equal(before, null, 'the walk ends');
  assert.equal(seen.length, ids.length);
  assert.deepEqual(new Set(seen), new Set(ids), 'every job once');
  assert.ok(seen.slice(-3).every(id => finished.has(id)), 'the finished work comes after the open work');
});
