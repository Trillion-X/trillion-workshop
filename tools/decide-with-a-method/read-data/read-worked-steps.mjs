// tools/decide-with-a-method/read-data/read-worked-steps.mjs
//
// PURPOSE
//   tool:read-a-decisions-worked-steps: the worked steps of one decision, as read-data/answer-words.mjs words them. A decision
//   made before method rows answers its legacy steps first, as they were written (read-data/legacy-decision.mjs); then the
//   current steps, each answer to a row of the method the decision was opened with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading writes nothing: the records the caller handed in are the only input.
//   2. A decision that does not exist is refused, never answered with no steps.
//   3. A legacy decision is read with the method its own root holds (its snapshot); a current decision with the method it was
//      opened with (methodViewOf), else the person's default. No words are made here.
import { decisionId, decisionOrRefuse, methodViewOf } from './decisions.mjs';
import { recordsIn } from './decision-records.mjs';
import { workedSteps } from './answer-words.mjs';
import { isLegacyDecision } from './legacy-decision.mjs';

/**
 * tool:read-a-decisions-worked-steps. input { decision_id, records }: the decision's records as the caller read them. Answers
 * { case_id, steps }: each step { step_id, question, rows, checks }, the legacy steps first, then the current ones.
 */
export function readWorkedSteps(input) {
  const held = recordsIn(input);
  const id = decisionId(input);
  if (isLegacyDecision(held.get('decision', id))) return { case_id: id, steps: workedSteps(held, id) };
  const record = decisionOrRefuse(held, id);
  return { case_id: id, steps: workedSteps(held, id, methodViewOf(record)) };
}
