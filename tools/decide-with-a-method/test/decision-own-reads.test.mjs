// Ported from old trillion test/decision-own-reads.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. engine.related is tool:bring-back-similar-decisions (read-data/
// similar-decisions.mjs) and engine.ownOf is laidTogether with no lists (read-data/decision-records.mjs), both over the
// records door. The old test counted SQL statements naming a `decision-step:` or `decision-call:` key; here every record
// read and every row listed at the door is counted (old-engine-for-tests.mjs `counting`). The long decisions are opened
// with tool:start-a-decision and given 30 logged tries each as this layout keeps a call (`decision-call:<id>:<nnnnnn>`,
// decide-with-a-method.json `records.call`) and an answered step, which no own-field read may open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { laidTogether } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { account, counting, fill } from './old-engine-for-tests.mjs';

test('similar decisions and a decision\'s own fields never read its answers or tries', async () => {
  const base = account();
  const ids = [];
  for (let i = 0; i < 8; i += 1) {
    const { case_id: id, question } = await startADecision({
      source_id: `long-${i}`, goal: `Decide how the bakery prices its sourdough loaves in season ${i}`,
      evidence: [{ ref: 'e', claim: 'The bakery sells out by noon.' }],
      options: [{ id: 'a', label: 'Raise the price' }, { id: 'b', label: 'Bake more' }],
    }, { door: base });
    await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(question, { refs: ['e'] }) }, { door: base });
    // A long decision: many tries, each keeping what it sent.
    for (let n = 0; n < 30; n += 1) base.put(`decision-call:${id}:${String(n).padStart(6, '0')}`, 'decision-call', { route: 'guide', step_id: 'outcome', accepted: false, reason: 'refused', at: new Date().toISOString(), bytes: 4000, submission: { answer: 'x'.repeat(4000) } });
    base.put(id, 'decision', { ...base.value(id), call_count: 30 });
    ids.push(id);
  }
  const door = counting(base);
  const { similar_decisions: similar } = await similarDecisions({ decision_id: ids[0], limit: 5 }, { door });
  assert.equal(similar.length, 5);
  assert.ok(similar.every(item => item.goal.includes('sourdough') && Array.isArray(item.observed)));
  const { record: own } = await laidTogether(door, ids[1], await door.read('decision', ids[1]), []);
  assert.equal(own.input.goal, 'Decide how the bakery prices its sourdough loaves in season 1');
  assert.equal(own.calls, undefined, 'its tries are not read');
  const { reads, listed } = door.take();
  const parts = [...reads, ...listed].filter(item => /^decision-(step|call):/.test(item.id) || ['decision-step', 'decision-call'].includes(item.type));
  assert.equal(parts.length, 0, `read a decision's answers or tries ${parts.length} times`);
});
