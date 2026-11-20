// tools/decide-with-a-method/read-data/legacy-decision.mjs
//
// PURPOSE
//   The answers of a decision made before method rows (README, "A method as rows and a saved view": those decisions keep
//   their answers). Such a root holds its answered steps whole in `guidance` (one entry per answer: step_id, answer,
//   answered_at, version?) and the method it was made with inline as `method` ({ id, name, steps: [{ id, question }] }, the
//   snapshot). Read as they were written:
//   - the snapshot's steps are method rows in the shape method-rows/view.mjs returns (id, values, strictness), and each
//     row's strictness is read by the view's own strictnessOf, so a legacy row says how it is checked the same way;
//   - an answer keeps its own text only where it has one: its `answer` text, else its `note` text. Its other fields stay on
//     the entry as written; nothing here rewrites them.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Reading writes nothing: the root is the one the caller handed in.
//   2. An answer is read only for a step the snapshot names; an answer to any other step is left out.
//   3. Only the latest entry of each step counts (the last one in `guidance`).
//   4. No words are made here: labels and the check sentences come from read-data/answer-words.json through the caller.
import { strictnessOf } from '../method-rows/view.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' && value.trim() ? value : undefined);

/** A decision root written before method rows: its answered steps are whole in `guidance`. */
export const isLegacyDecision = root => object(root) && Array.isArray(root.guidance);

/** The snapshot's steps as method rows: { id, values, strictness } in the snapshot's order, a step with no id left out. */
export function legacyMethodRows(root) {
  const steps = Array.isArray(root?.method?.steps) ? root.method.steps : [];
  return steps.filter(step => object(step) && typeof step.id === 'string').map(step => ({ id: step.id, values: step, strictness: strictnessOf(step, null) }));
}

/** The latest answer to each step the snapshot names: { row, answered_at, answer: { answer? } }, in the snapshot's order. */
export function legacyAnswers(root) {
  const rows = legacyMethodRows(root);
  const latest = new Map();
  for (const entry of root.guidance) if (object(entry) && object(entry.answer)) latest.set(entry.step_id, entry);
  return rows.flatMap(row => {
    const entry = latest.get(row.id);
    if (!entry) return [];
    return [{ row: row.id, answered_at: entry.answered_at ?? null, answer: { answer: text(entry.answer.answer) ?? text(entry.answer.note) } }];
  });
}
