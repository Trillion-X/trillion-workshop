// The harness the tests ported from old trillion's DecisionEngine tests share (test/cost, decision-own-reads and the rest; tag
// old-trillion-before-worker-retire, b6ae0ebf81, deleted by Trillion-X/trillion #243). Those tests drove src/engine.mjs over a SQLite
// store; here the same cases run over this tool's door tools and fixtures.mjs's in-memory door: `account` puts the made-up method
// rows and their saved view in the person's records, `answerAll` answers every row of a decision's method through the pair
// (method-rows/answers.mjs), `seedSteps` keeps answered steps on a decision in the layout an earlier decision has them (the step
// walk that wrote them is gone, the layout stays readable), and `counting` wraps a door so a test can bound what a call reads
// through it (the old tests counted SQL statements and rows of the store).
import { readFileSync } from 'node:fs';
import { methodAccount, memoryDoor, STEP_ROW, METHOD_VIEW, today, run, heldOf } from './fixtures.mjs';
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
  return run(door, recordMethodAnswers, { decision_id: decisionId, method, answers });
}

/** Answered steps kept on a decision in the layout earlier decisions have them (each step's own record and its summary), one write each. */
export async function seedSteps(door, id, stepIds, { ref = 'e1' } = {}) {
  for (const stepId of stepIds) {
    const record = await readDecision(heldOf(door), id);
    const index = record.guidance.length;
    record.guidance.push({ step_id: stepId, answer: { evidence_refs: [ref], note: `A made-up answer to ${stepId}` }, verdicts: [], judged_checks: 0, answered_at: new Date().toISOString(), version: 1, by: 'calling-ai' });
    door.write(writeDecision(heldOf(door), recordsOf(record, [index])));
  }
  return readDecision(heldOf(door), id);
}

/** `store` with every record a call is handed counted: `all()` hands the records as the store does and notes each as
 * { type, id }; `take()` returns { handed, crossed } (the notes, and their count) and starts again. */
export function counting(store) {
  let handed = [];
  const wrapped = Object.create(store);
  // The records a call is handed are what crosses from the caller's store: every record it names by type and id.
  wrapped.all = () => { const records = store.all(); handed.push(...records.map(({ id, type }) => ({ type, id }))); return records; };
  return Object.assign(wrapped, {
    get handed() { return handed; },
    crossed: () => handed.length,
    take() { const taken = { handed, crossed: handed.length }; handed = []; return taken; },
  });
}

/** `count` made-up pursuits written as the pursuit tools write them: one `pursuit` record each. */
export function putPursuits(door, count, shape = n => ({ title: `Goal ${n}`, now: `Before ${n}`, after: `After ${n}`, why_it_matters: 'x'.repeat(300), status: 'active' }), name = n => `pursuit:p${n}`) {
  for (let n = 0; n < count; n += 1) door.put(name(n), 'pursuit', { id: name(n), ...shape(n) });
}
