// Ported from old trillion test/guide-cited-pursuits-bounded.test.mjs (tag old-trillion-before-worker-retire,
// b6ae0ebf81), deleted by Trillion-X/trillion #243. The old test counted the SQL statements and rows a guide answer read
// from the decision store, on both record engines; here the same bounds are counted at this tool's records door (every
// record read by id and every row a list hands back, old-engine-for-tests.mjs `counting`), the one store it reads. The
// answer measured is the outcome step's: its next question (proof) carries no pursuits, as the old step's did not; a
// question that carries pursuits reads a bounded page of them by design (decide-with-a-method.json `pursuits.carried`).
// The 257 references are refused before any record is read; the old test counted the store's per-id type lookups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { readDecision } from '../read-data/decision-records.mjs';
import { account, counting, fill, judged, putPursuits } from './old-engine-for-tests.mjs';

async function fixture(pursuitCount, name = 'run') {
  const base = account();
  putPursuits(base, pursuitCount, n => ({ title: `Goal ${n}`, now: `Before ${n}`, after: `After ${n}`, status: 'active' }));
  const door = counting(base);
  const record = await startADecision({
    source_id: `guide-cited-pursuits-${name}-${pursuitCount}`, goal: 'Choose how to share several files',
    evidence: [{ ref: 'request', claim: 'One link should share the selected files.' }],
    options: [{ id: 'one', label: 'One link' }, { id: 'many', label: 'Many links' }],
  }, { door });
  const { question } = await answerADecisionQuestion({ decision_id: record.case_id, step_id: 'scope', answer: fill(record.question, { refs: ['request'] }) }, { door });
  door.take();
  const send = (answer, verdicts = judged(question, 'request')) => answerADecisionQuestion({ decision_id: record.case_id, step_id: question.step_id, answer, verdicts }, { door });
  return { door, record, question, send };
}

test('a guide answer with no pursuit citations does not read every pursuit as the account grows', async () => {
  const counted = [];
  for (const count of [0, 100]) {
    const run = await fixture(count);
    const reply = await run.send(fill(run.question, { refs: ['request'] }));
    assert.equal(reply.question.step_id, 'proof');
    const { reads, listed } = run.door.take();
    counted.push({ reads: reads.length, rows: listed.length, pursuits: [...reads, ...listed].filter(item => item.type === 'pursuit').length });
  }
  assert.equal(counted[1].pursuits, 0, JSON.stringify(counted));
  assert.ok(counted[1].rows <= counted[0].rows + 10, JSON.stringify(counted));
  assert.ok(counted[1].reads <= counted[0].reads + 4, JSON.stringify(counted));
});

test('nested pursuit citations are validated and kept without accepting unrelated record IDs', async () => {
  const run = await fixture(20, 'nested');
  const answer = fill(run.question, { refs: ['request'] });
  const firstCheck = Object.keys(answer.checklist)[0];
  answer.checklist[firstCheck].evidence_refs = ['pursuit:p7'];
  await run.send(answer);
  const saved = await readDecision(run.door, run.record.case_id);
  assert.equal(saved.cited_pursuits['pursuit:p7'], 'Goal 7: now Before 7; should be After 7');

  const other = await fixture(1, 'other');
  const invalid = fill(other.question, { refs: ['request'] });
  invalid.checklist[Object.keys(invalid.checklist)[0]].evidence_refs = [run.record.case_id];
  await assert.rejects(other.send(invalid), /evidence|cite/i, 'a decision record is not a pursuit');
});

test('an overlarge distinct citation set is refused before it can fan out into record lookups', async () => {
  const run = await fixture(0, 'large');
  const answer = fill(run.question, { refs: ['request'] });
  answer.evidence_refs = Array.from({ length: 257 }, (_, n) => `ref-${n}`);
  await assert.rejects(run.send(answer), /at most 256 different references/);
  const { reads } = run.door.take();
  assert.equal(reads.filter(item => item.type === 'pursuit').length, 0, 'no reference was looked up');
});
