// tools/decide-with-a-method/read-data/decide-in-one-pass.mjs
//
// PURPOSE
//   tool:decide-in-one-pass: a whole decision sent at once. It opens the decision, records its answers to every row of the
//   method, and makes the decision, as the three tools do when sent one at a time. Ported from the old engine (old codebase
//   commit b6ae0ebf815f, src/engine.mjs decideInOnePass), whose one call did the same over its questions. Each step is the
//   owner's own function, run in order over the records the caller hands in, so every check stays in those tools.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Each step is the tool it names (startADecision, recordMethodAnswers, makeTheDecision): nothing is checked here that
//      those tools do not check, and nothing is skipped.
//   2. The steps run over the records in memory. A step that refuses ends the call with nothing kept: the caller writes
//      keep only when the whole call answers.
//   3. The answers and the decision come from the caller's input; nothing here invents an answer.
import { makeTheDecision, startADecision } from './decisions.mjs';
import { recordMethodAnswers } from '../method-rows/answers.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The records as the steps keep them: a kept record replaces the one it names, and a null value removes it.
function applied(records, keep) {
  const kept = keep.map(({ id, type }) => `${type}\u0000${id}`);
  const rest = records.filter(record => !kept.includes(`${record.type}\u0000${record.id}`));
  return [...rest, ...keep.filter(item => item.value !== null).map(({ id, type, value }) => ({ id, type, value }))];
}

// What the call keeps: every record it changed, each with the value it was handed in with (`expected`) so the caller refuses a whole list that moved.
function changedBy(before, after) {
  const key = record => `${record.type}\u0000${record.id}`;
  const was = new Map(before.map(record => [key(record), record]));
  const now = new Map(after.map(record => [key(record), record]));
  const keep = [];
  for (const [k, record] of now) if (!was.has(k) || !same(was.get(k).value, record.value)) keep.push({ id: record.id, type: record.type, value: record.value, expected: was.get(k)?.value ?? null });
  for (const [k, record] of was) if (!now.has(k)) keep.push({ id: record.id, type: record.type, value: null, expected: record.value });
  return keep;
}

/**
 * tool:decide-in-one-pass. input { source_id, goal, evidence, options, method?, answers: [{ row, answer, evidence_refs?, cites? }],
 * decision: { option_id, reason, evidence_refs, next_action, success_measure, move }, by?, records }. The start is the same
 * input as tool:start-a-decision; `answers` is what tool:record-method-answers takes; `decision` is what tool:make-the-decision takes.
 * Answers { case_id, method, decision, keep }: `keep` is every record the call changed, for the caller to write in one transaction.
 */
export function decideInOnePass(input) {
  if (!object(input) || !Array.isArray(input.answers) || !object(input.decision)) throw new Error('A one-pass decision needs its answers (one for each row of the method) and its decision.');
  const { answers, decision, by, records: handed = [], ...opened } = input;
  const original = handed;
  let store = handed;
  const started = startADecision({ ...opened, records: store });
  store = applied(store, started.keep ?? []);
  const answered = recordMethodAnswers({ decision_id: started.case_id, method: started.method, answers, by, records: store });
  store = applied(store, answered.keep ?? []);
  const made = makeTheDecision({ decision_id: started.case_id, decision, records: store });
  store = applied(store, made.keep ?? []);
  return { case_id: started.case_id, method: started.method, decision: made.decision, keep: changedBy(original, store) };
}
