// The harness the tests ported from old trillion's DecisionEngine tests share (test/cost, decision-own-reads and the rest; tag
// old-trillion-before-worker-retire, b6ae0ebf81, deleted by Trillion-X/trillion #243). Those tests drove src/engine.mjs over a SQLite
// store; here the same cases run over this tool's door tools and fixtures.mjs's in-memory door: `account` puts the made-up method
// rows and their saved view in the person's records, `answerAll` answers every row of a decision's method through the pair
// (method-rows/answers.mjs), `seedSteps` keeps answered steps on a decision in the layout an earlier decision has them (the step
// walk that wrote them is gone, the layout stays readable), and `counting` wraps a door so a test can bound what a call reads
// through it (the old tests counted SQL statements and rows of the store).
import { readFileSync } from 'node:fs';
import { methodAccount, memoryDoor, STEP_ROW, METHOD_VIEW, today } from './fixtures.mjs';
import { readDecision, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';
import { addDecisionEvidence } from '../read-data/decisions.mjs';

export const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));

/** A door holding the made-up method rows and the saved view that is the default method (or the steps given). */
export function account({ door = memoryDoor(), steps } = {}) {
  return methodAccount(door, steps ? { steps } : {});
}

/** Every row of the decision's method answered through the pair, each citing the evidence ref `ref` (added first when the decision has none of that ref). */
export async function answerAll(door, decisionId, { ref = 'e1', method = METHOD_VIEW, steps = ['scope', 'outcome', 'proof'] } = {}) {
  const answers = steps.map(step => ({ row: STEP_ROW(step), answer: `A made-up answer to ${step} in its own words`, evidence_refs: [ref] }));
  return recordMethodAnswers({ decision_id: decisionId, method, answers }, { door });
}

/** Answered steps kept on a decision in the layout earlier decisions have them (each step's own record and its summary), one write each. */
export async function seedSteps(door, id, stepIds, { ref = 'e1' } = {}) {
  for (const stepId of stepIds) {
    const record = await readDecision(door, id);
    const index = record.guidance.length;
    record.guidance.push({ step_id: stepId, answer: { evidence_refs: [ref], note: `A made-up answer to ${stepId}` }, verdicts: [], judged_checks: 0, answered_at: new Date().toISOString(), version: 1, by: 'calling-ai' });
    await writeDecision(door, recordsOf(record, [index]), `seed-step:${id}:${stepId}`);
  }
  return readDecision(door, id);
}

/** `door` with every read and every listed row counted: `reads` (ids read one by one), `listed` (rows a list handed
 * back, by type), and `take()` that returns them and starts again. */
export function counting(door) {
  let reads = [];
  let listed = [];
  const wrapped = Object.create(door);
  wrapped.read = async (type, id) => { reads.push({ type, id }); return door.read(type, id); };
  wrapped.list = async function* (query) { for await (const row of door.list(query)) { listed.push({ type: query.type, id: row.id }); yield row; } };
  wrapped.write = (...args) => door.write(...args);
  return Object.assign(wrapped, {
    get reads() { return reads; },
    get listed() { return listed; },
    crossed: () => reads.length + listed.length,
    take() { const taken = { reads, listed, crossed: reads.length + listed.length }; reads = []; listed = []; return taken; },
  });
}

/** `count` made-up pursuits written as the pursuit tools write them: one `pursuit` record each. */
export function putPursuits(door, count, shape = n => ({ title: `Goal ${n}`, now: `Before ${n}`, after: `After ${n}`, why_it_matters: 'x'.repeat(300), status: 'active' }), name = n => `pursuit:p${n}`) {
  for (let n = 0; n < count; n += 1) door.put(name(n), 'pursuit', { id: name(n), ...shape(n) });
}
