// Ported from old trillion test/decision-summary-index.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. engine.summaries and engine.page (src/engine.mjs over src/decision-store.mjs's
// created_at index) are tool:see-my-decisions (read-data/work-screen.mjs seeMyDecisions) over the records the caller hands
// in, whose decision list is read newest first by `decision/created_at` and one bounded page at a time
// (`native_collection_page`, `before`, `next_before`); engine.related is tool:bring-back-similar-decisions
// (read-data/similar-decisions.mjs). The old record-read counts are records handed to the tool (old-engine-for-tests.mjs
// `counting`). A page is the screen's `limit` (read-data/work-screen.json), not a count the caller names, so "the newest one"
// is the newest page.
// Left out, no running owner: the pursuit snapshot shared across calls until a pursuit changes (each tool call reads
// through the records it is handed; nothing keeps a snapshot between calls), DecisionEngine.notCarriedOut and undecidedMessages (the
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
import { memoryDoor, run } from './fixtures.mjs';
import { counting, settings } from './old-engine-for-tests.mjs';

const screen = JSON.parse(readFileSync(new URL('../read-data/work-screen.json', import.meta.url), 'utf8'));
const decision = (id, at, goal) => ({
  id,
  input: { goal, options: [{ id: 'yes', label: 'Yes' }] },
  status: 'needs_decision',
  created_at: at,
  cited_pursuits: { 'pursuit:one': 'helps' },
});
const page = (door, before) => run(door, seeMyDecisions, { native_collection_page: true, ...(before ? { before } : {}) });
const newestFirst = (a, b) => (a.value.created_at < b.value.created_at ? 1 : -1);

// The records a caller hands: every record except the decisions that are not among the `keep` newest, which it leaves out.
const handingNewest = (store, keep, asked = []) => ({
  all: () => {
    const kept = new Set([...asked, ...store.all().filter(record => record.type === 'decision').sort(newestFirst).slice(0, keep).map(record => record.id)]);
    return store.all().filter(record => record.type !== 'decision' || kept.has(record.id));
  },
  write: list => store.write(list),
});
// A page of `limit` reads limit + 1 decisions to see whether more come.
const newestDecisions = (store, count) => handingNewest(store, count);
// The look back of a similar-decisions read: the asked decision, and the newest `look_back` decisions.
const lookBack = (store, asked) => handingNewest(store, settings.similar.look_back, [asked]);

test('decision summaries are the same whether or not decisions older than a page are handed in', async () => {
  const base = memoryDoor();
  const first = decision('case:first', '2026-09-29T10:00:00Z', 'First');
  const second = decision('case:second', '2026-09-29T11:00:00Z', 'Second');
  // Older decisions than a page holds, each named by its own date.
  for (let n = 0; n < screen.limit + 20; n += 1) base.put(`case:older-${n}`, 'decision', decision(`case:older-${n}`, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), `Older ${n}`));
  base.put(first.id, 'decision', first);
  base.put(second.id, 'decision', second);
  base.put('pursuit:one', 'pursuit', { id: 'pursuit:one', title: 'One' });
  const everything = await page(base);
  assert.deepEqual(everything.summaries.slice(0, 2).map(row => row.goal), ['Second', 'First']);
  // A page of `limit` reads limit + 1 decisions to see whether more come: handing only those changes nothing.
  const door = counting(newestDecisions(base, screen.limit + 1));
  const answer = await page(door);
  assert.deepEqual(answer.summaries, everything.summaries);
  assert.equal(door.take().handed.filter(item => item.type === 'decision').length, screen.limit + 1);

  base.put(first.id, 'decision', { ...first, status: 'needs_outcome', input: { ...first.input, goal: 'Changed' } });
  assert.deepEqual((await page(base)).summaries.slice(0, 2).map(row => row.goal), ['Second', 'Changed']);
  assert.deepEqual((await page(base)).summaries[0].pursuits, [{ id: 'pursuit:one', title: 'One' }]);

  await base.write([{ id: second.id, type: 'decision', value: null }]);
  assert.deepEqual((await page(base)).summaries.slice(0, 1).map(row => row.goal), ['Changed']);
});

test('every decision is reachable a page at a time through next_before, and a state filter still walks past other states', async () => {
  const door = memoryDoor();
  const at = index => new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString();
  const total = screen.limit * 2 + 5;
  for (let index = 0; index < total; index += 1) {
    const row = decision(`case:${index}`, at(index), `Goal ${index}`);
    door.put(row.id, 'decision', index === 3 || index === 4 ? row : { ...row, status: 'needs_outcome' });
  }
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
function storeOf(total) {
  const base = memoryDoor();
  const hoursAgo = hours => new Date(Date.now() - hours * 3600000).toISOString();
  const on = (n, at) => ({ ...decision(`source:m${n}`, at, `Pick the pottery lesson focus ${n}`), source_id: `message:${n}`, method_id: 'message-intake' });
  for (let n = 0; n < total; n += 1) base.put(`source:m${n}`, 'decision', on(n, hoursAgo(100 + n / 100)));
  for (let n = 0; n < 6; n += 1) base.put(`source:r${n}`, 'decision', on(`r${n}`, hoursAgo(5 - n / 10)));
  return base;
}

test('the similar decisions of a guide are the same for 300 decisions as for 1,200, when the look back is handed', async () => {
  const answers = [];
  for (const total of [300, 1200]) {
    const base = storeOf(total);
    const everything = await run(base, similarDecisions, { decision_id: 'source:r5', limit: 5 });
    const door = counting(lookBack(base, 'source:r5'));
    const answer = await run(door, similarDecisions, { decision_id: 'source:r5', limit: 5 });
    assert.deepEqual(answer, everything, `${total} decisions: the look back is the same as all of them`);
    assert.ok(answer.similar_decisions.length > 0, 'the newest decisions are still compared');
    assert.ok(door.take().crossed <= settings.similar.look_back + 1, 'only the look back and the asked decision are handed');
    answers.push(answer.similar_decisions);
  }
  assert.deepEqual(answers[1], answers[0], 'the same decisions are offered for 300 and for 1,200');
});
