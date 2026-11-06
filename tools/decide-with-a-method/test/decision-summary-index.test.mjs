// Ported from old trillion test/decision-summary-index.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. engine.summaries and engine.page (src/engine.mjs over src/decision-store.mjs's
// created_at index) are tool:see-my-decisions (read-data/work-screen.mjs seeMyDecisions) over the records door, whose
// decision list is read newest first by `decision/created_at` and one bounded page at a time (`native_collection_page`,
// `before`, `next_before`); engine.related is tool:bring-back-similar-decisions (read-data/similar-decisions.mjs). The
// old record-read counts are records crossed at the door (old-engine-for-tests.mjs `counting`). A page is the screen's
// `limit` (read-data/work-screen.json), not a count the caller names, so "the newest one" is the newest page.
// Left out, no running owner: the pursuit snapshot shared across calls until a pursuit changes (each tool call reads
// through the door; nothing keeps a snapshot between calls), DecisionEngine.notCarriedOut and undecidedMessages (the
// third, fourth and sixth tests: tools/run-rules-and-schedules-by-themselves/src/keep-running.mjs takes their rows as
// input, src/keep-running.mjs:68-76, and nothing computes them; searched the three repos for notCarriedOut,
// undecidedMessages and graceMinutes: only that input and the moved closure keep-and-wake.../src/decision-store.mjs),
// and engine.page's `status` filter with its `scan` (seeMyDecisions takes no status; searched for a status filter on a
// decision page: none).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seeMyDecisions } from '../read-data/work-screen.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { memoryDoor } from './fixtures.mjs';
import { counting, settings } from './old-engine-for-tests.mjs';

const screen = JSON.parse(readFileSync(new URL('../read-data/work-screen.json', import.meta.url), 'utf8'));
const decision = (id, at, goal) => ({
  id,
  input: { goal, options: [{ id: 'yes', label: 'Yes' }] },
  status: 'needs_decision',
  created_at: at,
  cited_pursuits: { 'pursuit:one': 'helps' },
});
const page = (door, before) => seeMyDecisions({ native_collection_page: true, ...(before ? { before } : {}) }, { door });

test('decision summaries read only the newest saved decisions', async () => {
  const base = memoryDoor();
  const first = decision('case:first', '2026-09-29T10:00:00Z', 'First');
  const second = decision('case:second', '2026-09-29T11:00:00Z', 'Second');
  // Older decisions than a page holds: none of them is read.
  for (let n = 0; n < screen.limit + 20; n += 1) base.put(`case:older-${n}`, 'decision', decision(`case:older-${n}`, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), `Older ${n}`));
  base.put(first.id, 'decision', first);
  base.put(second.id, 'decision', second);
  base.put('pursuit:one', 'pursuit', { id: 'pursuit:one', title: 'One' });
  const door = counting(base);
  const answer = await page(door);
  assert.deepEqual(answer.summaries.slice(0, 2).map(row => row.goal), ['Second', 'First']);
  const read = new Set(door.take().listed.filter(item => item.type === 'decision').map(item => item.id));
  // A page of `limit` reads limit + 1 rows to see whether more come, and one more to see past those (work-screen.mjs firstRows).
  assert.ok(read.size <= screen.limit + 2, `${read.size} decisions read for a page of ${screen.limit}`);
  assert.ok(!read.has(`case:older-0`), 'the oldest decision is not read');

  base.put(first.id, 'decision', { ...first, status: 'needs_outcome', input: { ...first.input, goal: 'Changed' } });
  assert.deepEqual((await page(door)).summaries.slice(0, 2).map(row => row.goal), ['Second', 'Changed']);
  assert.deepEqual((await page(door)).summaries[0].pursuits, [{ id: 'pursuit:one', title: 'One' }]);

  await base.write([{ id: second.id, type: 'decision', value: null }]);
  assert.deepEqual((await page(door)).summaries.slice(0, 1).map(row => row.goal), ['Changed']);
});

test('every decision is reachable a page at a time through next_before, and a state filter still walks past other states', async () => {
  const door = memoryDoor();
  const at = index => new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
  const total = screen.limit * 2 + 5;
  for (let index = 0; index < total; index += 1) {
    const row = decision(`case:${index}`, at(index), `Goal ${index}`);
    door.put(row.id, 'decision', index === 3 || index === 4 ? row : { ...row, status: 'needs_outcome' });
  }
  // The memory door reads `below` as the records door does: the rows of the order before that value.
  const list = door.list.bind(door);
  door.list = query => (query.below ? (async function* () { for await (const row of list(query)) if (row.value.created_at < query.below) yield row; })() : list(query));
  const walked = [];
  let before;
  for (let pages = 0; pages < 20; pages += 1) {
    const answer = await page(door, before);
    walked.push(...answer.summaries.map(row => row.case_id));
    if (!answer.next_before) break;
    before = answer.next_before;
  }
  assert.equal(walked.length, total);
  assert.equal(new Set(walked).size, total, 'no decision is read twice or missed');
});

// The cost of a comparison is what it is asked to look at, never how many decisions the person has made.
async function readsFor(total, run) {
  const base = memoryDoor();
  const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
  const on = (n, at) => ({ ...decision(`source:m${n}`, at, `Pick the pottery lesson focus ${n}`), source_id: `message:${n}`, method_id: 'message-intake' });
  for (let n = 0; n < total; n += 1) base.put(`source:m${n}`, 'decision', on(n, hoursAgo(100 + n / 100)));
  for (let n = 0; n < 6; n += 1) base.put(`source:r${n}`, 'decision', on(`r${n}`, hoursAgo(5 - n / 10)));
  const door = counting(base);
  const answer = await run(door);
  return { reads: door.take().crossed, answer };
}

test('the similar decisions of a guide read the same for 300 decisions as for 1,200', async () => {
  const similar = door => similarDecisions({ decision_id: 'source:r5', limit: 5 }, { door });
  const small = await readsFor(300, similar);
  const large = await readsFor(1200, similar);
  assert.ok(small.answer.similar_decisions.length > 0, 'the newest decisions are still compared');
  assert.ok(small.reads <= settings.similar.look_back + 20, `${small.reads} records for a look back of ${settings.similar.look_back}`);
  assert.equal(large.reads, small.reads, `related read ${small.reads} records in 300 decisions and ${large.reads} in 1,200`);
});
