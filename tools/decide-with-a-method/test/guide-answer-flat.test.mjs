// Ported from old trillion test/guide-answer-flat.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. What answering one step of a decision costs must not grow with what the person's records
// hold. The old test grew a PersonStore's SQLite tables to N and 4N rows and counted statements and rows read; here the
// person's records are N and 4N of each kind (messages, decisions, handoffs, file arrivals, and pursuits written a few at
// a time) in this tool's in-memory door, and the cost of a step is the records it reads through the door (by id, and
// every row a list hands back: old-engine-for-tests.mjs `counting`). The step measured is the one whose answer brings
// the question that carries the person's pursuits (decisions.mjs pursuitsFor), and a later step: the made-up method has
// three steps, so "the fourth step" of the universal method is its last, proof, whose reply brings the similar earlier
// decisions. The old ceilings (600 statements, 2,500 rows) were SQL counts; the ceiling here is on records crossed: the
// similar decisions' bounded look back (decide-with-a-method.json `similar.look_back`) and a few dozen of the decision's own.
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerADecisionQuestion, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { account, counting, fill, judged, putPursuits, settings } from './old-engine-for-tests.mjs';

const LATER_CROSSED = settings.similar.look_back + 40;
const flat = (small, large) => (large.crossed > small.crossed ? [`${small.crossed} -> ${large.crossed}`] : []);

async function answerCost({ n }) {
  const base = account();
  for (const type of ['message', 'handoff', 'file-arrival']) for (let i = 0; i < n; i += 1) base.put(`${type}:${i}`, type, { text: `Made-up ${type} ${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() });
  for (let i = 0; i < n; i += 1) base.put(`source:grown-${i}`, 'decision', { id: `source:grown-${i}`, input: { goal: `Grown decision ${i}`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, status: 'needs_decision', created_at: new Date(Date.UTC(2025, 0, 1) + i * 60_000).toISOString() });
  // The person's pursuits were recorded a few at a time over months.
  putPursuits(base, n, i => ({ title: `Goal ${i}`, now: 'Before', after: 'After', why_it_matters: 'x'.repeat(300), status: 'active', recorded_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }), i => `pursuit:own-${String(i).padStart(5, '0')}`);
  const door = counting(base);
  const record = await startADecision({
    source_id: `guide-answer-flat-${n}`, goal: 'Choose how to share several files',
    evidence: [{ ref: 'request', claim: 'One link should share the selected files.' }],
    options: [{ id: 'one', label: 'One link' }, { id: 'many', label: 'Many links' }],
  }, { door });
  let question = (await nextDecisionQuestion({ decision_id: record.case_id }, { door })).question;
  let cost = null, answered = null, later = null;
  for (let step = 0; step < 12 && question?.step_id; step += 1) {
    door.take();
    const reply = await answerADecisionQuestion({ decision_id: record.case_id, step_id: question.step_id, answer: fill(question, { refs: ['request'] }), verdicts: judged(question, 'request') }, { door });
    const here = door.take();
    if (reply.pursuits?.length && !cost) { cost = here; answered = reply; }
    later = here;
    question = reply.question;
  }
  assert.ok(cost, 'a step brought the question that carries the pursuits');
  assert.ok(later, 'the decision went on to its last step');
  return { cost, answered, later };
}

test('answering a guide step costs the same statements and rows when the store holds 4 times as much', async () => {
  const small = await answerCost({ n: 200 });
  const large = await answerCost({ n: 800 });
  assert.ok(small.answered.pursuits.length > 0 && large.answered.pursuits.length > 0);
  assert.deepEqual(flat(small.cost, large.cost), [], `records grew with the store: ${JSON.stringify({ small: small.cost.crossed, large: large.cost.crossed })}`);
  // The last step is the usual one: its cost is bounded by what it reads of the decision, not by the person's records.
  assert.deepEqual(flat(small.later, large.later), [], `records grew with the store: ${JSON.stringify({ small: small.later.crossed, large: large.later.crossed })}`);
  assert.ok(large.later.crossed <= LATER_CROSSED, `a later step crossed ${large.later.crossed} records`);
});
